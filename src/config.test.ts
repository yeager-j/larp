import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  legacyRoles,
  loadConfig,
  parseModel,
  participantFor,
  participantsFor,
  readCodexModels,
  writeConfig,
  type Config,
  type LegacyConfig,
} from "./config.js";
import { builtInRole } from "./roles.js";
import { tempDir } from "./test-support.js";

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
test("config must exist, round trips, and ignores legacy Role settings on load", (t) => {
  const path = join(tempDir(t), "config.json");
  assert.throws(() => loadConfig(path), /larp config/);
  const config: Config = { models: [{ harness: "claude", model: "haiku" }] };
  writeConfig(config, path);
  assert.deepEqual(loadConfig(path), config);
  assert.deepEqual(parseModel("codex:gpt-test"), { harness: "codex", model: "gpt-test" });
  assert.throws(() => parseModel("bad:model"), /Expected/);
  assert.throws(() => parseModel("claude:"), /Expected/);
  writeFileSync(path, "{}");
  assert.throws(() => loadConfig(path), /Config models/);
});
test("legacy defaults become built-in Roles with their effort and per-harness args", () => {
  const legacy: LegacyConfig = {
    models: [],
    defaults: {
      planner: { harness: "codex", model: "gpt-test" },
      reviewer: { harness: "claude", model: "haiku" },
      implementer: { harness: "claude", model: "ignored" },
    },
    roles: {
      planner: { effort: "medium", extraArgs: { claude: [], codex: ["--test"] } },
      reviewer: { effort: 3 as unknown as string, extraArgs: { claude: [], codex: [] } },
    },
  };
  const roles = legacyRoles(legacy);
  assert.deepEqual(Object.keys(roles).sort(), ["planner", "reviewer"]);
  assert.equal(roles.planner?.effort, "medium");
  assert.deepEqual(roles.planner?.extraArgs.codex, ["--test"]);
  assert.equal(roles.planner?.permission, "read-only");
  assert.equal(roles.reviewer?.effort, "high");
  assert.deepEqual(legacyRoles({ models: [] }), {});
});
test("Participants copy Role settings for the chosen harness and Role instructions", () => {
  const planner = builtInRole(
    "planner",
    { harness: "claude", model: "haiku" },
    {
      effort: "low",
      extraArgs: { claude: ["--c"], codex: ["--x"] },
    }
  );
  planner.permission = "write";
  const reviewer = builtInRole("reviewer", { harness: "claude", model: "haiku" });
  const resolved = participantsFor(
    { planner, reviewer },
    { planner: { harness: "codex", model: "gpt-test" } }
  );
  assert.deepEqual(resolved.planner, {
    harness: "codex",
    model: "gpt-test",
    effort: "low",
    extraArgs: ["--x"],
    instructions: planner.instructions,
    permission: "write",
    web: true,
  });
  assert.equal(resolved.reviewer.model, "haiku");
  assert.deepEqual(participantFor(reviewer).extraArgs, []);
});
