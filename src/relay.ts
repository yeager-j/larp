import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Participant } from "./config.js";
import { renderHandoff, type Handoff } from "./handoff.js";
import type { TurnOutcome } from "./harness/turn.js";
import type { Harness, HarnessEvent } from "./harness/types.js";
import { drive } from "./kernel/drive.js";
import type { Step, TurnSpec, Workflow } from "./kernel/types.js";
import {
  envelope,
  isReply,
  RECIPIENT,
  ROLES,
  type Entry,
  type ReplyEntry,
  type Role,
} from "./message.js";
import type { RunStore } from "./run-store.js";
import type { Unsaved } from "./store.js";
import {
  activeRoles,
  nextTurn,
  reduce,
  replay,
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
/** A plan Turn carries the state it started from, which decides whether its reply is valid. */
type PlanTurn = TurnSpec<Role, { state: PlanState }>;
/** A plan action: a Human Gate, or the desktop handoff after approval. */
type PlanAction = "gate" | "handoff";

function entry(fields: Unsaved<Entry>): Entry {
  return { id: randomUUID(), at: new Date().toISOString(), ...fields };
}

/** Run one workflow to completion or abort, replaying committed entries on resume. */
export async function runRelay(opts: {
  run: RunStore;
  harnesses: Record<"claude" | "codex", Harness>;
  participants: Record<Role, Participant>;
  ui: RelayUI;
  handoff(input: Handoff): Promise<void>;
}): Promise<Phase> {
  const { ui } = opts;
  const result = await drive(opts.run, planWorkflow(opts), {
    harnesses: opts.harnesses,
    startTurn: (turn) => ui.startTurn?.(turn.key, turn.participant.model),
    event: (turn, event) => ui.event?.(turn.key, turn.participant.model, event),
  });

  if (result.status === "held") throw new Error(`Run already active in process ${result.heldBy}.`);

  return result.outcome;
}

function planWorkflow(
  opts: Parameters<typeof runRelay>[0]
): Workflow<Entry, Role, { state: PlanState }, PlanAction, Phase> {
  const { run, ui } = opts;
  // The last reply or question shown, so a Gate does not show it twice.
  let displayedMessageId: string | undefined;

  return {
    begin: (entries) => restoreLatestPlan(run, entries),
    next: (entries) => planStep(opts, entries),
    commit(turn, outcome) {
      const replyId = commitTurn(run, ui, turn, outcome);
      if (replyId) displayedMessageId = replyId;
    },
    async act(action, entries) {
      if (action === "handoff") return completeHandoff(opts, entries);

      displayedMessageId = await handleGate(run, ui, entries, displayedMessageId);
    },
    alongsideTurns: (signal) => receiveInterjections(ui, run, signal),
  };
}

function planStep(
  opts: Parameters<typeof runRelay>[0],
  entries: Entry[]
): Step<Role, { state: PlanState }, PlanAction, Phase> {
  const state = replay(entries, opts.run.data.reviewRoundCap);

  if (state.phase === "done" || state.phase === "handed-off" || state.phase === "aborted")
    return { kind: "done", outcome: state.phase };
  if (state.phase === "handoff") return { kind: "act", action: "handoff" };

  const role = nextTurn(state);
  if (!role) return { kind: "act", action: "gate" };

  return { kind: "turns", turns: [planTurn(opts, entries, state, role)] };
}

function planTurn(
  { run, participants }: Parameters<typeof runRelay>[0],
  entries: Entry[],
  state: PlanState,
  role: Role
): PlanTurn {
  const participant = participants[role];
  const sessionId = sessionFor(entries, role);
  const waiting = waitingEntries(entries, role);
  const schema = schemaFor(role);

  return {
    key: role,
    participant,
    cwd: run.data.cwd,
    permission: "read-only",
    rolePrompt: participant.instructions
      ? `${ROLE_PROMPTS[role]}\n\n${participant.instructions}`
      : ROLE_PROMPTS[role],
    prompt: envelope({
      role,
      model: participant.model,
      task: run.data.task,
      firstForRole: !sessionId,
      ...(state.lastPlanEntryId ? { planPath: run.planPath } : {}),
      entries: waiting,
      models: Object.fromEntries(ROLES.map((role) => [role, participants[role].model])),
      schemaReminder: `${JSON.stringify(schema)}. Current phase: ${state.phase}. `,
    }),
    schema,
    ...(sessionId ? { sessionId } : {}),
    delivered: waiting.map((item) => item.id),
    detail: { state },
  };
}

/** Entries addressed to the Role that no committed reply has answered yet. */
function waitingEntries(entries: Entry[], role: Role): Entry[] {
  const seen = new Set(entries.filter(isReply).flatMap((reply) => reply.completion.delivered));

  return entries.filter(
    (item) =>
      !seen.has(item.id) &&
      (item.to === role ||
        ((item.kind === "retry" || item.kind === "failure") && item.role === role))
  );
}

/** Harness session from the Role's latest committed reply. */
function sessionFor(entries: Entry[], role: Role): string | undefined {
  return entries.filter(isReply).findLast((reply) => reply.from === role)?.completion.sessionId;
}

/** Save Human messages typed during a Turn; they reach their Role in its next Envelope. */
async function receiveInterjections(
  ui: RelayUI,
  run: RunStore,
  signal: AbortSignal
): Promise<void> {
  for await (const message of ui.interjections(signal)) {
    if (signal.aborted) break;

    const state = replay(run.entries(), run.data.reviewRoundCap);

    if (!activeRoles(state).includes(message.role)) {
      ui.log(`Cannot address ${message.role} during ${state.phase}.`);
      continue;
    }
    if (!message.body.trim()) continue;

    run.append(entry({ from: "human", to: message.role, kind: "feedback", body: message.body }));
    ui.log(`Human → ${message.role}: ${message.body}`);
  }
}

function restoreLatestPlan(run: RunStore, entries: Entry[]): void {
  const latestPlan = entries.map(planSnapshot).findLast((plan) => plan);

  if (latestPlan) run.writePlan(latestPlan);
}

/** The plan text that a Planner request or a Human approval saved. */
function planSnapshot(item: Entry): string | undefined {
  if (item.kind === "request" || (item.kind === "approve" && item.from === "human"))
    return item.plan;

  return undefined;
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

/** Ask the Human at a Phase or Failure Gate; returns the ID of the last message shown. */
async function handleGate(
  run: RunStore,
  ui: RelayUI,
  entries: Entry[],
  displayedMessageId?: string
): Promise<string | undefined> {
  const state = replay(entries, run.data.reviewRoundCap);

  if (state.phase === "failure") {
    const action = await ui.failureGate(state);

    run.append(
      action.kind === "retry"
        ? entry({
            from: "human",
            to: "run",
            kind: "retry",
            role: state.failure!.role,
            body: action.body,
          })
        : entry({ from: "human", to: "run", kind: "abort", body: "" })
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

  if (action.kind === "feedback")
    run.append(entry({ from: "human", to: "planner", kind: "feedback", body: action.body }));
  else if (action.kind === "abort")
    run.append(entry({ from: "human", to: "run", kind: "abort", body: "" }));
  else if (!state.lastPlanEntryId)
    ui.log("A plan is required before approval. Message the Planner or abort.");
  else
    run.append(
      entry({ from: "human", to: "run", kind: "approve", body: "", plan: approvedPlan(run) })
    );

  return displayedMessageId;
}

/** Read the plan as the Human left it at the Gate, including edits. */
function approvedPlan(run: RunStore): string {
  const plan = readFileSync(run.planPath, "utf8");
  if (!plan.trim()) throw new Error("The plan is empty. Restore it before approving.");

  return plan;
}

/**
 * Append a finished Turn's reply, or its failure and at most one Relay retry.
 *
 * @returns The committed reply's ID, or undefined when the Turn failed.
 */
function commitTurn(
  run: RunStore,
  ui: RelayUI,
  turn: PlanTurn,
  outcome: TurnOutcome
): string | undefined {
  const { key: role } = turn;
  const { state } = turn.detail;

  if (!outcome.ok) {
    run.append(
      entry({
        from: "relay",
        to: "run",
        kind: "failure",
        role,
        reason: outcome.reason,
        body: outcome.error,
      })
    );
    showFailure(ui, role, outcome.error);
    return;
  }

  const { output } = outcome;
  // RECIPIENT pairs each Role's reply Kind with its recipient, as the ReplyEntry variants do.
  const reply = validReply(role, output)
    ? (entry({
        from: role,
        to: RECIPIENT[role][output.kind]!,
        kind: output.kind,
        body: output.body,
        ...(typeof output.plan === "string" ? { plan: output.plan } : {}),
        completion: { sessionId: outcome.sessionId, delivered: turn.delivered },
      } as Unsaved<ReplyEntry>) as ReplyEntry)
    : undefined;

  if (!reply || reduce(state, reply) === state) {
    const body = `Reply failed the ${role} schema or is invalid during ${state.phase}. Return exactly the requested JSON schema and a nonempty plan for request.`;

    run.append(entry({ from: "relay", to: "run", kind: "failure", role, reason: "schema", body }));
    if (!state.failure) run.append(entry({ from: "relay", to: "run", kind: "retry", role, body }));
    showFailure(ui, role, body);
    return;
  }

  if (reply.kind === "request") run.writePlan(reply.plan);
  run.append(reply);

  if (ui.message) ui.message(reply);
  else ui.log(`${role} → ${reply.to} (${reply.kind}): ${reply.body}`);

  return reply.id;
}

function showFailure(ui: RelayUI, role: Role, body: string): void {
  if (ui.failure) ui.failure(role, body);
  else ui.log(`Failure (${role}): ${body}`);
}
