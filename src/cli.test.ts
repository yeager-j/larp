import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { writeConfig, type Config } from "./config.js";
import { ROLES } from "./message.js";
import { RunStore } from "./run-store.js";
import { participants, tempDir } from "./test-support.js";

const cli = resolve("src/cli.ts");
function invoke(home: string, args: string[], path = process.env.PATH) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: path },
    timeout: 5000,
  });
}
test("CLI help, missing config, invalid commands, runs, and show", (t) => {
  const home = tempDir(t);
  assert.match(invoke(home, ["--help"]).stdout, /larp resume/);
  assert.match(invoke(home, ["plan", "task"]).stderr, /larp config/);
  assert.equal(invoke(home, ["unknown"]).status, 1);
  const run = RunStore.create("cli task", participants, join(home, ".larp/runs"));
  assert.match(invoke(home, ["runs"]).stdout, /cli task/);
  assert.equal(invoke(home, ["show", run.data.id]).stdout, "");
  assert.match(invoke(home, ["resume"]).stderr, /Usage/);
});
test("CLI explicit overrides run fake harnesses, preserve Phase Gate, and quiet hides events", (t) => {
  const home = tempDir(t);
  const bin = join(home, "bin");
  mkdirSync(bin);
  const fake = `#!${process.execPath}
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'HIDDEN PROGRESS'}]}}));
  const output = model === 'planner-model' ? {kind:'request',body:'plan',plan:'# Plan'} : {kind:'approve',body:'approved'};
  console.log(JSON.stringify({type:'result',structured_output:output}));
});`;
  writeFileSync(join(bin, "claude"), fake, { mode: 0o755 });
  const config: Config = {
    models: [participants.planner],
    defaults: participants,
    roles: Object.fromEntries(
      ROLES.map((role) => [role, { effort: "high", extraArgs: { claude: [], codex: [] } }])
    ) as unknown as Config["roles"],
  };
  writeConfig(config, join(home, ".config/larp/config.json"));
  const result = invoke(
    home,
    ["plan", "task", "--planner", "claude:planner-model", "--quiet"],
    `${bin}:${process.env.PATH}`
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires a terminal/);
  assert.match(result.stdout, /approved/);
  assert.doesNotMatch(result.stdout, /HIDDEN PROGRESS/);
  const id = /Run ([\w-]+) /.exec(result.stdout)![1]!;
  const run = RunStore.open(id, join(home, ".larp/runs"));
  assert.equal(run.entries().length, 2);
  const resumed = invoke(home, ["resume", id, "--quiet"], `${bin}:${process.env.PATH}`);
  assert.match(resumed.stdout, /gate/);
  assert.equal(RunStore.open(id, join(home, ".larp/runs")).entries().length, 2);
});
