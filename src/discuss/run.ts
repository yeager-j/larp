import { randomUUID } from "node:crypto";

import type { Participant } from "../config.js";
import { TurnInterrupted } from "../harness/spawn.js";
import { attemptTurn, type TurnOutcome } from "../harness/turn.js";
import type { Harness, HarnessEvent } from "../harness/types.js";
import type { Unsaved } from "../store.js";
import { discussEnvelope, discussRolePrompt } from "./prompt.js";
import type { DiscussEntry, DiscussionData, DiscussionStore, Side } from "./store.js";
import {
  nextStep,
  PROPOSAL_SCHEMA,
  validProposal,
  validVerdict,
  VERDICT_SCHEMA,
  type Outcome,
  type Step,
} from "./workflow.js";

type TurnStep = Extract<Step, { kind: "turn" }>;

/** Display callbacks for a running Discussion; each is optional. */
export interface DiscussUI {
  /** Announce a Turn attempt; `retry` is true after an invalid reply. */
  startTurn?(turn: {
    side: Side;
    participant: Participant;
    round: number;
    mode: TurnStep["mode"];
    retry: boolean;
  }): void;
  /** Display harness progress during a Turn. */
  event?(event: HarnessEvent): void;
  /** Display an entry after the log commits it. */
  entry?(entry: DiscussEntry): void;
}

/**
 * Run Turns until the Critic agrees or the round cap is reached, continuing from the log.
 *
 * A finished Discussion returns its outcome without starting a Turn, unless `followup` reopens it
 * for another Author Turn. `ui` sees each Turn start, its progress, and each entry it commits.
 *
 * @throws When another live process runs the Discussion, a follow-up targets an unfinished
 *   Discussion, or a Turn fails or is interrupted. A failed Turn commits no reply, and the error
 *   names the resume command.
 */
export async function runDiscussion(
  store: DiscussionStore,
  harnesses: Record<"claude" | "codex", Harness>,
  ui: DiscussUI = {},
  followup?: string
): Promise<Outcome> {
  const { id } = store.data;
  const lock = store.tryAcquire();
  if ("heldBy" in lock) throw new Error(`Discussion ${id} is running in process ${lock.heldBy}.`);

  try {
    if (followup !== undefined) {
      if (nextStep(store.data, store.entries()).kind === "turn")
        throw new Error("It has not finished, so it cannot take a follow-up.");

      const item = entry({ from: "caller", kind: "followup", body: followup });
      store.append(item);
      ui.entry?.(item);
    }

    while (true) {
      const entries = store.entries();
      const step = nextStep(store.data, entries);
      if (step.kind !== "turn") return step;

      await runTurn(store, harnesses, step, entries, ui);
    }
  } catch (error) {
    const reason =
      error instanceof TurnInterrupted
        ? "Turn interrupted."
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`Discussion ${id}: ${reason}\nResume with: larp discuss resume ${id}`, {
      cause: error,
    });
  } finally {
    lock.release();
  }
}

/** Run one Turn, retrying once with a note when the reply is invalid. */
async function runTurn(
  store: DiscussionStore,
  harnesses: Record<"claude" | "codex", Harness>,
  step: TurnStep,
  entries: DiscussEntry[],
  ui: DiscussUI
): Promise<void> {
  const participant = store.data.participants[step.role];
  const sessionId = store.sessionId(step.role);
  const round = entries.filter((entry) => entry.kind === "verdict").length + 1;
  let retry: string | undefined;
  const commit = (item: DiscussEntry) => {
    store.append(item);
    ui.entry?.(item);
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    ui.startTurn?.({ side: step.role, participant, round, mode: step.mode, retry: attempt > 1 });

    const outcome = await attemptTurn(harnesses[participant.harness], () => ({
      cwd: store.data.cwd,
      model: participant.model,
      effort: participant.effort,
      extraArgs: participant.extraArgs,
      permission: "read-only",
      web: participant.web ?? false,
      rolePrompt: discussRolePrompt(step.role, participant.instructions),
      prompt: discussEnvelope({
        data: store.data,
        entries,
        step,
        first: !sessionId,
        ...(retry ? { retry } : {}),
      }),
      schema: step.mode === "verdict" ? VERDICT_SCHEMA : PROPOSAL_SCHEMA,
      ...(sessionId ? { sessionId } : {}),
      turnDir: store.nextTurnDir(),
      onEvent: (event) => ui.event?.(event),
    }));

    if (!outcome.ok) {
      commit(entry({ from: "relay", kind: "failure", role: step.role, body: outcome.error }));
      throw new Error(`${step.role} Turn failed: ${outcome.error}`);
    }

    const reply = replyEntry(step, outcome, entries);
    if (reply) {
      commit(reply);
      return;
    }

    retry = `it did not match the ${step.mode === "verdict" ? "verdict" : "proposal"} schema, or a required text field was empty.`;
    commit(
      entry({ from: "relay", kind: "failure", role: step.role, body: `Invalid reply: ${retry}` })
    );
  }

  throw new Error(`${step.role} replied twice with an invalid reply.`);
}

/** Build the committed entry for a valid reply; the Relay sets the version. */
function replyEntry(
  step: TurnStep,
  { output, sessionId }: Extract<TurnOutcome, { ok: true }>,
  entries: DiscussEntry[]
): DiscussEntry | undefined {
  const completion = { sessionId };
  const proposals = entries.filter((entry) => entry.kind === "proposal");

  if (step.mode === "verdict")
    return validVerdict(output)
      ? entry({ from: "critic", kind: "verdict", ...output, version: proposals.length, completion })
      : undefined;

  if (!validProposal(output)) return undefined;

  return step.mode === "draft"
    ? entry({ from: "critic", kind: "draft", ...output, completion })
    : entry({
        from: "author",
        kind: "proposal",
        ...output,
        version: proposals.length + 1,
        completion,
      });
}

function entry(fields: Unsaved<DiscussEntry>): DiscussEntry {
  return { id: randomUUID(), at: new Date().toISOString(), ...fields };
}

/** Format an outcome for the Caller's stdout: the final proposal, then a footer. */
export function formatOutcome(data: DiscussionData, outcome: Outcome): string {
  const { proposal, verdict, rounds } = outcome;
  const counted = `${rounds} round${rounds === 1 ? "" : "s"}`;
  const { author, critic } = data.participants;
  const summary =
    outcome.kind === "agreed"
      ? [
          `[larp] Agreed: the Critic accepted proposal v${proposal.version} after ${counted}.`,
          `[larp] The Critic's remaining objection: ${verdict.objection}`,
        ]
      : [
          `[larp] No agreement after ${counted}. The Critic's open objections to proposal v${proposal.version}:`,
          `Strongest objection: ${verdict.objection}`,
          "",
          verdict.body,
          "",
        ];

  return [
    proposal.proposal,
    "",
    "---",
    ...summary,
    `[larp] discussion ${data.id} · author ${author.harness}:${author.model} · critic ${critic.harness}:${critic.model}`,
  ].join("\n");
}
