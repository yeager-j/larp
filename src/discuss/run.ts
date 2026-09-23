import { randomUUID } from "node:crypto";

import { TurnInterrupted } from "../harness/spawn.js";
import type { Harness, TurnResult } from "../harness/types.js";
import { discussEnvelope, discussRolePrompt } from "./prompt.js";
import type { DiscussEntry, DiscussionData, DiscussionStore } from "./store.js";
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

/**
 * Run Turns until the Critic agrees or the round cap is reached, continuing from the log.
 *
 * A finished Discussion returns its outcome without starting a Turn. `log` receives one line as
 * each Turn starts.
 *
 * @throws When another live process runs the Discussion, or a Turn fails or is interrupted. A
 *   failed Turn commits no reply, and the error names the resume command.
 */
export async function runDiscussion(
  store: DiscussionStore,
  harnesses: Record<"claude" | "codex", Harness>,
  log: (line: string) => void = () => {}
): Promise<Outcome> {
  const { id } = store.data;
  const lock = store.tryAcquire();
  if ("heldBy" in lock) throw new Error(`Discussion ${id} is running in process ${lock.heldBy}.`);

  try {
    while (true) {
      const entries = store.entries();
      const step = nextStep(store.data, entries);
      if (step.kind !== "turn") return step;

      await runTurn(store, harnesses, step, entries, log);
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
  log: (line: string) => void
): Promise<void> {
  const participant = store.data.participants[step.role];
  const sessionId = store.sessionId(step.role);
  const round = entries.filter((entry) => entry.kind === "verdict").length + 1;
  let retry: string | undefined;

  log(
    `[larp] round ${round} · ${step.role} (${participant.harness}:${participant.model}) · ${step.mode}`
  );

  for (let attempt = 1; attempt <= 2; attempt++) {
    let result: TurnResult;
    try {
      result = await harnesses[participant.harness].runTurn({
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
        first: !sessionId,
        schema: step.mode === "verdict" ? VERDICT_SCHEMA : PROPOSAL_SCHEMA,
        ...(sessionId ? { sessionId } : {}),
        turnDir: store.nextTurnDir(),
        onEvent() {},
      });
    } catch (error) {
      if (error instanceof TurnInterrupted) throw error;
      result = { sessionId: sessionId ?? "", exitCode: 1, error: String(error) };
    }

    const error = harnessError(result);
    if (error) {
      store.append(entry({ from: "relay", kind: "failure", role: step.role, body: error }));
      throw new Error(`${step.role} Turn failed: ${error}`);
    }

    const reply = replyEntry(step, result, entries);
    if (reply) {
      store.append(reply);
      return;
    }

    retry = `it did not match the ${step.mode === "verdict" ? "verdict" : "proposal"} schema, or a required text field was empty.`;
    store.append(
      entry({ from: "relay", kind: "failure", role: step.role, body: `Invalid reply: ${retry}` })
    );
  }

  throw new Error(`${step.role} replied twice with an invalid reply.`);
}

function harnessError(result: TurnResult): string | undefined {
  if (result.error) return result.error;
  if (result.exitCode !== 0) return `Harness exited with code ${result.exitCode}.`;
  if (!result.sessionId) return "Harness returned no session ID.";

  return undefined;
}

/** Build the committed entry for a valid reply; the Relay sets the version. */
function replyEntry(
  step: TurnStep,
  result: TurnResult,
  entries: DiscussEntry[]
): DiscussEntry | undefined {
  const { output } = result;
  const completion = { sessionId: result.sessionId };
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

function entry(fields: Omit<DiscussEntry, "id" | "at">): DiscussEntry {
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
