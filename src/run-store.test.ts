import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { listRuns, RunStore } from "./run-store.js";
import { message, participants, tempDir } from "./test-support.js";
import { ROUND_CAP } from "./workflow/plan.js";

test("Run store round trip keeps only identity in metadata", (t) => {
  const root = tempDir(t);
  const run = RunStore.create(
    { task: "task", participants, reviewRoundCap: ROUND_CAP },
    root,
    root
  );
  run.writePlan("plan");
  const reply = message("planner", "request", "reviewer", {
    plan: "plan",
    completion: { sessionId: "new-session", delivered: ["m1"] },
  });
  run.append(reply);
  const recovered = RunStore.open(run.data.id, root);
  assert.deepEqual(recovered.entries(), [reply]);
  assert.deepEqual(recovered.data, run.data);
  assert.equal(recovered.data.reviewRoundCap, ROUND_CAP);
  assert.equal(readFileSync(run.planPath, "utf8"), "plan");
  assert.match(run.nextTurnDir(), /01$/);
  assert.match(run.nextTurnDir(), /02$/);
  assert.equal(listRuns(root)[0]?.task, "task");
  assert.throws(() => RunStore.open("../outside", root), /Invalid/);
  assert.throws(() => RunStore.open("missing", root), /No Run missing/);
});
test("torn trailing append is removed before the next complete entry", (t) => {
  const root = tempDir(t);
  const run = RunStore.create({ task: "task", participants, reviewRoundCap: ROUND_CAP }, root);
  const first = message("human", "feedback", "planner");
  run.append(first);
  appendFileSync(join(run.directory, "messages.jsonl"), '{"id":"torn');
  const recovered = RunStore.open(run.data.id, root);
  assert.deepEqual(recovered.entries(), [first]);
  recovered.append(message("human", "abort", "run"));
  assert.equal(recovered.entries().length, 2);
});
test("only one Relay may acquire a Run", (t) => {
  const run = RunStore.create(
    { task: "task", participants, reviewRoundCap: ROUND_CAP },
    tempDir(t)
  );
  const release = run.acquire();
  assert.throws(() => run.acquire(), /already active/);
  release();
  run.acquire()();
  writeFileSync(join(run.directory, "relay.lock"), "bad");
  assert.throws(() => run.acquire(), /Invalid relay.lock/);
});
