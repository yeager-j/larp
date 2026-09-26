import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { tempDir } from "../test-support.js";
import { buildClaudeArgs, parseClaudeEvent } from "./claude.js";
import { buildCodexArgs, parseCodexEvent, readCodexOutput } from "./codex.js";
import { spawnTurn, TurnInterrupted } from "./spawn.js";
import type { TurnRequest } from "./types.js";

const req: TurnRequest = {
  cwd: "/work",
  model: "model",
  effort: "high",
  permission: "read-only",
  web: false,
  rolePrompt: "protocol",
  prompt: "envelope",
  schema: {},
  extraArgs: [],
  turnDir: "/turns/01",
  onEvent() {},
};
test("Claude arguments preserve permissions and first/resumed session semantics", () => {
  const first = buildClaudeArgs(req, "uuid");
  assert.ok(first.includes("--session-id"));
  assert.ok(first.includes("--append-system-prompt"));
  assert.ok(first.includes("Bash,Edit,NotebookEdit,ExitPlanMode"));
  assert.ok(first.includes('{"disableAllHooks":true}'));
  const resumed = buildClaudeArgs({ ...req, sessionId: "uuid", permission: "write" }, "uuid");
  assert.ok(resumed.includes("--resume"));
  assert.ok(!resumed.includes("--session-id"));
  assert.ok(resumed.includes("--dangerously-skip-permissions"));
  assert.ok(!resumed.includes("--permission-mode"));
  assert.ok(resumed.includes("WebSearch,WebFetch"));
});
test("Claude web access adds the web tools to read-only Turns and stops blocking them on write", () => {
  const readOnly = buildClaudeArgs({ ...req, web: true }, "uuid");
  assert.equal(
    readOnly[readOnly.indexOf("--tools") + 1],
    "Read,Glob,Grep,ToolSearch,Skill,Agent,Write,WebSearch,WebFetch"
  );
  assert.equal(
    readOnly[readOnly.indexOf("--allowedTools") + 1],
    "Read,Glob,Grep,ToolSearch,Skill,Agent,WebSearch,WebFetch"
  );
  assert.ok(!buildClaudeArgs(req, "uuid").join(" ").includes("Web"));
  assert.ok(
    !buildClaudeArgs({ ...req, web: true, permission: "write" }, "uuid")
      .join(" ")
      .includes("Web")
  );
});
test("Claude fixture shapes include tool/text/thinking, structured output, and denial errors", () => {
  assert.deepEqual(
    parseClaudeEvent({ type: "stream_event", event: { delta: { type: "thinking_delta" } } }).events,
    [{ type: "thinking" }]
  );
  const assistant = parseClaudeEvent({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "hello" },
        { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } },
      ],
    },
  });
  assert.equal(assistant.events.length, 2);
  const result = parseClaudeEvent({
    type: "result",
    session_id: "uuid",
    structured_output: { kind: "approve", body: "yes" },
    is_error: true,
    result: "failed",
    permission_denials: [{ tool_name: "Write" }],
  });
  assert.equal(result.sessionId, "uuid");
  assert.deepEqual(result.output, { kind: "approve", body: "yes" });
  assert.match(result.error!, /failed/);
  assert.match(result.error!, /Write/);
  assert.deepEqual(parseClaudeEvent(null), { events: [] });
});
test("Codex prompt is positional on first and resumed Turns, with no -C", () => {
  const first = buildCodexArgs(req);
  assert.deepEqual(first.slice(0, 1), ["exec"]);
  assert.equal(first.at(-1), "protocol\n\nenvelope");
  assert.ok(first.includes('sandbox_mode="read-only"'));
  assert.ok(first.includes('web_search="disabled"'));
  assert.ok(first.includes("--skip-git-repo-check"));
  assert.ok(!first.includes("-C"));
  const resumed = buildCodexArgs({
    ...req,
    sessionId: "thread",
    permission: "write",
  });
  assert.deepEqual(resumed.slice(0, 3), ["exec", "resume", "thread"]);
  assert.equal(resumed.at(-1), "envelope");
  assert.ok(resumed.includes('sandbox_mode="workspace-write"'));
  assert.ok(!resumed.includes("--skip-git-repo-check"));
  assert.ok(buildCodexArgs({ ...req, web: true }).includes('web_search="live"'));
});
test("Codex fixture shapes never turn agent messages into the final reply", (t) => {
  assert.equal(
    parseCodexEvent({ type: "thread.started", thread_id: "thread" }).sessionId,
    "thread"
  );
  const message = parseCodexEvent({
    type: "item.completed",
    item: { type: "agent_message", text: '{"kind":"approve"}' },
  });
  assert.equal(message.output, undefined);
  assert.equal(message.events[0]?.type, "text");
  assert.equal(
    parseCodexEvent({ type: "item.completed", item: { type: "command_execution", command: "ls" } })
      .events[0]?.type,
    "tool"
  );
  assert.deepEqual(parseCodexEvent({ type: "turn.completed" }), { events: [] });
  assert.equal(
    parseCodexEvent({ type: "turn.failed", error: { message: "failed" } }).error,
    "failed"
  );
  assert.equal(parseCodexEvent({ type: "error", message: "oops" }).error, "oops");
  const dir = tempDir(t);
  const structured = { turnDir: dir, schema: {} };
  assert.equal(readCodexOutput(structured), undefined);
  writeFileSync(join(dir, "last.json"), '{"kind":"approve","body":"ok"}');
  assert.deepEqual(readCodexOutput(structured), { kind: "approve", body: "ok" });
  writeFileSync(join(dir, "last.json"), "invalid");
  assert.equal(readCodexOutput(structured), undefined);
  writeFileSync(join(dir, "last.txt"), "Plain reply\n");
  assert.equal(readCodexOutput({ turnDir: dir }), "Plain reply");
});
test("spawn streams lines, respects cwd, captures stderr, and closes stdin", async (t) => {
  const dir = tempDir(t);
  const lines: string[] = [];
  const result = await spawnTurn({
    command: process.execPath,
    args: [
      "-e",
      `let body='';process.stdin.on('data', c=>body+=c);process.stdin.on('end',()=>{console.log(process.cwd());console.log(body);process.stderr.write('diagnostic');process.exitCode=7;});`,
    ],
    cwd: dir,
    turnDir: dir,
    stdin: "prompt",
    onLine: (line) => lines.push(line),
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr, "diagnostic");
  assert.deepEqual(lines, [realpathSync(dir), "prompt"]);
  assert.match(readFileSync(join(dir, "stdout.jsonl"), "utf8"), /prompt/);
  assert.equal(readFileSync(join(dir, "stderr.log"), "utf8"), "diagnostic");
});
test("spawn failures return actionable errors", async (t) => {
  const dir = tempDir(t);
  const result = await spawnTurn({
    command: "/does-not-exist/larp",
    args: [],
    cwd: dir,
    turnDir: dir,
    onLine() {},
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.error!, /No such file|not found|ENOENT/);
});

test(
  "interrupting parallel Harness children forwards the signal and removes listeners and process records",
  { timeout: 5000 },
  async (t) => {
    const root = tempDir(t);
    const before = {
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
    };
    let readyCount = 0;
    let ready!: () => void;
    const allReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const dirs = ["a", "b", "c"].map((id) => join(root, id));
    const outcomes = Promise.allSettled(
      dirs.map((dir) =>
        spawnTurn({
          command: process.execPath,
          args: [
            "-e",
            "process.on('SIGINT',()=>{console.log('stopped');process.exit(0)});console.log('ready');setInterval(()=>{},1000)",
          ],
          cwd: root,
          turnDir: dir,
          onLine(line) {
            if (line === "ready" && ++readyCount === dirs.length) ready();
          },
        })
      )
    );
    t.after(() => {
      for (const dir of dirs) {
        const path = join(dir, "harness.pid");
        if (existsSync(path)) {
          try {
            process.kill(Number(readFileSync(path, "utf8")), "SIGKILL");
          } catch {}
        }
      }
    });
    await allReady;
    process.emit("SIGINT");
    for (const outcome of await outcomes) {
      assert.equal(outcome.status, "rejected");
      assert.ok(outcome.status === "rejected" && outcome.reason instanceof TurnInterrupted);
    }
    for (const dir of dirs) {
      assert.match(readFileSync(join(dir, "stdout.jsonl"), "utf8"), /stopped/);
      assert.equal(existsSync(join(dir, "harness.pid")), false);
    }
    assert.equal(process.listenerCount("SIGINT"), before.SIGINT);
    assert.equal(process.listenerCount("SIGTERM"), before.SIGTERM);
  }
);

test("real adapter shells use final artifacts and session IDs across resume", async (t) => {
  const { mkdirSync } = await import("node:fs");
  const { claudeHarness } = await import("./claude.js");
  const { codexHarness } = await import("./codex.js");
  const dir = tempDir(t);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });
  writeFileSync(
    join(bin, "claude"),
    `#!${process.execPath}
let prompt='';process.stdin.on('data', c=>prompt+=c);process.stdin.on('end',()=>{
console.log(JSON.stringify({type:'result',session_id:'untrusted-id',structured_output:{kind:'approve',body:prompt}}));});`,
    { mode: 0o755 }
  );
  writeFileSync(
    join(bin, "codex"),
    `#!${process.execPath}
const fs=require('fs');const args=process.argv.slice(2);process.stdin.resume();process.stdin.on('end',()=>{
console.log(JSON.stringify({type:'thread.started',thread_id:'thread-from-event'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'NOT THE RESULT'}}));
fs.writeFileSync(args[args.indexOf('-o')+1],JSON.stringify({kind:'approve',body:args.at(-1)}));});`,
    { mode: 0o755 }
  );
  const request = { ...req, cwd: dir, turnDir: dir };
  const claude = await claudeHarness.runTurn(request);
  assert.match(claude.sessionId, /^[\da-f-]{36}$/);
  assert.deepEqual(claude.output, { kind: "approve", body: "protocol\n\nenvelope" });
  const resumedClaude = await claudeHarness.runTurn({
    ...request,
    sessionId: claude.sessionId,
  });
  assert.equal(resumedClaude.sessionId, claude.sessionId);
  assert.deepEqual(resumedClaude.output, { kind: "approve", body: "envelope" });
  const codex = await codexHarness.runTurn(request);
  assert.equal(codex.sessionId, "thread-from-event");
  assert.deepEqual(codex.output, { kind: "approve", body: "protocol\n\nenvelope" });
  const resumedCodex = await codexHarness.runTurn({
    ...request,
    sessionId: codex.sessionId,
  });
  assert.deepEqual(resumedCodex.output, { kind: "approve", body: "envelope" });
});

test("without a schema, adapters omit schema flags and return the reply text", async (t) => {
  const { mkdirSync } = await import("node:fs");
  const { claudeHarness } = await import("./claude.js");
  const { codexHarness } = await import("./codex.js");
  const { schema: _schema, ...free } = req;
  assert.ok(!buildClaudeArgs(free, "uuid").includes("--json-schema"));
  assert.ok(!buildCodexArgs(free).includes("--output-schema"));
  assert.equal(buildCodexArgs(free)[buildCodexArgs(free).indexOf("-o") + 1], "/turns/01/last.txt");
  assert.equal(parseClaudeEvent({ type: "result", result: "Plain" }).text, "Plain");
  assert.equal(
    parseClaudeEvent({ type: "result", result: "Oops", is_error: true }).text,
    undefined
  );
  const dir = tempDir(t);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => {
    process.env.PATH = previousPath;
  });
  writeFileSync(
    join(bin, "claude"),
    `#!${process.execPath}
process.stdin.resume();process.stdin.on('end',()=>{
console.log(JSON.stringify({type:'result',result:'Claude text ' + process.env.LARP_TURN}));});`,
    { mode: 0o755 }
  );
  writeFileSync(
    join(bin, "codex"),
    `#!${process.execPath}
const fs=require('fs');const args=process.argv.slice(2);process.stdin.resume();process.stdin.on('end',()=>{
console.log(JSON.stringify({type:'thread.started',thread_id:'thread'}));
fs.writeFileSync(args[args.indexOf('-o')+1],'Codex text\\n');});`,
    { mode: 0o755 }
  );
  const request = { ...free, cwd: dir, turnDir: dir };
  assert.equal((await claudeHarness.runTurn(request)).output, "Claude text 1");
  assert.equal((await codexHarness.runTurn(request)).output, "Codex text");
});

test("a harness process that cannot be recorded is stopped, and cleanup still completes", async (t) => {
  const dir = tempDir(t);
  const listeners = process.listenerCount("SIGINT");

  // A directory where the record belongs makes both writing and removing it fail.
  mkdirSync(join(dir, "harness.pid"));

  const started = Date.now();
  const result = await spawnTurn({
    command: "sleep",
    args: ["30"],
    cwd: dir,
    turnDir: dir,
    onLine() {},
  });

  assert.match(result.error ?? "", /Could not record the harness process/);
  assert.notEqual(result.exitCode, 0);
  assert.ok(Date.now() - started < 10000, "the process was stopped");
  assert.equal(process.listenerCount("SIGINT"), listeners);
});

test(
  "an ignored interrupt is escalated and its process record is removed",
  { timeout: 4000 },
  async (t) => {
    const dir = tempDir(t);
    await assert.rejects(
      spawnTurn({
        command: process.execPath,
        args: ["-e", "process.on('SIGINT',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],
        cwd: dir,
        turnDir: dir,
        onLine(line) {
          if (line === "ready") process.emit("SIGINT");
        },
      }),
      TurnInterrupted
    );
    assert.equal(existsSync(join(dir, "harness.pid")), false);
  }
);

test("a failed process record prevents the harness from starting", async (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, "harness.pid"));
  const result = await spawnTurn({
    command: process.execPath,
    args: ["-e", "require('fs').writeFileSync('started', 'yes')"],
    cwd: dir,
    turnDir: dir,
    onLine() {},
  });
  assert.match(result.error!, /Could not record/);
  assert.equal(existsSync(join(dir, "started")), false);
});

test(
  "artifact write errors stop a resistant child through the normal result",
  { timeout: 4000 },
  async (t) => {
    const fs = (await import("node:fs")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    const original = fs.writeSync;
    t.mock.method(fs, "writeSync", (...args: Parameters<typeof fs.writeSync>) => {
      if (String(args[1]).includes("fail-output")) throw new Error("disk full");
      return Reflect.apply(original, fs, args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const dir = tempDir(t);
    const result = await spawnTurn({
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM',()=>{}); console.log('fail-output'); setInterval(()=>{},1000)",
      ],
      cwd: dir,
      turnDir: dir,
      onLine() {},
    });
    assert.match(result.error!, /disk full/);
    assert.equal(existsSync(join(dir, "harness.pid")), false);
  }
);
