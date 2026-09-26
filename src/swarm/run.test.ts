import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("starting generated chunks keeps the identity, log and Turns and rejects stale draft handles", async (t) => {
  const root = tempDir(t);
  const draft = SwarmStore.createDraft(
    { task: "Sweep", participant: participants.planner },
    root,
    root
  );
  await runSwarm(
    draft,
    fake(async () => ok(document))
  );
  const planned = draft.entries();
  const edited = { ...document, chunks: [{ id: "splitter", paths: ["src/"], focus: "Review" }] };
  writeFileSync(draft.chunksPath, JSON.stringify(edited));
  const execution = SwarmStore.startExecution(
    draft.chunksPath,
    {
      participant: participants.reviewer,
      role: "reviewer",
      parallel: 2,
    },
    root,
    root
  );
  assert.equal(execution.data.id, draft.data.id);
  assert.equal(execution.data.createdAt, draft.data.createdAt);
  assert.equal(execution.outputPath, join(draft.directory, "results"));
  assert.deepEqual(execution.entries(), planned);
  assert.equal(
    execution.data.kind === "execution" && execution.data.participant.model,
    participants.reviewer.model
  );
  await assert.rejects(
    runSwarm(
      draft,
      fake(async () => {
        throw new Error("must not launch");
      })
    ),
    /changed phase/
  );
  const requests: TurnRequest[] = [];
  const result = await runSwarm(
    execution,
    fake(async (req) => {
      requests.push(req);
      return ok("Report");
    })
  );
  assert.equal(result.kind === "execution" && result.complete, 1);
  assert.equal(requests.length, 1);
  assert.notEqual(requests[0]!.turnDir, planned[0]!.turnDir);
  assert.equal(readFileSync(join(execution.outputPath, "splitter.md"), "utf8"), "Report\n");
  rmSync(draft.chunksPath);
  await runSwarm(
    SwarmStore.open(draft.data.id, root),
    fake(async () => {
      throw new Error("must not repeat");
    })
  );
});

test("starting a draft respects locks, validation and output ownership before changing phase", async (t) => {
  const root = tempDir(t);
  const draft = SwarmStore.createDraft(
    { task: "Sweep", participant: participants.planner },
    root,
    root
  );
  await runSwarm(
    draft,
    fake(async () => ok(document))
  );
  const input = {
    participant: participants.reviewer,
    role: "reviewer",
    parallel: 2,
    out: join(root, "custom-results"),
  };
  const start = () => SwarmStore.startExecution(draft.chunksPath, input, root, root);
  const lock = draft.tryAcquire();
  assert.ok("release" in lock);
  try {
    assert.throws(start, /locked/);
  } finally {
    lock.release();
  }
  const turn = draft.nextTurnDir();
  recordTurnProcess(turn, process.pid);
  try {
    assert.throws(start, /Harness|harness/);
  } finally {
    clearTurnProcess(turn);
  }
  writeFileSync(draft.chunksPath, "{}");
  assert.throws(start);
  assert.equal(SwarmStore.open(draft.data.id, root).data.kind, "draft");
  writeFileSync(draft.chunksPath, JSON.stringify(document));
  mkdirSync(input.out);
  writeFileSync(join(input.out, "keep.txt"), "existing");
  assert.throws(start, /not owned/);
  assert.equal(readFileSync(join(input.out, "keep.txt"), "utf8"), "existing");
  assert.equal(SwarmStore.open(draft.data.id, root).data.kind, "draft");
  rmSync(input.out, { recursive: true });
  const execution = start();
  assert.equal(execution.outputPath, realpathSync(input.out));
  assert.throws(start, /already started/);
});

test("copied chunk files create new swarms without changing the source draft", async (t) => {
  const root = tempDir(t);
  const draft = SwarmStore.createDraft(
    { task: "Sweep", participant: participants.planner },
    root,
    root
  );
  await runSwarm(
    draft,
    fake(async () => ok(document))
  );
  const copy = join(root, "copied-chunks.json");
  writeFileSync(copy, readFileSync(draft.chunksPath));
  const execution = SwarmStore.startExecution(
    copy,
    {
      participant: participants.reviewer,
      role: "reviewer",
      parallel: 1,
    },
    root,
    root
  );
  assert.notEqual(execution.data.id, draft.data.id);
  assert.equal(SwarmStore.open(draft.data.id, root).data.kind, "draft");
  assert.equal(execution.outputPath, join(execution.directory, "results"));
});

test("a draft can finish starting after its output was reserved before metadata was saved", async (t) => {
  const root = tempDir(t);
  const draft = SwarmStore.createDraft(
    { task: "Sweep", participant: participants.planner },
    root,
    root
  );
  await runSwarm(
    draft,
    fake(async () => ok(document))
  );
  mkdirSync(draft.outputPath);
  writeFileSync(join(draft.outputPath, ".larp-swarm.json"), JSON.stringify({ id: draft.data.id }));
  const execution = SwarmStore.startExecution(
    draft.chunksPath,
    {
      participant: participants.reviewer,
      role: "reviewer",
      parallel: 1,
    },
    root,
    root
  );
  assert.equal(execution.data.id, draft.data.id);
  assert.equal(SwarmStore.open(draft.data.id, root).data.kind, "execution");
});

for (const harness of ["claude", "codex"] as const) {
  for (const permission of ["read-only", "write"] as const) {
    for (const kind of ["draft", "execution"] as const) {
      test(`${harness} ${kind} uses saved ${permission} Role permission on start and resume`, async (t) => {
        const root = tempDir(t);
        const participant = {
          ...participants.planner,
          harness,
          permission,
          instructions: "Track this task in a temporary file when permitted.",
        };
        const store =
          kind === "draft"
            ? SwarmStore.createDraft({ task: "Sweep", participant }, root, root)
            : SwarmStore.createExecution(
                {
                  document: { ...document, chunks: document.chunks.slice(0, 1) },
                  participant,
                  role: "style",
                  parallel: 1,
                },
                root,
                root
              );
        let attempts = 0;
        const harnesses = fake(async (request) => {
          assert.equal(request.permission, permission);
          assert.match(request.rolePrompt, /Track this task in a temporary file/);
          assert.doesNotMatch(request.rolePrompt, /Never edit files|LARP read-only swarm/);
          if (++attempts === 1) return { sessionId: "s", exitCode: 1, error: "temporary failure" };
          return ok(kind === "draft" ? document : "Report");
        });
        if (kind === "draft") await assert.rejects(runSwarm(store, harnesses), /temporary failure/);
        else assert.equal((await runSwarm(store, harnesses)).kind, "execution");
        participant.permission = permission === "write" ? "read-only" : "write";
        await runSwarm(SwarmStore.open(store.data.id, root), harnesses);
        assert.equal(attempts, 2);
      });
    }
  }
}
