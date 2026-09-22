import type { AgentEntry } from "./store.js";

const PROTOCOL = `You are an Agent that another coding agent (the Caller) started through larp. Each Turn carries one or more messages from the Caller. Your final answer goes back to the Caller as written, so make it complete and self-contained. Stay within your permissions.`;

/** Protocol instructions followed by the Role's own instructions. */
export function agentRolePrompt(instructions?: string): string {
  return instructions ? `${PROTOCOL}\n\n${instructions}` : PROTOCOL;
}

/** Render waiting Caller messages as one Turn prompt, numbering them when there are several. */
export function agentEnvelope(messages: AgentEntry[]): string {
  if (messages.length === 1) return messages[0]!.body;

  const numbered = messages.map((message, n) => `Message ${n + 1}:\n${message.body}`);

  return [`larp is relaying ${messages.length} messages from the Caller.`, ...numbered].join(
    "\n\n"
  );
}
