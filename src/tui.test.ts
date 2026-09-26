import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createOutput } from "./output.js";
import { builtInRole, listRoles, loadRole, writeRole } from "./roles.js";
import { message, tempDir } from "./test-support.js";
import { parseInterjection } from "./tui.js";

test("interjection syntax requires a known Role and body", () => {
  assert.deepEqual(parseInterjection("@planner keep it simple"), {
    role: "planner",
    body: "keep it simple",
  });
  for (const line of ["hello", "@unknown hi", "@planner ", "@reviewer"])
    assert.equal(parseInterjection(line), null);
});
test("Turn output shortens tools and prints the committed reply once without terminal escapes", () => {
  const lines: string[] = [];
  const output = createOutput({ terminal: false, cwd: "/repo", write: (line) => lines.push(line) });
  output.startTurn("planner", "haiku");
  output.event("planner", "haiku", { type: "session", sessionId: "hidden" });
  output.event("planner", "haiku", {
    type: "tool",
    name: "Read",
    detail: '{"file_path":"/repo/README.md"}',
  });
  output.event("planner", "haiku", {
    type: "tool",
    name: "StructuredOutput",
    detail: '{"kind":"request","body":"Review this"}',
  });
  output.event("planner", "haiku", {
    type: "text",
    text: '{"kind":"request","body":"Review this"}',
  });
  output.message(message("planner", "request", "reviewer", { body: "Review this" }));
  assert.deepEqual(lines, [
    "\n> Planner · haiku",
    "| Read README.md",
    "| Review this",
    "`- > Plan ready for review · Planner → Reviewer",
  ]);
});

function configureIn(home: string, changeModel = false) {
  return spawnSync(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { mock } from 'node:test';
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    mock.module('@clack/prompts', { namedExports: {
      intro() {}, outro() {}, log: { info() {} }, isCancel: () => false,
      select: async ({ options, initialValue }) => ${changeModel ? "options[0].value" : "initialValue ?? options[0].value"},
    } });
    const { configure } = await import('./src/tui.ts');
    await configure();
  `,
    ],
    { encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 5000 }
  );
}

test("config creates the swarm planner on fresh setup and adds it to existing installations", (t) => {
  for (const existing of [false, true]) {
    const home = tempDir(t);
    const dir = join(home, ".config/larp/roles");
    if (existing) {
      writeRole(builtInRole("planner", { harness: "codex", model: "planning-model" }), dir);
      writeRole(builtInRole("reviewer", { harness: "codex", model: "review-model" }), dir);
    }
    const result = configureIn(home);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      listRoles(dir).map((role) => role.name),
      ["planner", "reviewer", "swarm-planner"]
    );
    const swarm = loadRole("swarm-planner", dir);
    assert.match(swarm.instructions, /manageable|split large areas/);
    assert.equal(swarm.permission, "read-only");
    if (existing) assert.equal(loadRole("planner", dir).model, "planning-model");
  }
});

test("config preserves customized swarm planner settings when keeping or changing its model", (t) => {
  const home = tempDir(t);
  const dir = join(home, ".config/larp/roles");
  const role = {
    ...builtInRole("swarm-planner", { harness: "codex", model: "my-splitter" }),
    instructions: "Group modules by ownership.",
    description: "My custom splitting rules",
    effort: "medium",
    web: false,
    schema: "custom.json",
    extraArgs: { claude: [], codex: ["--custom"] },
  };
  writeRole(role, dir);
  const path = join(dir, "swarm-planner.md");
  const original = readFileSync(path, "utf8");
  const unchanged = configureIn(home);
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal(readFileSync(path, "utf8"), original);
  const changed = configureIn(home, true);
  assert.equal(changed.status, 0, changed.stderr);
  const updated = loadRole("swarm-planner", dir);
  assert.notEqual(updated.model, role.model);
  assert.deepEqual(updated, { ...role, harness: updated.harness, model: updated.model });
});
