import { randomUUID } from "node:crypto";

import type { Participant } from "../config.js";
import { TurnInterrupted } from "../harness/spawn.js";
import type { TurnOutcome } from "../harness/turn.js";
import type { Harness, HarnessEvent } from "../harness/types.js";
import { drive } from "../kernel/drive.js";
import type {
  DriveResult,
  Step as KernelStep,
  TurnSpec,
  Workflow,
  WorkflowLog,
} from "../kernel/types.js";
import type { Unsaved } from "../store.js";
import { discussEnvelope, discussRolePrompt } from "./prompt.js";
import {
  sideSession,
  type DiscussEntry,
  type DiscussionData,
  type DiscussionStore,
  type Side,
} from "./store.js";
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
/** Display data for one Discussion Turn. */
interface TurnDetail {
  round: number;
  mode: TurnStep["mode"];
  retry: boolean;
}
type DiscussTurn = TurnSpec<Side, TurnDetail>;
/** A Discussion that must stop in this process; `resume` tries its Turn again. */
type Stopped = { kind: "stopped"; reason: string };

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
  let locked = false;
  const log: WorkflowLog<DiscussEntry> = {
    entries: () => store.entries(),
    nextTurnDir: () => store.nextTurnDir(),
    tryAcquire() {
      const lock = store.tryAcquire();
      locked = "release" in lock;
      return lock;
    },
  };
  let result: DriveResult<Outcome | Stopped>;

  try {
    result = await drive(log, discussWorkflow(store, ui, followup), {
      harnesses,
      startTurn: (turn) =>
        ui.startTurn?.({ side: turn.key, participant: turn.participant, ...turn.detail }),
      event: (_turn, event) => ui.event?.(event),
    });
  } catch (error) {
    // A lock error, such as a harness process that still runs, is not fixed by resuming.
    if (!locked) throw error;

    throw resumable(id, error);
  }

  if (result.status === "held")
    throw new Error(`Discussion ${id} is running in process ${result.heldBy}.`);
  if (result.outcome.kind === "stopped") throw resumable(id, new Error(result.outcome.reason));

  return result.outcome;
}

function resumable(id: string, error: unknown): Error {
  const reason =
    error instanceof TurnInterrupted
      ? "Turn interrupted."
      : error instanceof Error
        ? error.message
        : String(error);

  return new Error(`Discussion ${id}: ${reason}\nResume with: larp discuss resume ${id}`, {
    cause: error,
  });
}

function discussWorkflow(
  store: DiscussionStore,
  ui: DiscussUI,
  followup: string | undefined
): Workflow<DiscussEntry, Side, TurnDetail, never, Outcome | Stopped> {
  const commit = (item: DiscussEntry) => {
    store.append(item);
    ui.entry?.(item);
  };

  return {
    begin(entries) {
      if (followup === undefined) return;
      if (nextStep(store.data, entries).kind === "turn")
        throw new Error("It has not finished, so it cannot take a follow-up.");

      commit(entry({ from: "caller", kind: "followup", body: followup }));
    },
    next: (entries, { resumedAt }) => discussStep(store.data, entries, resumedAt),
    commit(turn, outcome, entries) {
      if (!outcome.ok) {
        commit(entry({ from: "relay", kind: "failure", role: turn.key, body: outcome.error }));
        throw new Error(`${turn.key} Turn failed: ${outcome.error}`);
      }

      commit(
        replyEntry(turn.detail.mode, outcome, entries) ??
          entry({
            from: "relay",
            kind: "failure",
            role: turn.key,
            body: `Invalid reply: ${invalidReplyNote(turn.detail.mode)}`,
          })
      );
    },
  };
}

/**
 * The next Discussion Step: the outcome, or the pending Turn. An invalid reply is retried once in
 * the same process with a note; a second one stops the Discussion for `resume`.
 */
function discussStep(
  data: DiscussionData,
  entries: DiscussEntry[],
  resumedAt: number
): KernelStep<Side, TurnDetail, never, Outcome | Stopped> {
  const step = nextStep(data, entries);
  if (step.kind !== "turn") return { kind: "done", outcome: step };

  const attemptsFrom = Math.max(resumedAt, entries.findLastIndex((e) => e.kind !== "failure") + 1);
  const invalidReplies = entries.slice(attemptsFrom).length;

  if (invalidReplies >= 2)
    return {
      kind: "done",
      outcome: { kind: "stopped", reason: `${step.role} replied twice with an invalid reply.` },
    };

  return { kind: "turns", turns: [discussTurn(data, entries, step, invalidReplies === 1)] };
}

function discussTurn(
  data: DiscussionData,
  entries: DiscussEntry[],
  step: TurnStep,
  retry: boolean
): DiscussTurn {
  const participant = data.participants[step.role];
  const sessionId = sideSession(entries, step.role);

  return {
    key: step.role,
    participant,
    cwd: data.cwd,
    permission: "read-only",
    rolePrompt: discussRolePrompt(step.role, participant.instructions),
    prompt: discussEnvelope({
      data,
      entries,
      step,
      first: !sessionId,
      ...(retry ? { retry: invalidReplyNote(step.mode) } : {}),
    }),
    schema: step.mode === "verdict" ? VERDICT_SCHEMA : PROPOSAL_SCHEMA,
    ...(sessionId ? { sessionId } : {}),
    delivered: [],
    detail: {
      round: entries.filter((entry) => entry.kind === "verdict").length + 1,
      mode: step.mode,
      retry,
    },
  };
}

function invalidReplyNote(mode: TurnStep["mode"]): string {
  return `it did not match the ${mode === "verdict" ? "verdict" : "proposal"} schema, or a required text field was empty.`;
}

/** Build the committed entry for a valid reply; the Relay sets the version. */
function replyEntry(
  mode: TurnStep["mode"],
  { output, sessionId }: Extract<TurnOutcome, { ok: true }>,
  entries: DiscussEntry[]
): DiscussEntry | undefined {
  const completion = { sessionId };
  const proposals = entries.filter((entry) => entry.kind === "proposal");

  if (mode === "verdict")
    return validVerdict(output)
      ? entry({ from: "critic", kind: "verdict", ...output, version: proposals.length, completion })
      : undefined;

  if (!validProposal(output)) return undefined;

  return mode === "draft"
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
