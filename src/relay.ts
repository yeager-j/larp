import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Participant } from "./config.js";
import { renderHandoff, type Handoff } from "./handoff.js";
import { TurnInterrupted } from "./harness/spawn.js";
import type { Harness, HarnessEvent, TurnResult } from "./harness/types.js";
import { envelope, RECIPIENT, ROLES, type Entry, type Role } from "./message.js";
import type { RunStore } from "./run-store.js";
import {
  activeRoles,
  initial,
  nextTurn,
  reduce,
  reduceWithCap,
  schemaFor,
  validReply,
  type Phase,
  type PlanState,
} from "./workflow/plan.js";
import { ROLE_PROMPTS } from "./workflow/prompts.js";

/** Human interaction boundary. The signal cancels a pending interjection read after a Turn. */
export interface RelayUI {
  /** Request a Human decision at a workflow gate. */
  phaseGate(
    state: PlanState,
    planPath?: string
  ): Promise<{ kind: "approve" } | { kind: "feedback"; body: string } | { kind: "abort" }>;
  /** Request a Human retry or abort after a Turn failure. */
  failureGate(state: PlanState): Promise<{ kind: "retry"; body: string } | { kind: "abort" }>;
  /** Stream Human messages while a Turn runs, until the signal aborts. */
  interjections(signal?: AbortSignal): AsyncIterable<{ role: Role; body: string }>;
  /** Write a status line when no specific callback handles it. */
  log(line: string): void;
  /** Announce the start of a Turn. */
  startTurn?(role: Role, model: string): void;
  /** Display a committed message. */
  message?(entry: Entry): void;
  /** Display a Turn failure. */
  failure?(role: Role, body: string): void;
  /** Display harness progress during a Turn. */
  event?(role: Role, model: string, event: HarnessEvent): void;
}
function entry(fields: Omit<Entry, "id" | "at">): Entry {
  return { id: randomUUID(), at: new Date().toISOString(), ...fields };
}
function waitingEntries(entries: Entry[], delivered: string[], role: Role): Entry[] {
  const seen = new Set(delivered);
  return entries.filter(
    (item) =>
      !seen.has(item.id) &&
      (item.to === role ||
        (item.to === "run" &&
          item.role === role &&
          (item.kind === "retry" || item.kind === "failure")))
  );
}
async function receiveInterjections(
  ui: RelayUI,
  run: RunStore,
  state: PlanState,
  signal: AbortSignal
): Promise<void> {
  for await (const message of ui.interjections(signal)) {
    if (signal.aborted) break;
    if (!activeRoles(state).includes(message.role)) {
      ui.log(`Cannot address ${message.role} during ${state.phase}.`);
      continue;
    }
    if (!message.body.trim()) continue;
    run.append(entry({ from: "human", to: message.role, kind: "feedback", body: message.body }));
    ui.log(`Human → ${message.role}: ${message.body}`);
  }
}
/** Run one workflow to completion or abort, replaying committed entries on resume. */
export async function runRelay(opts: {
  run: RunStore;
  harnesses: Record<"claude" | "codex", Harness>;
  participants: Record<Role, Participant>;
  ui: RelayUI;
  handoff(input: Handoff): Promise<void>;
}): Promise<Phase> {
  const release = opts.run.acquire();
  try {
    return await relayLoop(opts);
  } finally {
    release();
  }
}
async function relayLoop(opts: Parameters<typeof runRelay>[0]): Promise<Phase> {
  const { run, ui } = opts;
  restoreLatestPlan(run);
  let displayedMessageId: string | undefined;
  while (true) {
    const entries = run.entries();
    const state = entries.reduce(
      (state, item) => reduceWithCap(state, item, run.data.reviewRoundCap ?? 3),
      initial()
    );
    if (state.phase === "done" || state.phase === "handed-off" || state.phase === "aborted")
      return state.phase;
    if (state.phase === "handoff") {
      await completeHandoff(opts, entries);
      continue;
    }
    const role = nextTurn(state);
    if (!role) {
      displayedMessageId = await handleGate(run, ui, state, entries, displayedMessageId);
      continue;
    }
    const replyId = await runParticipantTurn(opts, state, role, entries);
    if (replyId) displayedMessageId = replyId;
  }
}
function restoreLatestPlan(run: RunStore): void {
  const latestPlan = run
    .entries()
    .findLast(
      (item) =>
        item.plan &&
        ((item.from === "planner" && item.kind === "request") ||
          (item.from === "human" && item.kind === "approve"))
    );
  if (latestPlan?.plan) run.writePlan(latestPlan.plan);
}
async function completeHandoff(
  opts: Parameters<typeof runRelay>[0],
  entries: Entry[]
): Promise<void> {
  const { run, ui } = opts;
  const approved = entries.findLast((item) => item.from === "human" && item.kind === "approve");
  const plan = approved?.plan ?? readFileSync(run.planPath, "utf8");
  try {
    run.writeHandoff(renderHandoff({ cwd: run.data.cwd, task: run.data.task, plan, entries }));
    await opts.handoff({ cwd: run.data.cwd, handoffPath: run.handoffPath });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Plan remains approved. Retry with larp plan resume ${run.data.id}.`
    );
  }
  const sent = entry({
    from: "relay",
    to: "human",
    kind: "handoff",
    body: `Opened the approved plan in Codex desktop. Press Send there to start implementation.\nHandoff: ${run.handoffPath}\nlarp does not track implementation progress.`,
  });
  run.append(sent);
  if (ui.message) ui.message(sent);
  else ui.log(sent.body);
}
async function handleGate(
  run: RunStore,
  ui: RelayUI,
  state: PlanState,
  entries: Entry[],
  displayedMessageId?: string
): Promise<string | undefined> {
  if (state.phase === "failure") {
    const action = await ui.failureGate(state);
    run.append(
      entry({
        from: "human",
        to: "run",
        kind: action.kind,
        body: action.kind === "retry" ? action.body : "",
        ...(state.failure ? { role: state.failure.role } : {}),
      })
    );
    return displayedMessageId;
  }
  const last = entries.findLast((item) => item.kind === "question" || item.from === "reviewer");
  if (last && last.id !== displayedMessageId) {
    if (ui.message) ui.message(last);
    else ui.log(`${last.from}: ${last.body}`);
    displayedMessageId = last.id;
  }
  const action = await ui.phaseGate(state, state.lastPlanEntryId ? run.planPath : undefined);
  if (action.kind === "approve" && !state.lastPlanEntryId) {
    ui.log("A plan is required before approval. Message the Planner or abort.");
    return displayedMessageId;
  }
  const approvedPlan = action.kind === "approve" ? readFileSync(run.planPath, "utf8") : undefined;
  if (approvedPlan !== undefined && !approvedPlan.trim())
    throw new Error("The plan is empty. Restore it before approving.");
  run.append(
    entry({
      from: "human",
      to: action.kind === "feedback" ? "planner" : "run",
      kind: action.kind,
      body: action.kind === "feedback" ? action.body : "",
      ...(approvedPlan !== undefined ? { plan: approvedPlan } : {}),
    })
  );
  return displayedMessageId;
}
async function runParticipantTurn(
  opts: Parameters<typeof runRelay>[0],
  state: PlanState,
  role: Role,
  entries: Entry[]
): Promise<string | undefined> {
  const { run, harnesses, participants, ui } = opts;
  const participant = participants[role];
  const sessionId = run.data.sessions[role];
  const waiting = waitingEntries(entries, run.data.delivered, role);
  const schema = schemaFor(role);
  const prompt = envelope({
    role,
    model: participant.model,
    task: run.data.task,
    firstForRole: !sessionId,
    ...(state.lastPlanEntryId ? { planPath: run.planPath } : {}),
    entries: waiting,
    models: Object.fromEntries(ROLES.map((role) => [role, participants[role].model])),
    schemaReminder: `${JSON.stringify(schema)}. Current phase: ${state.phase}. `,
  });
  ui.startTurn?.(role, participant.model);
  const controller = new AbortController();
  let inputError: unknown;
  const interjections = receiveInterjections(ui, run, state, controller.signal).catch((error) => {
    inputError = error;
  });
  let result: TurnResult;
  try {
    result = await harnesses[participant.harness].runTurn({
      ...participant,
      cwd: run.data.cwd,
      permission: "read-only",
      rolePrompt: participant.instructions
        ? `${ROLE_PROMPTS[role]}\n\n${participant.instructions}`
        : ROLE_PROMPTS[role],
      prompt,
      first: !sessionId,
      schema,
      ...(sessionId ? { sessionId } : {}),
      turnDir: run.nextTurnDir(),
      onEvent: (event) => ui.event?.(role, participant.model, event),
    });
  } catch (error) {
    if (error instanceof TurnInterrupted) throw error;
    result = { sessionId: sessionId ?? "", exitCode: 1, error: String(error) };
  } finally {
    controller.abort();
    await interjections;
  }
  if (inputError) throw inputError;
  if (result.error || result.exitCode !== 0 || !result.sessionId) {
    const body =
      result.error ??
      (result.exitCode !== 0
        ? `Harness exited with code ${result.exitCode}.`
        : "Harness returned no session ID.");
    run.append(
      entry({
        from: "relay",
        to: "run",
        kind: "failure",
        role,
        reason: result.exitCode !== 0 ? "exit" : "error",
        body,
      })
    );
    if (ui.failure) ui.failure(role, body);
    else ui.log(`Failure (${role}): ${body}`);
    return;
  }
  const output = result.output;
  const reply = validReply(role, output)
    ? entry({
        from: role,
        to: RECIPIENT[role][output.kind]!,
        kind: output.kind,
        body: output.body,
        ...(typeof output.plan === "string" ? { plan: output.plan } : {}),
        completion: { sessionId: result.sessionId, delivered: waiting.map((item) => item.id) },
      })
    : undefined;
  if (!reply || reduce(state, reply) === state) {
    const body = `Reply failed the ${role} schema or is invalid during ${state.phase}. Return exactly the requested JSON schema and a nonempty plan for request.`;
    run.append(entry({ from: "relay", to: "run", kind: "failure", role, reason: "schema", body }));
    if (!state.failure) run.append(entry({ from: "relay", to: "run", kind: "retry", role, body }));
    if (ui.failure) ui.failure(role, body);
    else ui.log(`Failure (${role}): ${body}`);
    return;
  }
  if (reply.plan) run.writePlan(reply.plan);
  run.append(reply);
  run.setSession(role, result.sessionId);
  run.markDelivered(waiting.map((item) => item.id));
  if (ui.message) ui.message(reply);
  else ui.log(`${role} → ${reply.to} (${reply.kind}): ${reply.body}`);
  return reply.id;
}
