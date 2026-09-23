import assert from "node:assert/strict";
import test from "node:test";

import type { DiscussEntry } from "./store.js";
import { nextStep, validProposal, validVerdict } from "./workflow.js";

const proposal = (version: number): DiscussEntry => ({
  id: `p${version}`,
  at: "",
  from: "author",
  kind: "proposal",
  body: "note",
  proposal: `v${version}`,
  version,
});
const verdict = (version: number, decision: "agree" | "revise"): DiscussEntry => ({
  id: `v${version}`,
  at: "",
  from: "critic",
  kind: "verdict",
  body: "body",
  verdict: decision,
  objection: "objection",
  version,
});
const draft: DiscussEntry = {
  id: "d",
  at: "",
  from: "critic",
  kind: "draft",
  body: "note",
  proposal: "own",
};
const failure: DiscussEntry = { id: "f", at: "", from: "relay", kind: "failure", body: "x" };

test("normal order alternates Author and Critic until agreement", () => {
  const data = { blind: false, maxRounds: 5 };

  assert.deepEqual(nextStep(data, []), { kind: "turn", role: "author", mode: "propose" });
  assert.deepEqual(nextStep(data, [proposal(1)]), {
    kind: "turn",
    role: "critic",
    mode: "verdict",
  });
  assert.deepEqual(nextStep(data, [proposal(1), verdict(1, "revise")]), {
    kind: "turn",
    role: "author",
    mode: "propose",
  });

  const entries = [proposal(1), verdict(1, "revise"), proposal(2), verdict(2, "agree")];
  assert.deepEqual(nextStep(data, entries), {
    kind: "agreed",
    proposal: entries[2],
    verdict: entries[3],
    rounds: 2,
  });
});

test("blind order puts a Critic draft before the first verdict, outside the round count", () => {
  const data = { blind: true, maxRounds: 1 };

  assert.deepEqual(nextStep(data, [proposal(1)]), { kind: "turn", role: "critic", mode: "draft" });
  assert.deepEqual(nextStep(data, [proposal(1), draft]), {
    kind: "turn",
    role: "critic",
    mode: "verdict",
  });
  assert.equal(nextStep(data, [proposal(1), draft, verdict(1, "revise")]).kind, "capped");
});

test("the cap ends the Discussion, and agreement on the last round still wins", () => {
  const data = { blind: false, maxRounds: 2 };
  const revised = [proposal(1), verdict(1, "revise"), proposal(2)];

  assert.deepEqual(nextStep(data, [...revised, verdict(2, "revise")]), {
    kind: "capped",
    proposal: revised[2],
    verdict: verdict(2, "revise"),
    rounds: 2,
  });
  assert.equal(nextStep(data, [...revised, verdict(2, "agree")]).kind, "agreed");
});

test("agreement with an older version does not end the Discussion; failures are ignored", () => {
  const data = { blind: false, maxRounds: 5 };

  assert.deepEqual(nextStep(data, [proposal(1), proposal(2), verdict(1, "agree")]), {
    kind: "turn",
    role: "critic",
    mode: "verdict",
  });
  assert.deepEqual(nextStep(data, [proposal(1), failure]), {
    kind: "turn",
    role: "critic",
    mode: "verdict",
  });
});

test("validators reject extra keys, empty text, and unknown verdicts", () => {
  assert.equal(validProposal({ proposal: "p", body: "" }), true);
  assert.equal(validProposal({ proposal: " ", body: "b" }), false);
  assert.equal(validProposal({ proposal: "p", body: "b", extra: 1 }), false);
  assert.equal(validProposal({ proposal: "p" }), false);
  assert.equal(validProposal(null), false);

  assert.equal(validVerdict({ verdict: "agree", objection: "o", body: "" }), true);
  assert.equal(validVerdict({ verdict: "maybe", objection: "o", body: "b" }), false);
  assert.equal(validVerdict({ verdict: "agree", objection: "", body: "b" }), false);
  assert.equal(validVerdict({ verdict: "agree", objection: "o", body: "b", x: 1 }), false);
  assert.equal(validVerdict([]), false);
});
