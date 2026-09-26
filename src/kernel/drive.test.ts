import assert from "node:assert/strict";
import test from "node:test";

import type { Participant } from "../config.js";
import { TurnInterrupted } from "../harness/spawn.js";
import type { TurnOutcome } from "../harness/turn.js";
import type { Harness, TurnRequest, TurnResult } from "../harness/types.js";
import { drive } from "./drive.js";
import type { Step, TurnSpec, Workflow, WorkflowLog } from "./types.js";

type Entry = { key: string; kind: "reply" | "failure" | "note"; turnDir?: string };

const participant: Participant = { harness: "codex", model: "m", effort: "high", extraArgs: [] };

/** An in-memory log whose lock is free unless `heldBy` is set. */
function memoryLog(entries: Entry[] = []) {
  const state = { entries, held: false, heldBy: undefined as number | undefined, dirs: 0 };
  const log: WorkflowLog<Entry> = {
    entries: () => [...state.entries],
    tryAcquire() {
      if (state.heldBy !== undefined) return { heldBy: state.heldBy };
      state.held = true;
      return { release: () => (state.held = false) };
    },
    nextTurnDir: () => `/turns/${++state.dirs}`,
  };

  return { log, state };
}

function spec(key: string): TurnSpec<string> {
  return {
    key,
    participant,
    cwd: "/work",
    permission: "read-only",
    rolePrompt: "role",
    prompt: key,
    delivered: [],
    detail: undefined,
  };
}

/** A harness whose Turns end only when the test settles them, keyed by prompt. */
function controlledHarness() {
  const pending = new Map<string, (result: TurnResult | Error) => void>();
  const started: string[] = [];
  let running = 0;
  let maxRunning = 0;
  const harness: Harness = {
    id: "codex",
    runTurn(req: TurnRequest) {
      started.push(req.prompt);
      maxRunning = Math.max(maxRunning, ++running);

      return new Promise<TurnResult>((resolve, reject) => {
        pending.set(req.prompt, (result) => {
          running--;
          pending.delete(req.prompt);
          if (result instanceof Error) reject(result);
          else resolve(result);
        });
      });
    },
  };
  // Settle one Turn, then let the driver react before the test settles another.
  const settle = async (key: string, result: TurnResult | Error = ok()) => {
    while (!pending.has(key)) await tick();
    pending.get(key)!(result);
    await tick();
  };

  return { harnesses: { claude: harness, codex: harness }, started, settle, max: () => maxRunning };
}

function tick(): Promise<void> {
  return new Promise((done) => setImmediate(done));
}

function ok(): TurnResult {
  return { sessionId: "s", exitCode: 0, output: "reply" };
}

/** Each key replies once; `stopOnFailure` ends the run as soon as any Turn failed. */
function sweep(
  keys: string[],
  log: { state: { entries: Entry[] } },
  overrides: Partial<Workflow<Entry, string, undefined, string, string[]>> = {},
  stopOnFailure = false
): Workflow<Entry, string, undefined, string, string[]> {
  return {
    next(entries): Step<string, undefined, string, string[]> {
      const settled = new Set(entries.filter((e) => e.kind !== "note").map((e) => e.key));
      const replies = entries.filter((e) => e.kind === "reply").map((e) => e.key);

      if (stopOnFailure && entries.some((e) => e.kind === "failure"))
        return { kind: "done", outcome: replies };

      const pending = keys.filter((key) => !settled.has(key));

      return pending.length
        ? { kind: "turns", turns: pending.map(spec) }
        : { kind: "done", outcome: replies };
    },
    commit(turn, outcome: TurnOutcome, _entries, turnDir) {
      log.state.entries.push({
        key: turn.key,
        kind: outcome.ok ? "reply" : "failure",
        ...(turnDir ? { turnDir } : {}),
      });
    },
    ...overrides,
  };
}

test("parallel Turns stay within the limit and never share a key", async () => {
  const memory = memoryLog();
  const harness = controlledHarness();
  const run = drive(memory.log, sweep(["a", "b", "c"], memory), { ...harness, parallel: 2 });

  await harness.settle("a");
  await harness.settle("b");
  await harness.settle("c");

  assert.deepEqual(await run, { status: "done", outcome: ["a", "b", "c"] });
  assert.equal(harness.max(), 2);
  assert.deepEqual(harness.started, ["a", "b", "c"]);
  assert.equal(memory.state.held, false);
});

test("a step that ends the run while a Turn is in flight is decided again after it commits", async () => {
  const memory = memoryLog();
  const harness = controlledHarness();
  const run = drive(memory.log, sweep(["a", "b"], memory, {}, true), { ...harness, parallel: 2 });

  await harness.settle("a", { sessionId: "s", exitCode: 1 });
  await harness.settle("b");

  assert.deepEqual(await run, { status: "done", outcome: ["b"] });
});

test("an action waits for every Turn in flight", async () => {
  const memory = memoryLog();
  const harness = controlledHarness();
  const acted: Entry[][] = [];
  const base = sweep(["a", "b"], memory);
  const workflow = sweep(["a", "b"], memory, {
    next(entries, context) {
      if (entries.some((e) => e.key === "a") && !entries.some((e) => e.kind === "note"))
        return { kind: "act", action: "gate" };
      return base.next(entries, context);
    },
    async act(_action, entries) {
      acted.push(entries);
      memory.state.entries.push({ key: "gate", kind: "note" });
    },
  });
  const run = drive(memory.log, workflow, { ...harness, parallel: 2 });

  await harness.settle("a");
  await harness.settle("b");
  await run;

  assert.deepEqual(
    acted[0]!.map((e) => e.key),
    ["a", "b"]
  );
});

test("a held lock starts nothing and skips begin", async () => {
  const memory = memoryLog();
  const harness = controlledHarness();
  let begun = false;

  memory.state.heldBy = 42;

  const result = await drive(
    memory.log,
    sweep(["a"], memory, {
      begin() {
        begun = true;
      },
    }),
    harness
  );

  assert.deepEqual(result, { status: "held", heldBy: 42 });
  assert.equal(begun, false);
  assert.deepEqual(harness.started, []);
});

test("an interrupted Turn commits nothing, while its parallel Turn still commits", async () => {
  const memory = memoryLog();
  const harness = controlledHarness();
  const run = drive(memory.log, sweep(["a", "b", "c"], memory), { ...harness, parallel: 2 });
  const rejected = assert.rejects(run, TurnInterrupted);

  await harness.settle("a", new TurnInterrupted("SIGINT"));
  await harness.settle("b");

  await rejected;
  assert.deepEqual(memory.state.entries, [{ key: "b", kind: "reply", turnDir: "/turns/2" }]);
  assert.deepEqual(harness.started, ["a", "b"]);
  assert.equal(memory.state.held, false);
});

test("a commit that throws starts no new Turn, and Turns in flight still commit", async () => {
  const memory = memoryLog();
  const harness = controlledHarness();
  const base = sweep(["a", "b", "c"], memory);
  const workflow = sweep(["a", "b", "c"], memory, {
    commit(turn, outcome, entries, turnDir) {
      base.commit(turn, outcome, entries, turnDir);
      if (turn.key === "a") throw new Error("stop");
    },
  });
  const run = drive(memory.log, workflow, { ...harness, parallel: 2 });
  const rejected = assert.rejects(run, /stop/);

  await harness.settle("a");
  await harness.settle("b");

  await rejected;
  assert.deepEqual(
    memory.state.entries.map((e) => e.key),
    ["a", "b"]
  );
  assert.deepEqual(harness.started, ["a", "b"]);
});

test("begin runs under the lock, and resumedAt counts the entries it appended", async () => {
  const memory = memoryLog([{ key: "old", kind: "note" }]);
  const harness = controlledHarness();
  let resumedAt: number | undefined;
  const base = sweep([], memory);
  const workflow = sweep([], memory, {
    begin() {
      assert.equal(memory.state.held, true);
      memory.state.entries.push({ key: "followup", kind: "note" });
    },
    next(entries, context) {
      resumedAt = context.resumedAt;
      return base.next(entries, context);
    },
  });

  await drive(memory.log, workflow, harness);

  assert.equal(resumedAt, 2);
});

test("alongside work stops and is awaited before an action, and its error follows the commits", async () => {
  const memory = memoryLog();
  const harness = controlledHarness();
  const events: string[] = [];
  const base = sweep(["a"], memory);
  const workflow = sweep(["a"], memory, {
    next(entries, context) {
      if (entries.length === 1) return { kind: "act", action: "gate" };
      return base.next(entries, context);
    },
    async act() {
      events.push("act");
      memory.state.entries.push({ key: "gate", kind: "note" });
    },
    async alongsideTurns(signal) {
      await new Promise((done) => signal.addEventListener("abort", done));
      await tick();
      events.push("alongside finished");
      throw new Error("input closed");
    },
  });
  const run = drive(memory.log, workflow, harness);
  const rejected = assert.rejects(run, /input closed/);

  await harness.settle("a");

  await rejected;
  assert.deepEqual(events, ["alongside finished"]);
  assert.deepEqual(
    memory.state.entries.map((e) => e.key),
    ["a"]
  );
});

test("commit gets the Turn directory, or none when the Turn could not allocate one", async () => {
  const memory = memoryLog();
  const harness = controlledHarness();

  memory.log.nextTurnDir = () => {
    throw new Error("disk full");
  };

  const result = await drive(memory.log, sweep(["a"], memory), harness);

  assert.deepEqual(result, { status: "done", outcome: [] });
  assert.deepEqual(memory.state.entries, [{ key: "a", kind: "failure" }]);
  assert.deepEqual(harness.started, []);
});

test("an error from next waits for Turns in flight before the lock is released", async () => {
  const memory = memoryLog();
  const harness = controlledHarness();
  const base = sweep(["a", "b"], memory);
  const workflow = sweep(["a", "b"], memory, {
    next(entries, context) {
      if (entries.length === 1) throw new Error("bad log");
      return base.next(entries, context);
    },
  });
  const run = drive(memory.log, workflow, { ...harness, parallel: 2 });
  const rejected = assert.rejects(run, /bad log/);

  await harness.settle("a");
  assert.equal(memory.state.held, true, "the lock stays held while b runs");

  await harness.settle("b");
  await rejected;

  assert.deepEqual(
    memory.state.entries.map((e) => e.key),
    ["a", "b"]
  );
  assert.equal(memory.state.held, false);
});

test("a display callback error before the first Turn still stops alongside work", async () => {
  const memory = memoryLog();
  const harness = controlledHarness();
  const workflow = sweep(["a"], memory, {
    alongsideTurns: (signal) =>
      new Promise((done) => signal.addEventListener("abort", () => done())),
  });

  await assert.rejects(
    drive(memory.log, workflow, {
      ...harness,
      startTurn() {
        throw new Error("display failed");
      },
    }),
    /display failed/
  );
  assert.equal(memory.state.held, false);
});

test("alongside work finishes before the next action starts", async () => {
  const memory = memoryLog();
  const harness = controlledHarness();
  const events: string[] = [];
  const base = sweep(["a"], memory);
  const workflow = sweep(["a"], memory, {
    next(entries, context) {
      if (entries.length === 1) return { kind: "act", action: "gate" };
      return base.next(entries, context);
    },
    async act() {
      events.push("act");
      memory.state.entries.push({ key: "gate", kind: "note" });
    },
    async alongsideTurns(signal) {
      await new Promise((done) => signal.addEventListener("abort", done));
      await tick();
      events.push("alongside finished");
    },
  });
  const run = drive(memory.log, workflow, harness);

  await harness.settle("a");
  await run;

  assert.deepEqual(events, ["alongside finished", "act"]);
});
