/** Jobs participating in the plan workflow. */
export type Role = "planner" | "reviewer" | "implementer";
/** Sources of durable log entries. */
export type Sender = Role | "human" | "relay";
/** Destinations selected by the relay. */
export type Recipient = Role | "human" | "run";
/** Protocol messages and durable control actions. */
export type Kind =
  "request" | "feedback" | "approve" | "question" | "done" | "abort" | "retry" | "failure";
/** A durable message; completion metadata makes delivery crash recoverable. */
export interface Entry {
  id: string;
  at: string;
  from: Sender;
  to: Recipient;
  kind: Kind;
  body: string;
  plan?: string;
  role?: Role;
  reason?: "schema" | "exit" | "error";
  completion?: { sessionId: string; delivered: string[] };
}
/** The sole authority for model reply destinations. */
export const RECIPIENT: Record<Role, Partial<Record<Kind, Recipient>>> = {
  planner: { request: "reviewer", feedback: "implementer", question: "human" },
  reviewer: { feedback: "planner", approve: "planner" },
  implementer: { question: "planner", done: "human" },
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
