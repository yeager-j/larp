import { randomUUID } from "node:crypto";

import { TurnInterrupted } from "../harness/spawn.js";
import type { Harness, TurnResult } from "../harness/types.js";
import { agentEnvelope, agentRolePrompt } from "./prompt.js";
import type { AgentData, AgentEntry, AgentStore } from "./store.js";

/** Outcome of one `deliver` call. */
export type Delivery =
  | { status: "replied"; replies: AgentEntry[] }
  | { status: "queued"; heldBy: number }
  | { status: "failed"; replies: AgentEntry[]; error: string };

/**
 * Deliver every waiting Caller message, one Turn at a time, until none remain.
 *
 * Returns `queued` when another live process holds the Agent lock; that process delivers the
 * waiting messages. A failed Turn leaves its messages waiting for the next delivery.
 */
export async function deliver(
  agent: AgentStore,
  harnesses: Record<"claude" | "codex", Harness>
): Promise<Delivery> {
  const replies: AgentEntry[] = [];

  while (true) {
    const lock = agent.tryAcquire();
    if ("heldBy" in lock)
      return replies.length
        ? { status: "replied", replies }
        : { status: "queued", heldBy: lock.heldBy };

    try {
      for (let waiting = agent.undelivered(); waiting.length; waiting = agent.undelivered()) {
        const turn = await runAgentTurn(agent, harnesses, waiting);
        if ("error" in turn) return { status: "failed", replies, error: turn.error };

        replies.push(turn.reply);
      }
    } finally {
      lock.release();
    }

    // A Caller can append after the last check but before the release; check again unlocked.
    if (!agent.undelivered().length) return { status: "replied", replies };
  }
}

async function runAgentTurn(
  agent: AgentStore,
  harnesses: Record<"claude" | "codex", Harness>,
  waiting: AgentEntry[]
): Promise<{ reply: AgentEntry } | { error: string }> {
  const { participant, cwd } = agent.data;
  const structured = Boolean(participant.schema);
  const sessionId = agent.sessionId();
  let result: TurnResult;

  try {
    result = await harnesses[participant.harness].runTurn({
      cwd,
      model: participant.model,
      effort: participant.effort,
      extraArgs: participant.extraArgs,
      permission: participant.permission,
      rolePrompt: agentRolePrompt(participant.instructions),
      prompt: agentEnvelope(waiting),
      first: !sessionId,
      ...(participant.schema ? { schema: participant.schema } : {}),
      ...(sessionId ? { sessionId } : {}),
      turnDir: agent.nextTurnDir(),
      onEvent() {},
    });
  } catch (error) {
    if (error instanceof TurnInterrupted) throw error;
    result = { sessionId: sessionId ?? "", exitCode: 1, error: String(error) };
  }

  const error = turnError(result, structured);
  if (error) {
    agent.append(entry({ from: "relay", kind: "failure", body: error }));
    return { error };
  }

  const reply = entry({
    from: "agent",
    kind: "reply",
    body: structured ? JSON.stringify(result.output, null, 2) : (result.output as string),
    ...(structured ? { output: result.output } : {}),
    completion: { sessionId: result.sessionId, delivered: waiting.map((item) => item.id) },
  });

  agent.append(reply);

  return { reply };
}

function turnError(result: TurnResult, structured: boolean): string | undefined {
  if (result.error) return result.error;
  if (result.exitCode !== 0) return `Harness exited with code ${result.exitCode}.`;
  if (!result.sessionId) return "Harness returned no session ID.";
  if (result.output === undefined) return "Harness returned no reply.";
  if (!structured && typeof result.output !== "string") return "Harness returned no reply text.";

  return undefined;
}

function entry(fields: Omit<AgentEntry, "id" | "at">): AgentEntry {
  return { id: randomUUID(), at: new Date().toISOString(), ...fields };
}

/**
 * Format replies for the Caller's stdout, with a footer that names the Agent.
 *
 * When there is more than one reply, each starts with a line that names the message it answers.
 */
export function formatReplies(
  data: AgentData,
  replies: AgentEntry[],
  entries: AgentEntry[]
): string {
  const bodies = replies.map((reply) =>
    replies.length > 1
      ? `[larp] Reply to: ${answered(reply, entries)}\n\n${reply.body}`
      : reply.body
  );
  const footer = [
    `[larp] agent ${data.id} · ${data.role} · ${data.participant.harness}:${data.participant.model}`,
    `[larp] Continue: larp agent message ${data.id} --message "<text>"`,
  ];

  return [bodies.join("\n\n---\n\n"), "", ...footer].join("\n");
}

/** Quote the first line of the first message a reply answers, noting any others. */
function answered(reply: AgentEntry, entries: AgentEntry[]): string {
  const ids = reply.completion?.delivered ?? [];
  const first = entries.find((entry) => entry.id === ids[0]);
  const line = first?.body.split("\n")[0]!.trim() ?? "";
  const quote = line.length > 80 ? `${line.slice(0, 79)}…` : line;
  const more = ids.length > 1 ? ` (and ${ids.length - 1} more)` : "";

  return `"${quote}"${more}`;
}
