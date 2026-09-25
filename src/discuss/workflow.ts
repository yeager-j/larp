import type { DiscussEntry, DiscussionData, ProposalEntry, VerdictEntry } from "./store.js";

/** Rounds allowed when the Caller does not choose. */
export const DEFAULT_ROUNDS = 5;
/** Largest round cap the CLI accepts. */
export const MAX_ROUNDS = 10;

/** Strict reply schema for Author proposals and the blind Critic draft. */
export const PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { proposal: { type: "string" }, body: { type: "string" } },
  required: ["proposal", "body"],
};
/** Strict reply schema for Critic verdicts. */
export const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["agree", "revise"] },
    objection: { type: "string" },
    body: { type: "string" },
  },
  required: ["verdict", "objection", "body"],
};

/** A valid proposal or draft reply. */
export interface ProposalReply {
  proposal: string;
  body: string;
}
/** A valid verdict reply. */
export interface VerdictReply {
  verdict: "agree" | "revise";
  objection: string;
  body: string;
}
/** How a Discussion ended. */
export type Outcome = {
  kind: "agreed" | "capped";
  /** The latest proposal, which the verdict answers. */
  proposal: ProposalEntry;
  /** The Critic's verdict on that proposal. */
  verdict: VerdictEntry;
  /** Completed rounds across the whole Discussion, follow-ups included. */
  rounds: number;
};
/** What the Relay does next. */
export type Step =
  | { kind: "turn"; role: "author"; mode: "propose" }
  | { kind: "turn"; role: "critic"; mode: "draft" | "verdict" }
  | Outcome;

/** Accept a proposal reply with a nonempty proposal and no extra keys. */
export function validProposal(output: unknown): output is ProposalReply {
  return (
    exactKeys(output, ["proposal", "body"]) &&
    typeof output.proposal === "string" &&
    output.proposal.trim().length > 0 &&
    typeof output.body === "string"
  );
}

/** Accept a verdict reply with a known verdict, a nonempty objection, and no extra keys. */
export function validVerdict(output: unknown): output is VerdictReply {
  return (
    exactKeys(output, ["verdict", "objection", "body"]) &&
    (output.verdict === "agree" || output.verdict === "revise") &&
    typeof output.objection === "string" &&
    output.objection.trim().length > 0 &&
    typeof output.body === "string"
  );
}

function exactKeys(output: unknown, keys: string[]): output is Record<string, unknown> {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;

  const actual = Object.keys(output);

  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

/**
 * Decide the next Turn or the outcome from the log alone; failure entries do not count.
 *
 * A follow-up reopens the Discussion with a new Author Turn, and the round cap counts only the
 * verdicts after the latest follow-up.
 */
export function nextStep(
  data: Pick<DiscussionData, "blind" | "maxRounds">,
  entries: DiscussEntry[]
): Step {
  const proposal = entries.findLast((entry) => entry.kind === "proposal");
  const verdicts = entries.filter((entry) => entry.kind === "verdict");
  const verdict = verdicts.at(-1);
  const current = entries.slice(entries.findLastIndex((entry) => entry.kind === "followup") + 1);
  const currentVerdicts = current.filter((entry) => entry.kind === "verdict").length;

  if (!proposal || !current.some((entry) => entry.kind === "proposal"))
    return { kind: "turn", role: "author", mode: "propose" };
  if (data.blind && !entries.some((entry) => entry.kind === "draft"))
    return { kind: "turn", role: "critic", mode: "draft" };
  if (!verdict || verdict.version !== proposal.version)
    return { kind: "turn", role: "critic", mode: "verdict" };
  if (verdict.verdict === "agree")
    return { kind: "agreed", proposal, verdict, rounds: verdicts.length };
  if (currentVerdicts >= data.maxRounds)
    return { kind: "capped", proposal, verdict, rounds: verdicts.length };

  return { kind: "turn", role: "author", mode: "propose" };
}
