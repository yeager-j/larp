import { randomUUID } from "node:crypto";

import type { Participant } from "./config.js";
import { TurnInterrupted } from "./harness/spawn.js";
import type { Harness, HarnessEvent, TurnResult } from "./harness/types.js";
import { envelope, RECIPIENT, ROLES, type Entry, type Role } from "./message.js";
import type { RunStore } from "./run-store.js";
import {
  activeRoles,
  initial,
  nextTurn,
  reduce,
  schemaFor,
  validReply,
  type Phase,
  type PlanState,
} from "./workflow/plan.js";
import { ROLE_PROMPTS } from "./workflow/prompts.js";

/** Human interaction boundary. The signal cancels a pending interjection read after a Turn. */
export interface RelayUI {
  phaseGate(
    state: PlanState,
    planPath?: string
  ): Promise<{ kind: "approve" } | { kind: "feedback"; body: string } | { kind: "abort" }>;
  failureGate(state: PlanState): Promise<{ kind: "retry"; body: string } | { kind: "abort" }>;
  interjections(signal?: AbortSignal): AsyncIterable<{ role: Role; body: string }>;
  log(line: string): void;
  startTurn?(role: Role, model: string): void;
  message?(entry: Entry): void;
  failure?(role: Role, body: string): void;
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
}): Promise<Phase> {
  const release = opts.run.acquire();
  try {
    return await relayLoop(opts);
  } finally {
    release();
  }
}
async function relayLoop(opts: Parameters<typeof runRelay>[0]): Promise<Phase> {
  const { run, harnesses, participants, ui } = opts;
  const latestPlan = run
    .entries()
    .findLast((item) => item.from === "planner" && item.kind === "request" && item.plan);
  if (latestPlan?.plan) run.writePlan(latestPlan.plan);
  let displayedMessageId: string | undefined;
  while (true) {
    const entries = run.entries();
    const state = entries.reduce(reduce, initial());
    if (state.phase === "done" || state.phase === "aborted") return state.phase;
    const role = nextTurn(state);
    if (!role) {
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
      } else {
        const last = entries.findLast(
          (item) => item.kind === "question" || item.from === "reviewer"
        );
        if (last && last.id !== displayedMessageId) {
          if (ui.message) ui.message(last);
          else ui.log(`${last.from}: ${last.body}`);
          displayedMessageId = last.id;
        }
        const action = await ui.phaseGate(state, state.lastPlanEntryId ? run.planPath : undefined);
        if (action.kind === "approve" && !state.lastPlanEntryId) {
          ui.log("A plan is required before approval. Message the Planner or abort.");
          continue;
        }
        run.append(
          entry({
            from: "human",
            to: action.kind === "feedback" ? "planner" : "run",
            kind: action.kind,
            body: action.kind === "feedback" ? action.body : "",
          })
        );
      }
      continue;
    }
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
      schemaReminder: `${JSON.stringify(schema)}. Current phase: ${state.phase}. ${state.phase === "implementing" && role === "planner" ? "Answer with feedback or question." : ""}`,
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
        permission: role === "implementer" ? "write" : "read-only",
        rolePrompt: ROLE_PROMPTS[role],
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
      continue;
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
      run.append(
        entry({ from: "relay", to: "run", kind: "failure", role, reason: "schema", body })
      );
      if (!state.failure)
        run.append(entry({ from: "relay", to: "run", kind: "retry", role, body }));
      if (ui.failure) ui.failure(role, body);
      else ui.log(`Failure (${role}): ${body}`);
      continue;
    }
    if (reply.plan) run.writePlan(reply.plan);
    run.append(reply);
    run.setSession(role, result.sessionId);
    run.markDelivered(waiting.map((item) => item.id));
    if (ui.message) ui.message(reply);
    else ui.log(`${role} → ${reply.to} (${reply.kind}): ${reply.body}`);
    displayedMessageId = reply.id;
  }
}
