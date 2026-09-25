import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { Handoff } from "./handoff.js";
import type { Harness, TurnRequest, TurnResult } from "./harness/types.js";
import { isReply, type Role } from "./message.js";
import { runRelay, type RelayUI } from "./relay.js";
import { RunStore } from "./run-store.js";
import { message, participants, tempDir } from "./test-support.js";
import { ROUND_CAP } from "./workflow/plan.js";

const plan = { kind: "request", body: "Review this", plan: "# Full plan" };
const approve = { kind: "approve", body: "Looks good" };
function harness(
  replies: unknown[],
  turns: TurnRequest[],
  inspect?: (request: TurnRequest, n: number) => void
): Harness {
  return {
    id: "claude",
    async runTurn(req) {
      turns.push(req);
      inspect?.(req, turns.length);
      const output = replies.shift();
      if (output instanceof Error) throw output;
      return { sessionId: req.sessionId ?? `session-${req.model}`, exitCode: 0, output };
    },
  };
}
function ui(overrides: Partial<RelayUI> = {}): RelayUI {
  return {
    async phaseGate() {
      return { kind: "approve" };
    },
    async failureGate() {
      assert.fail("Unexpected Failure Gate");
    },
    async *interjections() {},
    log() {},
    ...overrides,
  };
}
function runWith(
  run: RunStore,
  fake: Harness,
  interaction = ui(),
  handoff: (input: Handoff) => Promise<void> = async () => {}
) {
  return runRelay({
    run,
    participants: run.data.participants,
    harnesses: { claude: fake, codex: fake },
    ui: interaction,
    handoff,
  });
}
test("happy path persists sessions, writes plan before message, and delivers queued messages once", async (t) => {
  const root = tempDir(t);
  const run = RunStore.create({ task: "task", participants, reviewRoundCap: ROUND_CAP }, root);
  const turns: TurnRequest[] = [];
  const originalAppend = run.append.bind(run);
  run.append = (item) => {
    if (item.kind === "request") assert.equal(readFileSync(run.planPath, "utf8"), item.plan);
    originalAppend(item);
  };
  const fake = harness([plan, { kind: "feedback", body: "Improve tests" }, plan, approve], turns);
  assert.equal(await runWith(run, fake), "handed-off");
  assert.equal(turns.length, 4);
  assert.equal(turns[2]?.sessionId, "session-planner-model");
  assert.equal(turns[3]?.sessionId, "session-reviewer-model");
  assert.match(turns[2]!.prompt, /Improve tests/);
  assert.ok(turns.every((turn) => turn.permission === "read-only"));
  assert.ok(turns.every((turn) => !turn.rolePrompt.includes("undefined")));
  const opened = RunStore.open(run.data.id, root);
  const sessionRoles = opened
    .entries()
    .filter(isReply)
    .map((reply) => reply.from);
  assert.deepEqual([...new Set(sessionRoles)].sort(), ["planner", "reviewer"]);
  assert.equal(opened.entries().at(-1)?.kind, "handoff");
});
test("interjections during a Turn wait for the next Envelope and inactive Roles are rejected", async (t) => {
  const run = RunStore.create(
    { task: "task", participants, reviewRoundCap: ROUND_CAP },
    tempDir(t)
  );
  const turns: TurnRequest[] = [];
  let reader = 0;
  const logs: string[] = [];
  const interaction = ui({
    log: (line) => logs.push(line),
    async *interjections() {
      if (++reader === 1) {
        yield { role: "planner", body: "Human note" };
        yield { role: "implementer" as Role, body: "Reject this" };
      }
    },
  });
  const fake = harness([plan, { kind: "feedback", body: "revise" }, plan, approve], turns);
  const delayed: Harness = {
    id: "claude",
    async runTurn(req) {
      await new Promise((resolve) => setImmediate(resolve));
      return fake.runTurn(req);
    },
  };
  assert.equal(await runWith(run, delayed, interaction), "handed-off");
  assert.doesNotMatch(turns[0]!.prompt, /Human note/);
  assert.match(turns[2]!.prompt, /Human note/);
  assert.ok(logs.some((line) => /Cannot address implementer/.test(line)));
  assert.ok(!run.entries().some((item) => item.body === "Reject this"));
});
test("one schema failure retries automatically; a second requires a Human retry with a note", async (t) => {
  for (const badCount of [1, 2]) {
    const run = RunStore.create(
      { task: "task", participants, reviewRoundCap: ROUND_CAP },
      tempDir(t)
    );
    const turns: TurnRequest[] = [];
    let gates = 0;
    const fake = harness([...Array(badCount).fill({ kind: "invalid" }), plan, approve], turns);
    const interaction = ui({
      async failureGate(state) {
        gates++;
        assert.equal(state.failure?.attempts, 2);
        return { kind: "retry", body: "Use the complete schema" };
      },
    });
    assert.equal(await runWith(run, fake, interaction), "handed-off");
    assert.equal(gates, badCount - 1);
    assert.equal(
      run.entries().filter((item) => item.from === "relay" && item.kind === "retry").length,
      1
    );
    assert.match(turns[1]!.prompt, /Reply failed/);
    if (badCount === 2) assert.match(turns[2]!.prompt, /Use the complete schema/);
  }
});
test("harness exit, explicit error, and thrown errors go straight to Failure Gate", async (t) => {
  for (const failure of [
    { exitCode: 2 },
    { exitCode: 0, error: "denied" },
    new Error("spawn failed"),
  ]) {
    const run = RunStore.create(
      { task: "task", participants, reviewRoundCap: ROUND_CAP },
      tempDir(t)
    );
    let calls = 0;
    const fake: Harness = {
      id: "claude",
      async runTurn() {
        calls++;
        if (failure instanceof Error) throw failure;
        return { sessionId: "s", ...failure } as TurnResult;
      },
    };
    const interaction = ui({
      async failureGate() {
        return { kind: "abort" };
      },
    });
    assert.equal(await runWith(run, fake, interaction), "aborted");
    assert.equal(calls, 1);
    assert.equal(run.entries().filter((item) => item.kind === "retry").length, 0);
  }
});
test("resume runs only the interrupted pending Role and restores Plan from the log", async (t) => {
  const root = tempDir(t);
  const run = RunStore.create(
    { task: "task", participants, reviewRoundCap: ROUND_CAP },
    root,
    root
  );
  run.append(
    message("planner", "request", "reviewer", {
      plan: "# Committed plan",
      completion: { sessionId: "planner-session", delivered: [] },
    })
  );
  run.nextTurnDir(); // Raw files may exist for an uncommitted Turn.
  run.writePlan("Uncommitted replacement");
  const turns: TurnRequest[] = [];
  const fake = harness([approve], turns, (req) => {
    assert.equal(readFileSync(run.planPath, "utf8"), "# Committed plan");
    assert.equal(req.cwd, root);
  });
  assert.equal(await runWith(RunStore.open(run.data.id, root), fake), "handed-off");
  assert.equal(turns[0]?.model, "reviewer-model");
  assert.match(turns[0]!.turnDir, /02$/);
  assert.equal(turns.length, 1);
});
test("resume lands on the same Failure Gate without launching a Turn", async (t) => {
  const root = tempDir(t);
  const run = RunStore.create({ task: "task", participants, reviewRoundCap: ROUND_CAP }, root);
  run.append(
    message("relay", "failure", "run", { role: "planner", reason: "exit", body: "no access" })
  );
  const fake: Harness = {
    id: "claude",
    async runTurn() {
      assert.fail("No Turn expected");
    },
  };
  assert.equal(
    await runWith(
      RunStore.open(run.data.id, root),
      fake,
      ui({
        async failureGate(state) {
          assert.equal(state.failure?.body, "no access");
          return { kind: "abort" };
        },
      })
    ),
    "aborted"
  );
});
test("completed replies in the log decide delivery and sessions, preventing redelivery after a crash", async (t) => {
  const root = tempDir(t);
  const run = RunStore.create({ task: "task", participants, reviewRoundCap: ROUND_CAP }, root);
  run.append(message("human", "feedback", "planner", { id: "note", body: "Already delivered" }));
  run.append(
    message("planner", "request", "reviewer", {
      id: "plan1",
      plan: "plan",
      completion: { sessionId: "s", delivered: ["note"] },
    })
  );
  run.append(
    message("reviewer", "feedback", "planner", {
      id: "review",
      body: "New feedback",
      completion: { sessionId: "r", delivered: ["plan1"] },
    })
  );
  const turns: TurnRequest[] = [];
  assert.equal(
    await runWith(RunStore.open(run.data.id, root), harness([plan, approve], turns)),
    "handed-off"
  );
  assert.doesNotMatch(turns[0]!.prompt, /Already delivered/);
  assert.match(turns[0]!.prompt, /New feedback/);
  assert.equal(turns[0]?.sessionId, "s");
});
test("interjection input is cancelled before opening a Gate", async (t) => {
  const run = RunStore.create(
    { task: "task", participants, reviewRoundCap: ROUND_CAP },
    tempDir(t)
  );
  let closed = 0;
  const interaction = ui({
    async *interjections(signal) {
      await new Promise<void>((resolve) =>
        signal!.addEventListener("abort", () => resolve(), { once: true })
      );
      closed++;
    },
    async phaseGate() {
      assert.equal(closed, 2);
      return { kind: "abort" };
    },
  });
  assert.equal(await runWith(run, harness([plan, approve], []), interaction), "aborted");
});

test("an interrupted Turn remains pending and releases the Run lock", async (t) => {
  const { TurnInterrupted } = await import("./harness/spawn.js");
  const run = RunStore.create(
    { task: "task", participants, reviewRoundCap: ROUND_CAP },
    tempDir(t)
  );
  const fake: Harness = {
    id: "claude",
    async runTurn() {
      throw new TurnInterrupted("interrupted");
    },
  };
  await assert.rejects(runWith(run, fake), /interrupted/);
  assert.deepEqual(run.entries(), []);
  run.acquire()();
});

test("approval snapshots edits, failed handoff resumes without Turns, and success is terminal", async (t) => {
  const root = tempDir(t);
  const run = RunStore.create(
    { task: "Original task", participants, reviewRoundCap: ROUND_CAP },
    root
  );
  const turns: TurnRequest[] = [];
  const fake = harness([plan, approve], turns);
  const gate = ui({
    async phaseGate() {
      run.writePlan("# Human-edited approved plan");
      return { kind: "approve" };
    },
  });
  await assert.rejects(
    runWith(run, fake, gate, async (input) => {
      assert.match(readFileSync(input.handoffPath, "utf8"), /# Human-edited approved plan/);
      throw new Error("No desktop app");
    }),
    /larp plan resume/
  );
  assert.equal(turns.length, 2);
  const approval = run.entries().at(-1);
  assert.equal(
    approval?.from === "human" && approval.kind === "approve" && approval.plan,
    "# Human-edited approved plan"
  );
  run.writePlan("unapproved modification");
  let opens = 0;
  const resumed = RunStore.open(run.data.id, root);
  assert.equal(
    await runWith(resumed, fake, ui(), async (input) => {
      opens++;
      assert.match(readFileSync(input.handoffPath, "utf8"), /Original task/);
      assert.match(readFileSync(input.handoffPath, "utf8"), /# Human-edited approved plan/);
      assert.doesNotMatch(readFileSync(input.handoffPath, "utf8"), /unapproved modification/);
    }),
    "handed-off"
  );
  assert.equal(turns.length, 2);
  assert.equal(
    await runWith(RunStore.open(run.data.id, root), fake, ui(), async () => {
      opens++;
    }),
    "handed-off"
  );
  assert.equal(opens, 1);
});

test("completed legacy implementation Runs do not open a new task", async (t) => {
  const run = RunStore.create(
    { task: "task", participants, reviewRoundCap: ROUND_CAP },
    tempDir(t)
  );
  run.append(message("planner", "request", "reviewer", { plan: "plan" }));
  run.append(message("reviewer", "approve", "planner"));
  run.append(message("human", "approve", "run"));
  run.append(message("implementer", "done", "human"));
  assert.equal(
    await runWith(run, harness([], []), ui(), async () => assert.fail("Already complete")),
    "done"
  );
});

test("legacy Runs retain their original three-round cap during replay", async (t) => {
  const run = RunStore.create(
    { task: "old task", participants, reviewRoundCap: ROUND_CAP },
    tempDir(t)
  );
  delete run.data.reviewRoundCap;
  for (let round = 0; round < 3; round++) {
    run.append(message("planner", "request", "reviewer", { id: `plan-${round}`, plan: "plan" }));
    run.append(message("reviewer", "feedback", "planner", { body: "revise" }));
  }
  let gates = 0;
  assert.equal(
    await runWith(
      run,
      harness([], []),
      ui({
        async phaseGate(state) {
          gates++;
          assert.equal(state.round, 3);
          return { kind: "abort" };
        },
      })
    ),
    "aborted"
  );
  assert.equal(gates, 1);
});

test("Role instructions follow the Workflow protocol, and permission stays read-only", async (t) => {
  const run = RunStore.create(
    {
      task: "task",
      participants: {
        ...participants,
        reviewer: { ...participants.reviewer, instructions: "Focus on migrations." },
      },
      reviewRoundCap: ROUND_CAP,
    },
    tempDir(t)
  );
  const turns: TurnRequest[] = [];
  assert.equal(await runWith(run, harness([plan, approve], turns)), "handed-off");
  assert.doesNotMatch(turns[0]!.rolePrompt, /Focus on migrations/);
  assert.match(turns[1]!.rolePrompt, /You are Reviewer[\s\S]*\n\nFocus on migrations\.$/);
  assert.equal(turns[1]!.permission, "read-only");
});
