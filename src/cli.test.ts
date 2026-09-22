import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { writeConfig, type Config } from "./config.js";
import { ROLES } from "./message.js";
import { builtInRole, writeRole } from "./roles.js";
import { RunStore } from "./run-store.js";
import { participants, tempDir } from "./test-support.js";

const cli = resolve("src/cli.ts");
function invoke(home: string, args: string[], path = process.env.PATH, env: object = {}) {
  const inherited = { ...process.env };
  delete inherited.LARP_TURN;
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    encoding: "utf8",
    env: { ...inherited, HOME: home, PATH: path, ...env },
    timeout: 5000,
  });
}
/** Install a fake claude that replies with structured output when given a schema, text otherwise. */
function fakeClaude(home: string): string {
  const bin = join(home, "bin");
  mkdirSync(bin);
  const fake = `#!${process.execPath}
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
let prompt = '';
process.stdin.on('data', (c) => prompt += c);
process.stdin.on('end', () => {
  console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'HIDDEN PROGRESS'}]}}));
  if (!args.includes('--json-schema')) {
    const mode = args.includes('--resume') ? 'resumed' : 'new';
    console.log(JSON.stringify({type:'result',result:mode + ' ' + (process.env.LARP_TURN ?? '') + ': ' + prompt.split('\\n').at(-1)}));
    return;
  }
  const output = model === 'planner-model' ? {kind:'request',body:'plan',plan:'# Plan'} : {kind:'approve',body:'approved'};
  console.log(JSON.stringify({type:'result',structured_output:output}));
});`;
  writeFileSync(join(bin, "claude"), fake, { mode: 0o755 });
  return `${bin}:${process.env.PATH}`;
}
function configureHome(home: string): void {
  const config: Config = { models: [participants.planner] };
  writeConfig(config, join(home, ".config/larp/config.json"));
  for (const role of ROLES)
    writeRole(
      builtInRole(role, { harness: "claude", model: `${role}-model` }),
      join(home, ".config/larp/roles")
    );
}
test("CLI help, missing config, moved and invalid commands, plan list and show", (t) => {
  const home = tempDir(t);
  const help = invoke(home, ["--help"]).stdout;
  assert.match(help, /larp plan resume/);
  assert.match(help, /larp agent start --role/);
  assert.match(invoke(home, ["plan", "task"]).stderr, /larp config/);
  assert.equal(invoke(home, ["unknown"]).status, 1);
  assert.match(invoke(home, ["resume", "id"]).stderr, /now larp plan resume/);
  assert.match(invoke(home, ["runs"]).stderr, /now larp plan list/);
  assert.match(invoke(home, ["agent", "roles", "--message", "x"]).stderr, /--message applies/);
  assert.match(
    invoke(home, ["agent", "message", "id", "--role", "x", "--message", "y"]).stderr,
    /--role applies only to larp agent start/
  );
  assert.match(
    invoke(home, ["agent", "start", "--planner", "claude:x"]).stderr,
    /Participant flags/
  );
  const run = RunStore.create("cli task", participants, join(home, ".larp/runs"));
  assert.match(invoke(home, ["plan", "list"]).stdout, /cli task/);
  assert.equal(invoke(home, ["plan", "show", run.data.id]).stdout, "");
  assert.match(invoke(home, ["plan", "resume"]).stderr, /Usage/);
});
test("CLI explicit overrides run fake harnesses, preserve Phase Gate, and quiet hides events", (t) => {
  const home = tempDir(t);
  const path = fakeClaude(home);
  configureHome(home);
  const result = invoke(
    home,
    ["plan", "task", "--planner", "claude:planner-model", "--quiet"],
    path
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires a terminal/);
  assert.match(result.stdout, /approved/);
  assert.doesNotMatch(result.stdout, /HIDDEN PROGRESS/);
  const id = /Run ([\w-]+) /.exec(result.stdout)![1]!;
  const run = RunStore.open(id, join(home, ".larp/runs"));
  assert.equal(run.entries().length, 2);
  assert.match(run.data.participants.reviewer.instructions!, /reviewer/);
  const resumed = invoke(home, ["plan", "resume", id, "--quiet"], path);
  assert.match(resumed.stdout, /gate/);
  assert.equal(RunStore.open(id, join(home, ".larp/runs")).entries().length, 2);
});
test("CLI agent start and message print only replies and a footer, and resume the session", (t) => {
  const home = tempDir(t);
  const path = fakeClaude(home);
  configureHome(home);
  assert.match(
    invoke(home, ["agent", "roles"]).stdout,
    /^planner\tclaude:planner-model\tread-only\t/
  );
  const started = invoke(
    home,
    ["agent", "start", "--role", "reviewer", "--message", "Review it"],
    path
  );
  assert.equal(started.status, 0, started.stderr);
  const id = /agent ([\w-]+) \(reviewer\) started/.exec(started.stderr)![1]!;
  assert.equal(
    started.stdout,
    `new 1: Review it\n\n[larp] agent ${id} · reviewer · claude:reviewer-model\n[larp] Continue: larp agent message ${id} --message "<text>"\n`
  );
  const continued = invoke(home, ["agent", "message", id, "--message", "Again"], path);
  assert.equal(continued.status, 0, continued.stderr);
  assert.match(continued.stdout, /^resumed 1: Again\n/);
  assert.match(invoke(home, ["agent", "list"]).stdout, new RegExp(`${id}\\t.*\\treviewer\\t`));
  assert.equal(invoke(home, ["agent", "show", id]).stdout.trim().split("\n").length, 4);
  assert.match(
    invoke(home, ["agent", "start", "--role", "missing", "--message", "x"]).stderr,
    /No Role file/
  );
});
test("CLI commands that start Turns refuse to run inside a larp Turn", (t) => {
  const home = tempDir(t);
  configureHome(home);
  const env = { LARP_TURN: "1" };
  for (const args of [
    ["agent", "start", "--role", "reviewer", "--message", "x"],
    ["agent", "message", "id", "--message", "x"],
    ["plan", "task"],
    ["plan", "resume", "id"],
  ]) {
    const result = invoke(home, args, process.env.PATH, env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /inside a larp Turn/);
  }
  assert.equal(invoke(home, ["agent", "roles"], process.env.PATH, env).status, 0);
});

test("CLI runs through the symlink used by global npm installs", (t) => {
  const home = tempDir(t);
  const link = join(home, "larp");
  symlinkSync(cli, link);
  const result = spawnSync(process.execPath, ["--import", "tsx", link, "--help"], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /larp config/);
});
