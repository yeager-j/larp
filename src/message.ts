/** Jobs participating in the plan workflow. */
export type Role = "planner" | "reviewer";
/** Destinations selected by the relay. */
export type Recipient = Role | "human" | "run" | "implementer";
/** Protocol messages and durable control actions. */
export type Kind =
  | "request"
  | "feedback"
  | "approve"
  | "question"
  | "done"
  | "abort"
  | "retry"
  | "failure"
  | "handoff";
/** Fields every Run log entry has. */
interface EntryFields {
  /** Unique log entry identifier. */
  id: string;
  /** Entry creation time in ISO 8601 format. */
  at: string;
  /** Human-readable message content. */
  body: string;
}
/** Committed Turn data: the harness session and the entries the reply answered. */
export interface Completion {
  sessionId: string;
  delivered: string[];
}
/** A Planner request for review, with the full plan. */
export interface PlanRequestEntry extends EntryFields {
  from: "planner";
  to: "reviewer";
  kind: "request";
  plan: string;
  completion: Completion;
}
/** A Planner question for the Human. */
export interface QuestionEntry extends EntryFields {
  from: "planner";
  to: "human";
  kind: "question";
  completion: Completion;
}
/** A Reviewer verdict on the latest plan. */
export interface ReviewEntry extends EntryFields {
  from: "reviewer";
  to: "planner";
  kind: "feedback" | "approve";
  completion: Completion;
}
/** A Human message to a Role: Gate feedback or an interjection during a Turn. */
export interface HumanFeedbackEntry extends EntryFields {
  from: "human";
  to: Role;
  kind: "feedback";
}
/** A Human approval at the Phase Gate. */
export interface ApprovalEntry extends EntryFields {
  from: "human";
  to: "run";
  kind: "approve";
  /** Approved plan snapshot, including Human edits; absent on legacy Runs. */
  plan?: string;
}
/** A Human abort. */
export interface AbortEntry extends EntryFields {
  from: "human";
  to: "run";
  kind: "abort";
}
/** A retry of a failed Turn, chosen by the Human or scheduled once by the Relay. */
export interface RetryEntry extends EntryFields {
  from: "human" | "relay";
  to: "run";
  kind: "retry";
  /** Role whose Turn is retried. */
  role: Role;
}
/** A failed Turn or an invalid reply. */
export interface FailureEntry extends EntryFields {
  from: "relay";
  to: "run";
  kind: "failure";
  /** Role whose Turn failed. */
  role: Role;
  /** Cause of the failure. */
  reason: "schema" | "exit" | "error";
}
/** The Relay opened the approved plan in Codex desktop. */
export interface HandoffEntry extends EntryFields {
  from: "relay";
  to: "human";
  kind: "handoff";
}
/**
 * An Implementer message from the earlier implementation workflow; only `done` still changes
 * state. Those logs can also hold Planner feedback to the Implementer, which the reducer ignores.
 */
export interface LegacyImplementerEntry extends EntryFields {
  from: "implementer";
  to: "planner" | "human";
  kind: "question" | "done";
  completion: Completion;
}
/** One durable Run log entry. */
export type Entry =
  | PlanRequestEntry
  | QuestionEntry
  | ReviewEntry
  | HumanFeedbackEntry
  | ApprovalEntry
  | AbortEntry
  | RetryEntry
  | FailureEntry
  | HandoffEntry
  | LegacyImplementerEntry;
/** A Participant reply, which records the completion of its Turn. */
export type ReplyEntry = PlanRequestEntry | QuestionEntry | ReviewEntry;
/** Whether an entry is a Participant reply. */
export function isReply(entry: Entry): entry is ReplyEntry {
  return entry.from === "planner" || entry.from === "reviewer";
}
/** The sole authority for model reply destinations. */
export const RECIPIENT: Record<Role, Partial<Record<Kind, Recipient>>> = {
  planner: { request: "reviewer", question: "human" },
  reviewer: { feedback: "planner", approve: "planner" },
};
/** Roles in picker order. */
export const ROLES = Object.keys(RECIPIENT) as Role[];
/** Render ordered messages as a relay-owned prompt. */
export function envelope(input: {
  role: Role;
  model: string;
  task: string;
  firstForRole: boolean;
  planPath?: string;
  entries: Entry[];
  schemaReminder: string;
  models?: Partial<Record<Role, string>>;
}): string {
  const lines = [`larp is relaying messages to ${input.role} (${input.model}).`];
  if (input.firstForRole) lines.push(`Original task:\n${input.task}`);
  if (input.planPath) lines.push(`Plan file: ${input.planPath}`);
  for (const entry of input.entries) {
    const model = input.models?.[entry.from as Role];
    lines.push(
      `From: ${entry.from}${model ? ` (${model})` : ""}; kind: ${entry.kind}\n${entry.body}`
    );
  }
  lines.push(`Reply with structured JSON: ${input.schemaReminder}`);
  return lines.join("\n\n");
}
