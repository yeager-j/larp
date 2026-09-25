import assert from "node:assert/strict";
import test from "node:test";

import { participantFor, type Participant } from "../config.js";
import { TurnInterrupted } from "../harness/spawn.js";
import type { Harness, TurnRequest, TurnResult } from "../harness/types.js";
import { builtInRole } from "../roles.js";
import { tempDir } from "../test-support.js";
import { formatOutcome, runDiscussion } from "./run.js";
import { DiscussionStore } from "./store.js";
import { nextStep, PROPOSAL_SCHEMA, VERDICT_SCHEMA } from "./workflow.js";

const author: Participant = {
  harness: "claude",
  model: "author-model",
  effort: "high",
  extraArgs: [],
};
const critic: Participant = {
  harness: "codex",
  model: "critic-model",
  effort: "low",
  extraArgs: [],
};

type Reply = (req: TurnRequest, n: number) => Partial<TurnResult>;

/** Reply with a numbered proposal, or with the verdict that `decide` picks for the nth verdict. */
function script(decide: (verdictNumber: number) => "agree" | "revise"): Reply {
  let verdicts = 0;
  return (req, n) =>
    req.schema === VERDICT_SCHEMA
      ? { output: { verdict: decide(++verdicts), objection: `objection ${verdicts}`, body: "fix" } }
      : { output: { proposal: `proposal from turn ${n}`, body: "note" } };
}

function fakeHarnesses(turns: TurnRequest[], reply: Reply): Record<"claude" | "codex", Harness> {
  const runTurn = async (req: TurnRequest): Promise<TurnResult> => {
    turns.push(req);
    req.onEvent({ type: "text", text: `working on turn ${turns.length}` });
    return {
      sessionId: req.sessionId ?? `session-${req.model}`,
      exitCode: 0,
      ...reply(req, turns.length),
    };
  };
  return { claude: { id: "claude", runTurn }, codex: { id: "codex", runTurn } };
}

function create(t: test.TestContext, blind: boolean, maxRounds = 5, authorSide = author) {
  const root = tempDir(t);
  const store = DiscussionStore.create(
    { task: "Evaluate the idea", blind, maxRounds, participants: { author: authorSide, critic } },
    root,
    root
  );
  return { root, store };
}

test("agreement in round 2 resumes each side's session and replays without new Turns", async (t) => {
  const writer = participantFor({
    ...builtInRole("planner", { harness: "claude", model: "author-model" }),
    permission: "write",
  });
  const { root, store } = create(t, false, 5, writer);
  const turns: TurnRequest[] = [];
  const lines: string[] = [];

  const outcome = await runDiscussion(
    store,
    fakeHarnesses(
      turns,
      script((n) => (n === 2 ? "agree" : "revise"))
    ),
    {
      startTurn: ({ side, participant, round, mode }) =>
        lines.push(`round ${round} · ${side} (${participant.model}) · ${mode}`),
      event: (event) => lines.push(event.type === "text" ? event.text : event.type),
      entry: (item) => lines.push(`${item.from} ${item.kind}`),
    }
  );

  assert.equal(outcome.kind, "agreed");
  assert.equal(outcome.proposal.version, 2);
  assert.equal(outcome.proposal.proposal, "proposal from turn 3");
  assert.equal(outcome.rounds, 2);
  assert.deepEqual(
    turns.map((turn) => [turn.model, turn.sessionId]),
    [
      ["author-model", undefined],
      ["critic-model", undefined],
      ["author-model", "session-author-model"],
      ["critic-model", "session-critic-model"],
    ]
  );
  assert.ok(turns.every((turn) => turn.permission === "read-only"));
  assert.deepEqual(
    turns.map((turn) => turn.web),
    [true, false, true, false]
  );
  assert.match(turns[0]!.rolePrompt, /You are the Author[\s\S]*You are a planner/);
  assert.match(turns[1]!.prompt, /^Verdict Turn on proposal v1\.\n\nTask:\nEvaluate the idea/);
  assert.match(turns[2]!.prompt, /verdict on v1: revise\nStrongest objection: objection 1/);
  assert.doesNotMatch(turns[3]!.prompt, /Task:/);
  assert.deepEqual(lines, [
    "round 1 · author (author-model) · propose",
    "working on turn 1",
    "author proposal",
    "round 1 · critic (critic-model) · verdict",
    "working on turn 2",
    "critic verdict",
    "round 2 · author (author-model) · propose",
    "working on turn 3",
    "author proposal",
    "round 2 · critic (critic-model) · verdict",
    "working on turn 4",
    "critic verdict",
  ]);

  const text = formatOutcome(store.data, outcome);
  assert.equal(
    text,
    [
      "proposal from turn 3",
      "",
      "---",
      "[larp] Agreed: the Critic accepted proposal v2 after 2 rounds.",
      "[larp] The Critic's remaining objection: objection 2",
      `[larp] discussion ${store.data.id} · author claude:author-model · critic codex:critic-model`,
    ].join("\n")
  );

  const replayed = DiscussionStore.open(store.data.id, root);
  const none: TurnRequest[] = [];
  const again = await runDiscussion(
    replayed,
    fakeHarnesses(
      none,
      script(() => "revise")
    )
  );
  assert.equal(none.length, 0);
  assert.equal(formatOutcome(replayed.data, again), text);
});

test("a follow-up reopens an agreed Discussion with the Author, then the Critic", async (t) => {
  const { root, store } = create(t, false);
  const first: TurnRequest[] = [];
  await runDiscussion(
    store,
    fakeHarnesses(
      first,
      script(() => "agree")
    )
  );

  const turns: TurnRequest[] = [];
  const shown: string[] = [];
  const outcome = await runDiscussion(
    DiscussionStore.open(store.data.id, root),
    fakeHarnesses(
      turns,
      script((n) => (n === 2 ? "agree" : "revise"))
    ),
    { entry: (item) => shown.push(`${item.from} ${item.kind}`) },
    "What about Windows?"
  );

  assert.equal(outcome.kind, "agreed");
  assert.equal(outcome.proposal.version, 3);
  assert.equal(outcome.rounds, 3);
  assert.deepEqual(shown.slice(0, 2), ["caller followup", "author proposal"]);
  assert.deepEqual(
    turns.map((turn) => [turn.model, turn.sessionId]),
    [
      ["author-model", "session-author-model"],
      ["critic-model", "session-critic-model"],
      ["author-model", "session-author-model"],
      ["critic-model", "session-critic-model"],
    ]
  );
  assert.match(
    turns[0]!.prompt,
    /Caller has reopened it[\s\S]*verdict on v1: agree\nStrongest objection: objection 1[\s\S]*Follow-up from the Caller:\nWhat about Windows\?/
  );
  assert.match(
    turns[1]!.prompt,
    /Caller reopened the Discussion with this follow-up:\nWhat about Windows\?/
  );
  assert.doesNotMatch(turns[3]!.prompt, /What about Windows/);
});

test("a follow-up is refused while the Discussion has not finished", async (t) => {
  const { store } = create(t, false);
  const turns: TurnRequest[] = [];

  await assert.rejects(
    runDiscussion(
      store,
      fakeHarnesses(
        turns,
        script(() => "agree")
      ),
      {},
      "More?"
    ),
    /It has not finished, so it cannot take a follow-up\.\nResume with: larp discuss resume/
  );
  assert.equal(turns.length, 0);
  assert.deepEqual(store.entries(), []);
});

test("the round cap ends with the last proposal and the Critic's open objections", async (t) => {
  const { root, store } = create(t, false, 3);
  const turns: TurnRequest[] = [];

  const outcome = await runDiscussion(
    store,
    fakeHarnesses(
      turns,
      script(() => "revise")
    )
  );

  assert.equal(turns.length, 6);
  assert.equal(outcome.kind, "capped");
  assert.equal(outcome.proposal.version, 3);
  assert.match(
    formatOutcome(store.data, outcome),
    /^proposal from turn 5\n\n---\n\[larp\] No agreement after 3 rounds\. The Critic's open objections to proposal v3:\nStrongest objection: objection 3\n\nfix\n/
  );

  const none: TurnRequest[] = [];
  const replayed = DiscussionStore.open(store.data.id, root);
  assert.deepEqual(
    await runDiscussion(
      replayed,
      fakeHarnesses(
        none,
        script(() => "agree")
      )
    ),
    outcome
  );
  assert.equal(none.length, 0);
});

test("blind mode hides the first proposal from the Critic's draft and shows the draft to the Author", async (t) => {
  const { store } = create(t, true);
  const turns: TurnRequest[] = [];
  const later = script((v) => (v === 2 ? "agree" : "revise"));
  const reply: Reply = (req, n) =>
    n === 1
      ? { output: { proposal: "AUTHOR-SECRET-V1", body: "AUTHOR-NOTE" } }
      : n === 2
        ? { output: { proposal: "CRITIC-OWN-ANSWER", body: "critic note" } }
        : later(req, n);

  const outcome = await runDiscussion(store, fakeHarnesses(turns, reply));

  assert.equal(outcome.kind, "agreed");
  assert.deepEqual(
    turns.map((turn) => turn.schema),
    [PROPOSAL_SCHEMA, PROPOSAL_SCHEMA, VERDICT_SCHEMA, PROPOSAL_SCHEMA, VERDICT_SCHEMA]
  );
  const [, draftTurn, verdictTurn, revision, secondVerdict] = turns;
  assert.match(draftTurn!.prompt, /^Draft Turn\./);
  assert.doesNotMatch(draftTurn!.prompt, /AUTHOR-SECRET-V1|AUTHOR-NOTE/);
  assert.equal(verdictTurn!.sessionId, "session-critic-model");
  assert.match(verdictTurn!.prompt, /own draft[\s\S]*AUTHOR-SECRET-V1/);
  assert.doesNotMatch(verdictTurn!.prompt, /Task:/);
  assert.match(revision!.prompt, /Critic's own answer[\s\S]*CRITIC-OWN-ANSWER/);
  assert.doesNotMatch(secondVerdict!.prompt, /own draft/);
  assert.equal(store.entries().filter((entry) => entry.kind === "verdict").length, 2);
});

test("an invalid reply is retried once with a note; a second one stops, and resume completes", async (t) => {
  const { root, store } = create(t, false);
  const turns: TurnRequest[] = [];
  const bad: Reply = (req, n) =>
    req.schema === VERDICT_SCHEMA && n <= 3
      ? { output: { verdict: "agree", objection: "", body: "fine" } }
      : script(() => "agree")(req, n);

  const attempts: string[] = [];
  await assert.rejects(
    runDiscussion(store, fakeHarnesses(turns, bad), {
      startTurn: ({ side, retry }) => attempts.push(`${side}${retry ? " retry" : ""}`),
      entry: (item) => attempts.push(item.kind),
    }),
    new RegExp(
      `^Error: Discussion ${store.data.id}: critic replied twice with an invalid reply\\.\\nResume with: larp discuss resume ${store.data.id}$`
    )
  );
  assert.equal(turns.length, 3);
  assert.match(turns[2]!.prompt, /previous reply to this Turn was rejected/);
  assert.deepEqual(attempts, [
    "author",
    "proposal",
    "critic",
    "failure",
    "critic retry",
    "failure",
  ]);
  assert.deepEqual(
    store.entries().map((entry) => entry.kind),
    ["proposal", "failure", "failure"]
  );

  const resumed = DiscussionStore.open(store.data.id, root);
  const outcome = await runDiscussion(resumed, fakeHarnesses(turns, bad));
  assert.equal(outcome.kind, "agreed");
  assert.doesNotMatch(turns[3]!.prompt, /rejected/);
  assert.equal(turns[3]!.sessionId, undefined);
});

test("a harness failure stops at once and records the failure", async (t) => {
  const { store } = create(t, false);
  const turns: TurnRequest[] = [];

  await assert.rejects(
    runDiscussion(
      store,
      fakeHarnesses(turns, () => ({ exitCode: 3 }))
    ),
    /author Turn failed: Harness exited with code 3\.\nResume with: larp discuss resume/
  );
  assert.equal(turns.length, 1);
  assert.deepEqual(
    store.entries().map((entry) => [entry.kind, entry.kind === "failure" && entry.role]),
    [["failure", "author"]]
  );
});

test("an interrupted Turn commits nothing, releases the lock, and resumes the same Turn", async (t) => {
  const { root, store } = create(t, true);
  const turns: TurnRequest[] = [];
  const interrupting: Reply = (req, n) => {
    if (n === 3) throw new TurnInterrupted("Turn interrupted by SIGINT; resume this Run to retry.");
    return script(() => "agree")(req, n);
  };

  await assert.rejects(
    runDiscussion(store, fakeHarnesses(turns, interrupting)),
    (error: Error) =>
      error.message ===
      `Discussion ${store.data.id}: Turn interrupted.\nResume with: larp discuss resume ${store.data.id}`
  );
  assert.deepEqual(
    store.entries().map((entry) => entry.kind),
    ["proposal", "draft"]
  );

  const reopened = DiscussionStore.open(store.data.id, root);
  assert.ok("release" in reopened.tryAcquire());
  assert.deepEqual(nextStep(reopened.data, reopened.entries()), {
    kind: "turn",
    role: "critic",
    mode: "verdict",
  });
});

test("a Discussion held by a live process is refused", async (t) => {
  const { store } = create(t, false);
  const lock = store.tryAcquire();
  assert.ok("release" in lock);

  await assert.rejects(
    runDiscussion(
      store,
      fakeHarnesses(
        [],
        script(() => "agree")
      )
    ),
    new RegExp(`Discussion ${store.data.id} is running in process ${process.pid}\\.`)
  );
  lock.release();
});
