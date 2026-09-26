import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { participants } from "../test-support.js";
import { createSwarmOutput, swarmFrame, terminalText, type SwarmRow } from "./output.js";
import type { ExecutionData, SwarmEntry } from "./store.js";

const data: ExecutionData = {
  id: "test",
  createdAt: "now",
  kind: "execution",
  cwd: "/work",
  role: "style",
  participant: participants.planner,
  parallel: 3,
  document: {
    version: 1,
    task: "Sweep",
    chunks: ["a", "b", "c"].map((id) => ({ id, paths: [id], focus: "Review" })),
  },
};
const reply: SwarmEntry = {
  id: "reply",
  at: "now",
  kind: "reply",
  key: "a",
  body: "No findings",
  sessionId: "s",
  durationMs: 53000,
};

test("frames preserve order, update running timers and freeze finished durations", () => {
  const rows: SwarmRow[] = [
    { id: "a", status: "Complete", durationMs: 53000 },
    { id: "b", status: "Running", startedAt: 0 },
    { id: "c", status: "Queued" },
  ];
  const frame = swarmFrame(rows, 130000, 130000, 150, 24);
  assert.match(frame, /1 running · 1 waiting · 1 complete · 0 failed/);
  assert.match(frame, /\[a\] Complete \(53s\)[\s\S]*\[b\] Running \(2m 10s\)[\s\S]*\[c\] Queued/);
  assert.match(swarmFrame(rows, 140000, 140000, 150, 24), /\[a\] Complete \(53s\)/);
});

test("small frames prioritize active and failed chunks and fit terminal dimensions", () => {
  const rows: SwarmRow[] = Array.from({ length: 12 }, (_, i) => ({
    id: `chunk-${i}`,
    status: i === 9 ? "Failed" : i === 10 ? "Running" : "Queued",
    startedAt: 0,
  }));
  const frame = swarmFrame(rows, 0, 0, 32, 7);
  assert.match(frame, /chunk-9/);
  assert.match(frame, /chunk-10/);
  assert.match(frame, /10 more chunks/);
  assert.ok(frame.split("\n").every((line) => line.length < 32));
  assert.equal(swarmFrame(rows, 0, 0, 20, 2).split("\n").length, 1);
});

test("plain output emits an idle heartbeat, sanitizes errors, and stops after close", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (chunk) => {
    output += chunk;
  });
  const ui = createSwarmOutput({ stream, terminal: false });
  ui.begin!(data, [], "/reports");
  ui.start!("a");
  t.mock.timers.tick(29000);
  assert.doesNotMatch(output, /\[progress\]/);
  t.mock.timers.tick(1000);
  assert.match(output, /30s elapsed · 1 running · 2 waiting/);
  ui.settled!({
    id: "f",
    at: "now",
    kind: "failure",
    key: "a",
    body: "bad\x1b[2J\nerror",
    durationMs: 30000,
  });
  assert.match(output, /bad error/);
  assert.doesNotMatch(output, /\x1b/);
  ui.close!();
  const final = output;
  t.mock.timers.tick(60000);
  assert.equal(output, final);
});

test("live output redraws inline, restores saved durations, and cleans up on interruption", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const stream = Object.assign(new PassThrough(), { columns: 150, rows: 24, isTTY: true });
  let output = "";
  stream.on("data", (chunk) => {
    output += chunk;
  });
  const ui = createSwarmOutput({ stream, terminal: true });
  ui.begin!(data, [reply], "/reports");
  ui.start!("b");
  t.mock.timers.tick(2000);
  assert.match(output, /\[b\] Running \(2s\)/);
  assert.match(output, /\[a\] Complete \(53s\)/);
  assert.match(output, /\x1b\[/);
  assert.equal(stream.listenerCount("resize"), 1);
  stream.columns = 40;
  stream.emit("resize");
  stream.columns = 150;
  ui.close!();
  assert.match(output, /\[b\] Interrupted \(2s\)/);
  assert.equal(stream.listenerCount("resize"), 0);
  const final = output;
  t.mock.timers.tick(10000);
  ui.close!();
  assert.equal(output, final);
});

test("display text cannot inject control sequences", () => {
  assert.equal(terminalText("a\x1b[31mb\x1b[0m\nc\x07"), "ab c ");
});

test("an initial redraw failure still finalizes the display when the workflow closes", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const stream = Object.assign(new PassThrough(), { columns: 150, rows: 24, isTTY: true });
  let output = "";
  stream.on("data", (chunk) => {
    output += chunk;
  });
  const write = stream.write.bind(stream);
  let failed = false;
  stream.write = ((chunk: string | Uint8Array) => {
    if (!failed && String(chunk).includes("[progress]")) {
      failed = true;
      throw new Error("redraw failed");
    }
    return write(chunk);
  }) as typeof stream.write;
  const ui = createSwarmOutput({ stream, terminal: true });
  assert.throws(() => ui.begin!(data, [], "/reports"), /redraw failed/);
  ui.close!();
  assert.match(output, /\[progress\]/);
  assert.equal(stream.listenerCount("resize"), 0);
  const final = output;
  t.mock.timers.tick(60000);
  assert.equal(output, final);
});

test("live rendering reserves space for headers, including wrapped wide-character paths", () => {
  const stream = Object.assign(new PassThrough(), { columns: 100, rows: 12 });
  let output = "";
  stream.on("data", (chunk) => {
    output += chunk;
  });
  const ui = createSwarmOutput({ stream, terminal: true });
  const many: ExecutionData = {
    ...data,
    document: {
      ...data.document,
      chunks: Array.from({ length: 20 }, (_, index) => ({
        id: `chunk-${index}`,
        paths: ["."],
        focus: "Review",
      })),
    },
  };
  try {
    ui.begin!(many, [], "/" + "界".repeat(95));
    const plain = terminalText(output);
    // Five physical header lines leave seven rows; only two chunk rows plus an omission fit.
    assert.match(plain, /18 more chunks/);
    assert.match(plain, /\[chunk-1\] Queued/);
    assert.doesNotMatch(plain, /\[chunk-2\]/);
  } finally {
    ui.close!();
  }
});

test("execution rows do not count a planner reply for a chunk named splitter", () => {
  const stream = Object.assign(new PassThrough(), { columns: 150, rows: 24, isTTY: true });
  let output = "";
  stream.on("data", (chunk) => {
    output += chunk;
  });
  const ui = createSwarmOutput({ stream, terminal: true });
  const execution = {
    ...data,
    document: { ...data.document, chunks: [{ id: "splitter", paths: ["src/"], focus: "Review" }] },
  };
  try {
    ui.begin!(
      execution,
      [
        {
          id: "plan",
          at: "now",
          kind: "split",
          key: "splitter",
          durationMs: 5000,
          sessionId: "s",
          document: execution.document,
        },
      ],
      "/reports"
    );
    assert.match(output, /\[splitter\] Queued/);
    assert.match(output, /0 complete/);
  } finally {
    ui.close!();
  }
});
