import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { TurnInterrupted } from "../harness/spawn.js";
import type { Harness, TurnRequest, TurnResult } from "../harness/types.js";
import { clearTurnProcess, recordTurnProcess } from "../store.js";
import { participants, tempDir } from "../test-support.js";
import { runSwarm } from "./run.js";
import { SwarmStore } from "./store.js";

const document = {
  version: 1 as const,
  task: "Sweep",
  chunks: ["a", "b", "c", "d"].map((id) => ({ id, paths: [id], focus: `Review ${id}` })),
};

function fake(run: (req: TurnRequest) => Promise<TurnResult>): Record<"claude" | "codex", Harness> {
  return { claude: { id: "claude", runTurn: run }, codex: { id: "codex", runTurn: run } };
}

function key(req: TurnRequest): string {
  return JSON.parse(req.prompt.split("Chunk:\n")[1]!.split("\n\nReturn")[0]!).id;
}

const ok = (output: unknown): TurnResult => ({ sessionId: "session", exitCode: 0, output });

test("swarm fills slots, isolates failure, snapshots input, and resumes only unfinished chunks", async (t) => {
  const root = tempDir(t);
  const input = structuredClone(document);
  const participant = { ...participants.planner, instructions: "Style guidance", web: false };
  const store = SwarmStore.createExecution(
    { document: input, role: "style", participant, parallel: 2 },
    root,
    root
  );
  input.task = "Changed";
  participant.instructions = "Changed";
  let active = 0;
  let max = 0;
  const requests: TurnRequest[] = [];
  const pending = new Map<string, (result: TurnResult) => void>();
  const harnesses = fake(async (req) => {
    requests.push(req);
    max = Math.max(max, ++active);
    const result = await new Promise<TurnResult>((resolve) => pending.set(key(req), resolve));
    active--;
    return result;
  });
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const running = runSwarm(store, harnesses);
  await tick();
  assert.deepEqual([...pending.keys()], ["a", "b"]);
  pending.get("b")!(ok("No findings"));
  await tick();
  assert.deepEqual([...pending.keys()], ["a", "b", "c"]);
  pending.get("a")!({ sessionId: "s", exitCode: 1, error: "rate limit" });
  await tick();
  pending.get("c")!(ok("# C"));
  pending.get("d")!(ok("# D"));
  assert.deepEqual(await running, { kind: "execution", complete: 3, total: 4, failed: ["a"] });
  assert.equal(max, 2);
  for (const req of requests) {
    assert.equal(req.permission, "read-only");
    assert.equal(req.cwd, root);
    assert.equal(req.schema, undefined);
    assert.equal(req.sessionId, undefined);
    assert.match(req.prompt, /Task:\nSweep/);
    assert.match(req.rolePrompt, /Style guidance/);
  }
  const retried: string[] = [];
  const resume = await runSwarm(
    SwarmStore.open(store.data.id, root),
    fake(async (req) => {
      retried.push(key(req));
      assert.equal(req.sessionId, undefined);
      return ok("# A");
    })
  );
  assert.deepEqual(retried, ["a"]);
  assert.equal(resume.kind === "execution" && resume.complete, 4);
  rmSync(join(store.outputPath, "b.md"));
  await runSwarm(
    store,
    fake(async () => {
      throw new Error("must not run");
    })
  );
  assert.equal(readFileSync(join(store.outputPath, "b.md"), "utf8"), "No findings\n");
});

test("draft uses Role context, validates output, preserves caller task and user edits", async (t) => {
  const root = tempDir(t);
  const store = SwarmStore.createDraft(
    {
      task: "Original",
      participant: participants.planner,
      roleContext: {
        name: "style",
        description: "Style review",
        instructions: "Use local conventions",
      },
    },
    root,
    root
  );
  await assert.rejects(
    runSwarm(
      store,
      fake(async () => ok({ ...document, chunks: [] }))
    ),
    /Invalid chunk reply.*chunks[\s\S]*swarm resume/
  );
  await runSwarm(
    store,
    fake(async (req) => {
      assert.equal(req.permission, "read-only");
      assert.ok(req.schema);
      assert.match(req.prompt, /Use local conventions/);
      assert.match(req.rolePrompt, /You split tasks/);
      return ok(document);
    })
  );
  assert.equal(JSON.parse(readFileSync(store.chunksPath, "utf8")).task, "Original");
  writeFileSync(store.chunksPath, "user edits");
  await runSwarm(
    store,
    fake(async () => {
      throw new Error("must not run");
    })
  );
  assert.equal(readFileSync(store.chunksPath, "utf8"), "user edits");
  rmSync(store.chunksPath);
  await runSwarm(
    store,
    fake(async () => {
      throw new Error("must not run");
    })
  );
  assert.equal(JSON.parse(readFileSync(store.chunksPath, "utf8")).task, "Original");
});

test("export failure leaves a committed reply and resume exports without another Turn", async (t) => {
  const root = tempDir(t);
  const store = SwarmStore.createExecution(
    {
      document: { ...document, chunks: document.chunks.slice(0, 1) },
      role: "style",
      participant: participants.planner,
      parallel: 1,
    },
    root,
    root
  );
  mkdirSync(join(store.outputPath, "a.md"));
  await assert.rejects(
    runSwarm(
      store,
      fake(async () => ok("Saved report"))
    ),
    /regular file/
  );
  assert.equal(store.entries()[0]!.kind, "reply");
  rmSync(join(store.outputPath, "a.md"), { recursive: true });
  await runSwarm(
    store,
    fake(async () => {
      throw new Error("must not run");
    })
  );
  assert.equal(readFileSync(join(store.outputPath, "a.md"), "utf8"), "Saved report\n");
});

test("interruptions preserve settled peers and stop new scheduling", async (t) => {
  const root = tempDir(t);
  const store = SwarmStore.createExecution(
    { document, role: "style", participant: participants.planner, parallel: 2 },
    root,
    root
  );
  const started: string[] = [];
  await assert.rejects(
    runSwarm(
      store,
      fake(async (req) => {
        started.push(key(req));
        if (key(req) === "a") throw new TurnInterrupted("stop");
        return ok("Peer completed");
      })
    ),
    /interrupted.*\nResume/
  );
  assert.deepEqual(started, ["a", "b"]);
  assert.deepEqual(
    store.entries().map((entry) => entry.key),
    ["b"]
  );
});

test("empty replies fail once per invocation, and held locks launch nothing", async (t) => {
  const root = tempDir(t);
  const store = SwarmStore.createExecution(
    { document, role: "style", participant: participants.planner, parallel: 3 },
    root,
    root
  );
  let calls = 0;
  const harnesses = fake(async () => {
    calls++;
    return ok(" ");
  });
  const lock = store.tryAcquire();
  assert.ok("release" in lock);
  await assert.rejects(runSwarm(store, harnesses), /running in process/);
  assert.equal(calls, 0);
  lock.release();
  const result = await runSwarm(store, harnesses);
  assert.equal(result.kind === "execution" && result.complete, 0);
  assert.equal(calls, 4);
});

test("custom outputs are exclusive and refuse symlink exports and directory replacements", async (t) => {
  const root = tempDir(t);
  const out = join(root, "reports");
  const create = () =>
    SwarmStore.createExecution(
      { document, role: "style", participant: participants.planner, parallel: 1, out },
      root,
      root
    );
  const store = create();
  assert.throws(create, /EEXIST/);
  const outside = join(root, "outside");
  writeFileSync(outside, "untouched");
  symlinkSync(outside, join(out, "a.md"));
  await assert.rejects(
    runSwarm(
      store,
      fake(async () => ok("overwrite"))
    ),
    /regular file/
  );
  assert.equal(readFileSync(outside, "utf8"), "untouched");
  rmSync(out, { recursive: true });
  symlinkSync(root, out, "dir");
  await assert.rejects(
    runSwarm(
      store,
      fake(async () => ok("overwrite"))
    ),
    /real directory/
  );
});

test("surviving Harness records block resume and successful Codex chunks use read-only requests", async (t) => {
  const root = tempDir(t);
  const store = SwarmStore.createExecution(
    {
      document: { ...document, chunks: document.chunks.slice(0, 1) },
      role: "style",
      participant: { ...participants.planner, harness: "codex" },
      parallel: 1,
    },
    root,
    root
  );
  const dir = store.nextTurnDir();
  recordTurnProcess(dir, process.pid);
  let called = false;
  const harnesses = fake(async (req) => {
    called = true;
    assert.equal(req.permission, "read-only");
    return ok("No issues");
  });
  await assert.rejects(runSwarm(store, harnesses), /earlier Turn is still running/);
  assert.equal(called, false);
  clearTurnProcess(dir);
  await runSwarm(store, harnesses);
  assert.equal(called, true);
});
