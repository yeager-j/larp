import { RECIPIENT, type Entry, type FailureEntry, type Role } from "../message.js";

/** Durable workflow phases. */
export type Phase = "planning" | "gate" | "handoff" | "failure" | "done" | "handed-off" | "aborted";
/** State obtained solely by folding the log. */
export interface PlanState {
  /** Current workflow phase. */
  phase: Phase;
  /** Completed review rounds. */
  round: number;
  /** Role scheduled for the next Turn, if any. */
  pending: Role | null;
  /** Failure awaiting automatic retry or a Human decision. */
  failure?: { role: Role; attempts: number; reason: FailureEntry["reason"]; body: string };
  /** Entry containing the latest saved plan. */
  lastPlanEntryId?: string;
  /** Why the Human gate opened; questions cannot approve an earlier plan. */
  gateReason?: "question" | "review";
  /** Human messages still waiting for their addressed Role to answer. */
  unread?: { id: string; role: Role }[];
}
/** Maximum review rounds before human approval. */
export const ROUND_CAP = 5;
/** Review limit of legacy Runs, which saved no limit. */
const LEGACY_ROUND_CAP = 3;
/** Harness-compatible strict reply schema. Planner plan is null for non-request replies. */
export function schemaFor(role: Role): object {
  const properties: Record<string, object> = {
    kind: { type: "string", enum: Object.keys(RECIPIENT[role]) },
    body: { type: "string" },
  };
  const required = ["kind", "body"];
  if (role === "planner") {
    properties.plan = { type: ["string", "null"] };
    required.push("plan");
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}
/** Validate the complete reply, including the nonempty request plan. */
export function validReply(
  role: Role,
  output: unknown
): output is { kind: Entry["kind"]; body: string; plan?: string | null } {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const reply = output as Record<string, unknown>;
  const keys = role === "planner" ? ["kind", "body", "plan"] : ["kind", "body"];
  return (
    Object.keys(reply).every((key) => keys.includes(key)) &&
    keys.every((key) => key in reply) &&
    typeof reply.kind === "string" &&
    Object.hasOwn(RECIPIENT[role], reply.kind) &&
    typeof reply.body === "string" &&
    (role !== "planner" || reply.plan === null || typeof reply.plan === "string") &&
    (reply.kind !== "request" ||
      (typeof reply.plan === "string" && reply.plan.trim().length > 0)) &&
    (reply.kind === "request" || reply.plan == null)
  );
}
/** Start with a Planner Turn. */
export function initial(): PlanState {
  return { phase: "planning", round: 0, pending: "planner" };
}
/** Fold one entry; unrelated or invalid actions leave state unchanged. */
export function reduce(state: PlanState, entry: Entry): PlanState {
  return reduceWithCap(state, entry, ROUND_CAP);
}
/**
 * Fold a whole Run log into its current state.
 *
 * @param savedRoundCap The Run's saved review limit; absent on legacy Runs, which keep their
 *   original limit.
 */
export function replay(entries: Entry[], savedRoundCap: number | undefined): PlanState {
  const roundCap = savedRoundCap ?? LEGACY_ROUND_CAP;

  return entries.reduce((state, entry) => reduceWithCap(state, entry, roundCap), initial());
}
/** Replay older Runs using their original review limit. */
export function reduceWithCap(state: PlanState, entry: Entry, roundCap: number): PlanState {
  if (state.phase === "done" || state.phase === "handed-off" || state.phase === "aborted")
    return state;
  if (entry.from === "human" && entry.to === "run" && entry.kind === "abort")
    return { ...state, phase: "aborted", pending: null };
  if (
    entry.from === "relay" &&
    entry.kind === "failure" &&
    entry.role === state.pending &&
    state.phase === "planning"
  ) {
    return {
      ...state,
      phase: "failure",
      failure: {
        role: entry.role,
        attempts: (state.failure?.attempts ?? 0) + 1,
        reason: entry.reason,
        body: entry.body,
      },
    };
  }
  if (entry.from === "human" && entry.kind === "feedback" && state.phase === "planning")
    return { ...state, unread: [...(state.unread ?? []), { id: entry.id, role: entry.to }] };
  if (state.phase === "failure") {
    if (
      entry.kind === "retry" &&
      entry.to === "run" &&
      (entry.from === "human" || entry.from === "relay") &&
      entry.role === state.failure?.role
    ) {
      const next = { ...state, phase: "planning" as const, pending: entry.role };
      if (entry.from === "human") delete next.failure;
      return next;
    }
    return state;
  }
  if (state.phase === "gate") {
    if (
      entry.from === "human" &&
      entry.kind === "approve" &&
      entry.to === "run" &&
      canApprovePlan(state)
    )
      return { ...state, phase: "handoff", pending: null };
    if (entry.from === "human" && entry.kind === "feedback" && entry.to === "planner")
      return { ...state, phase: "planning", round: 0, pending: "planner" };
    return state;
  }
  if (state.phase === "handoff") {
    if (entry.from === "relay" && entry.kind === "handoff" && entry.to === "human")
      return { ...state, phase: "handed-off", pending: null };
    // Completed Runs from the earlier implementation workflow remain terminal.
    if (entry.from === "implementer" && entry.kind === "done")
      return { ...state, phase: "done", pending: null };
    return state;
  }
  if (entry.from !== state.pending || RECIPIENT[entry.from as Role]?.[entry.kind] !== entry.to)
    return state;
  const next = { ...state };
  delete next.failure;
  if ("completion" in entry && next.unread)
    next.unread = next.unread.filter(
      (message) => message.role !== entry.from || !entry.completion.delivered.includes(message.id)
    );
  if (entry.from === "planner" && entry.kind === "question")
    return { ...next, phase: "gate", pending: null, gateReason: "question" };
  if (state.phase === "planning") {
    if (entry.from === "planner" && entry.kind === "request")
      return { ...next, pending: "reviewer", lastPlanEntryId: entry.id };
    if (entry.from === "reviewer" && (entry.kind === "feedback" || entry.kind === "approve")) {
      const round = state.round + 1;
      const unreadRole =
        next.unread?.find((message) => message.role === "planner")?.role ?? next.unread?.[0]?.role;
      const gate = !unreadRole && (entry.kind === "approve" || round >= roundCap);
      return {
        ...next,
        gateReason: "review",
        round,
        phase: gate ? "gate" : "planning",
        pending: gate ? null : (unreadRole ?? "planner"),
      };
    }
  }
  return state;
}
/** Whether the Human can approve a saved plan at the review gate. */
export function canApprovePlan(state: PlanState): boolean {
  return state.phase === "gate" && state.gateReason === "review" && Boolean(state.lastPlanEntryId);
}

/** Roles accepting interjections in the current phase. */
export function activeRoles(state: PlanState): Role[] {
  if (state.phase === "planning") return ["planner", "reviewer"];
  return [];
}
/** Return the next runnable Role, or null at gates and terminal states. */
export function nextTurn(state: PlanState): Role | null {
  return state.phase === "planning" ? state.pending : null;
}
