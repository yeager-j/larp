import { RECIPIENT, type Entry, type Role } from "../message.js";

/** Durable workflow phases. */
export type Phase = "planning" | "gate" | "handoff" | "failure" | "done" | "handed-off" | "aborted";
/** State obtained solely by folding the log. */
export interface PlanState {
  phase: Phase;
  round: number;
  pending: Role | null;
  failure?: { role: Role; attempts: number; reason: Entry["reason"]; body: string };
  lastPlanEntryId?: string;
}
/** Maximum review rounds before human approval. */
export const ROUND_CAP = 5;
/** Harness-compatible strict reply schema. Planner plan is null for non-request replies. */
export function schemaFor(role: Role): object {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: Object.keys(RECIPIENT[role]) },
      body: { type: "string" },
      ...(role === "planner" ? { plan: { type: ["string", "null"] } } : {}),
    },
    required: role === "planner" ? ["kind", "body", "plan"] : ["kind", "body"],
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
  if (state.phase === "failure") {
    if (
      entry.kind === "retry" &&
      entry.to === "run" &&
      (entry.from === "human" || entry.from === "relay") &&
      entry.role === state.failure?.role
    ) {
      const next = { ...state, phase: "planning" as const, pending: entry.role! };
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
      state.lastPlanEntryId
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
  if (entry.from === "planner" && entry.kind === "question")
    return { ...next, phase: "gate", pending: null };
  if (state.phase === "planning") {
    if (entry.from === "planner" && entry.kind === "request")
      return { ...next, pending: "reviewer", lastPlanEntryId: entry.id };
    if (entry.from === "reviewer" && (entry.kind === "feedback" || entry.kind === "approve")) {
      const round = state.round + 1;
      return {
        ...next,
        round,
        phase: entry.kind === "approve" || round >= roundCap ? "gate" : "planning",
        pending: entry.kind === "approve" || round >= roundCap ? null : "planner",
      };
    }
  }
  return state;
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
