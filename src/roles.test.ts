import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  builtInRole,
  listRoles,
  loadRole,
  loadRoleSchema,
  parseRole,
  renderRole,
  writeRole,
} from "./roles.js";
import { tempDir } from "./test-support.js";

const minimal = `---
description: Checks things: carefully
harness: codex
model: gpt-test
---

Be precise.
`;

test("Role files apply defaults and keep colons in values and the body", () => {
  assert.deepEqual(parseRole("checker", minimal), {
    name: "checker",
    description: "Checks things: carefully",
    harness: "codex",
    model: "gpt-test",
    effort: "high",
    permission: "read-only",
    web: true,
    extraArgs: { claude: [], codex: [] },
    instructions: "Be precise.",
  });
  assert.equal(
    parseRole("checker", minimal.replace("model: gpt-test", "model: gpt-test\nweb: false")).web,
    false
  );
});

test("Role files reject invalid names, keys, and values", () => {
  const withLine = (line: string) => minimal.replace("model: gpt-test", `model: gpt-test\n${line}`);

  assert.throws(() => parseRole("Bad Name", minimal), /Invalid Role name/);
  assert.throws(() => parseRole("x", "no frontmatter"), /frontmatter/);
  assert.throws(() => parseRole("x", withLine("tools: Bash")), /unknown line/);
  assert.throws(() => parseRole("x", withLine("permission: admin")), /permission/);
  assert.throws(() => parseRole("x", withLine("web: yes")), /web must be true or false/);
  assert.throws(() => parseRole("x", withLine("codex-args: --flag")), /JSON array/);
  assert.throws(() => parseRole("x", minimal.replace("codex", "gemini")), /harness/);
  assert.throws(() => parseRole("x", minimal.replace(/description.*\n/, "")), /description/);
});

test("rendered Roles parse back unchanged, and list and load use the file name", (t) => {
  const dir = tempDir(t);
  const role = {
    ...builtInRole("reviewer", { harness: "claude", model: "haiku" }),
    permission: "write" as const,
    web: false,
    schema: "reviewer.schema.json",
    extraArgs: { claude: ["--flag", "a b"], codex: [] },
  };

  assert.deepEqual(parseRole("reviewer", renderRole(role)), role);

  writeRole(role, dir);
  writeRole(builtInRole("planner", { harness: "codex", model: "gpt-test" }), dir);
  writeFileSync(join(dir, "notes.txt"), "ignored");

  assert.deepEqual(
    listRoles(dir).map((item) => item.name),
    ["planner", "reviewer"]
  );
  assert.deepEqual(loadRole("reviewer", dir), role);
  assert.throws(() => loadRole("missing", dir), /No Role file/);
  assert.throws(() => loadRole("../x", dir), /Invalid Role name/);
  assert.deepEqual(listRoles(join(dir, "absent")), []);
});

test("Role schemas load relative to the roles directory", (t) => {
  const dir = tempDir(t);
  const role = { ...parseRole("checker", minimal), schema: "checker.schema.json" };

  assert.equal(loadRoleSchema(parseRole("checker", minimal), dir), undefined);

  writeFileSync(join(dir, "checker.schema.json"), '{"type":"object"}');
  assert.deepEqual(loadRoleSchema(role, dir), { type: "object" });

  writeFileSync(join(dir, "checker.schema.json"), "[]");
  assert.throws(() => loadRoleSchema(role, dir), /JSON object/);
});
