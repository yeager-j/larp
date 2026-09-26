import { randomUUID } from "node:crypto";

import { TurnInterrupted } from "../harness/spawn.js";
import type { Harness } from "../harness/types.js";
import { drive } from "../kernel/drive.js";
import type { DriveResult, Workflow } from "../kernel/types.js";
import { agentEnvelope, agentRolePrompt } from "./prompt.js";
import {
  agentSession,
  undeliveredIn,
  type AgentData,
  type AgentEntry,
  type AgentStore,
} from "./store.js";

/** Outcome of one `deliver` call, with the replies this call committed before it ended. */
export type Delivery =
  | { status: "replied"; replies: AgentEntry[] }
  | { status: "queued"; heldBy: number }
  | { status: "failed"; replies: AgentEntry[]; error: string }
  | { status: "interrupted"; replies: AgentEntry[] };

/** How one driver pass over the Agent ended. */
type AgentOutcome = { kind: "replied" } | { kind: "failed"; error: string };

/**
 * Deliver every waiting Caller message, one Turn at a time, until none remain.
 *
 * Returns `queued` when another live process holds the Agent lock; that process delivers the
 * waiting messages. A failed or interrupted Turn leaves its messages waiting for the next delivery.
 *
 * @throws When a harness process from an earlier Turn is still running.
 */
export async function deliver(
  agent: AgentStore,
  harnesses: Record<"claude" | "codex", Harness>
): Promise<Delivery> {
  const replies: AgentEntry[] = [];

  while (true) {
    let result: DriveResult<AgentOutcome>;

    try {
      result = await drive(agent, agentWorkflow(agent, replies), { harnesses });
    } catch (error) {
      if (error instanceof TurnInterrupted) return { status: "interrupted", replies };

      throw error;
    }

    if (result.status === "held")
      return replies.length
        ? { status: "replied", replies }
        : { status: "queued", heldBy: result.heldBy };
    if (result.outcome.kind === "failed")
      return { status: "failed", replies, error: result.outcome.error };

    // A Caller can append after the last check but before the release; check again unlocked.
    if (!agent.undelivered().length) return { status: "replied", replies };
  }
}

/** Deliver waiting messages until none remain; stop at the first failure in this process. */
function agentWorkflow(
  agent: AgentStore,
  replies: AgentEntry[]
): Workflow<AgentEntry, "agent", undefined, never, AgentOutcome> {
  const { participant, cwd } = agent.data;
  const recordFailure = (error: string) => {
    agent.append(entry({ from: "relay", kind: "failure", body: error }));
  };

  return {
    next(entries, { resumedAt }) {
      const failure = entries.slice(resumedAt).find((entry) => entry.kind === "failure");
      if (failure) return { kind: "done", outcome: { kind: "failed", error: failure.body } };

      const waiting = undeliveredIn(entries);
      if (!waiting.length) return { kind: "done", outcome: { kind: "replied" } };

      const sessionId = agentSession(entries);

      return {
        kind: "turns",
        turns: [
          {
            key: "agent",
            participant,
            cwd,
            permission: participant.permission,
            rolePrompt: agentRolePrompt(participant.instructions),
            prompt: agentEnvelope(waiting),
            ...(participant.schema ? { schema: participant.schema } : {}),
            ...(sessionId ? { sessionId } : {}),
            delivered: waiting.map((item) => item.id),
            detail: undefined,
          },
        ],
      };
    },
    commit(turn, outcome) {
      if (!outcome.ok) return recordFailure(outcome.error);

      const reply = replyFields(outcome.output, Boolean(participant.schema));
      if ("error" in reply) return recordFailure(reply.error);

      const committed = entry({
        from: "agent",
        kind: "reply",
        ...reply,
        completion: { sessionId: outcome.sessionId, delivered: turn.delivered },
      });

      agent.append(committed);
      replies.push(committed);
    },
  };
}

/** A structured reply is shown as formatted JSON; a free-text reply must be text. */
function replyFields(
  output: unknown,
  structured: boolean
): Pick<AgentEntry, "body" | "output"> | { error: string } {
  if (output === undefined) return { error: "Harness returned no reply." };
  if (structured) return { body: JSON.stringify(output, null, 2), output };
  if (typeof output !== "string") return { error: "Harness returned no reply text." };

  return { body: output };
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
