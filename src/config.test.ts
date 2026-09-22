import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  loadConfig,
  parseModel,
  participantsFor,
  readCodexModels,
  writeConfig,
  type Config,
} from "./config.js";
import { ROLES } from "./message.js";
import { participants, tempDir } from "./test-support.js";

test("Codex cache reads slugs and fetch time without network or seeding", (t) => {
  const path = join(tempDir(t), "cache.json");
  assert.deepEqual(readCodexModels(path), { models: [] });
  writeFileSync(
    path,
    JSON.stringify({ fetched_at: "yesterday", models: [{ slug: "gpt-test" }, { name: "ignore" }] })
  );
  assert.deepEqual(readCodexModels(path), {
    fetchedAt: "yesterday",
    models: [{ harness: "codex", model: "gpt-test" }],
  });
});
test("config must exist, round trips and applies role-specific arguments", (t) => {
  const path = join(tempDir(t), "config.json");
  assert.throws(() => loadConfig(path), /larp config/);
  const config: Config = {
    models: [{ harness: "claude", model: "haiku" }],
    defaults: participants,
    roles: Object.fromEntries(
      ROLES.map((role) => [role, { effort: "high", extraArgs: { claude: [], codex: ["--test"] } }])
    ) as unknown as Config["roles"],
  };
  writeConfig(config, path);
  assert.deepEqual(loadConfig(path), config);
  const legacy = {
    ...config,
    defaults: { ...config.defaults, implementer: { harness: "claude", model: "haiku" } },
    roles: { ...config.roles, implementer: config.roles.planner },
  };
  writeFileSync(path, JSON.stringify(legacy));
  assert.deepEqual(Object.keys(participantsFor(loadConfig(path))).sort(), ["planner", "reviewer"]);
  assert.deepEqual(
    participantsFor(config, { reviewer: { harness: "codex", model: "gpt-test" } }).reviewer,
    { harness: "codex", model: "gpt-test", effort: "high", extraArgs: ["--test"] }
  );
  assert.deepEqual(parseModel("codex:gpt-test"), { harness: "codex", model: "gpt-test" });
  assert.throws(() => parseModel("bad:model"), /Expected/);
  assert.throws(() => parseModel("claude:"), /Expected/);
  writeFileSync(path, "{}");
  assert.throws(() => loadConfig(path), /Config models/);
});
