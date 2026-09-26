import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { writeConfig, type Config } from "./config.js";
import { DiscussionStore } from "./discuss/store.js";
import { BUILT_IN_ROLES, builtInRole, writeRole, type BuiltInRoleName } from "./roles.js";
import { RunStore } from "./run-store.js";
import { SwarmStore } from "./swarm/store.js";
import { participants, tempDir } from "./test-support.js";
import { ROUND_CAP } from "./workflow/plan.js";

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
  const schema = args[args.indexOf('--json-schema') + 1];
  const output = schema.includes('"verdict"')
    ? {verdict: model === 'stubborn' ? 'revise' : 'agree', objection: 'minor', body: 'critic body'}
    : schema.includes('"proposal"')
      ? {proposal: '# Proposal', body: 'note'}
      : model === 'planner-model' ? {kind:'request',body:'plan',plan:'# Plan'} : {kind:'approve',body:'approved'};
  console.log(JSON.stringify({type:'result',structured_output:output}));
});`;
  writeFileSync(join(bin, "claude"), fake, { mode: 0o755 });
  return `${bin}:${process.env.PATH}`;
}
function configureHome(home: string): void {
  const config: Config = { models: [participants.planner] };
  writeConfig(config, join(home, ".config/larp/config.json"));
  for (const role of Object.keys(BUILT_IN_ROLES) as BuiltInRoleName[])
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
  assert.match(help, /larp discuss --author/);
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
  const run = RunStore.create(
    { task: "cli task", participants, reviewRoundCap: ROUND_CAP },
    join(home, ".larp/runs")
  );
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
test("CLI discuss prints the agreed proposal, resolves Role specs, and replays on resume", (t) => {
  const home = tempDir(t);
  const path = fakeClaude(home);
  configureHome(home);
  const args = ["discuss", "--author", "claude:author-model", "--critic", "reviewer"];
  const started = invoke(home, [...args, "--message", "Evaluate it"], path);
  assert.equal(started.status, 0, started.stderr);
  const id = /discussion ([\w-]+) started/.exec(started.stderr)![1]!;
  assert.equal(
    started.stdout,
    `# Proposal\n\n---\n[larp] Agreed: the Critic accepted proposal v1 after 1 round.\n[larp] The Critic's remaining objection: minor\n[larp] discussion ${id} · author claude:author-model · critic claude:reviewer-model\n`
  );
  assert.match(
    started.stderr,
    /> Round 1 · Critic · claude:reviewer-model · verdict\n\| HIDDEN PROGRESS\n[\s\S]*`- OK Agreed on proposal v1\n$/
  );
  const { participants, maxRounds, blind } = DiscussionStore.open(
    id,
    join(home, ".larp/discussions")
  ).data;
  assert.deepEqual([maxRounds, blind], [5, false]);
  assert.equal(participants.author.instructions, undefined);
  assert.equal(participants.author.web, true);
  assert.match(participants.critic.instructions!, /You are a reviewer/);

  const resumed = invoke(home, ["discuss", "resume", id], path);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.stdout, started.stdout);
  const continued = invoke(home, ["discuss", "continue", id, "--message", "And X?"], path);
  assert.equal(continued.status, 0, continued.stderr);
  assert.match(continued.stdout, /accepted proposal v2 after 2 rounds/);
  assert.match(continued.stderr, /> Follow-up · Caller → Author\n\| And X\?\n\n> Round 2 · Author/);
  assert.match(
    invoke(home, ["discuss", "continue", id]).stderr,
    /Usage: larp discuss continue <discussion-id> --message/
  );
  assert.match(invoke(home, ["discuss", "list"]).stdout, new RegExp(`^${id}\t.*\tEvaluate it`));
  assert.equal(invoke(home, ["discuss", "show", id]).stdout.trim().split("\n").length, 5);
});

test("CLI discuss exits 2 at the round cap and validates its flags", (t) => {
  const home = tempDir(t);
  const path = fakeClaude(home);
  const capped = invoke(
    home,
    ["discuss", "--author", "claude:a", "--critic", "claude:stubborn", "--message", "x"].concat([
      "--blind",
      "--max-rounds",
      "2",
    ]),
    path
  );
  assert.equal(capped.status, 2, capped.stderr);
  assert.match(capped.stdout, /No agreement after 2 rounds[\s\S]*Strongest objection: minor/);

  const usage = invoke(home, ["discuss", "--author", "claude:a", "--message", "x"]);
  assert.match(usage.stderr, /Usage: larp discuss --author/);
  for (const rounds of ["0", "11", "2.5", "two"])
    assert.match(
      invoke(
        home,
        ["discuss", "--author", "claude:a", "--critic", "claude:b"].concat([
          "--message",
          "x",
          "--max-rounds",
          rounds,
        ])
      ).stderr,
      /--max-rounds must be an integer from 1 to 10/
    );
  assert.match(
    invoke(home, ["agent", "roles", "--blind"]).stderr,
    /apply only when starting a larp discuss/
  );
  assert.match(
    invoke(home, ["discuss", "resume", "id", "--author", "claude:a"]).stderr,
    /apply only when starting a larp discuss/
  );
  assert.match(invoke(home, ["discuss", "list", "--message", "x"]).stderr, /--message applies/);
  assert.match(
    invoke(home, ["discuss", "--author", "missing", "--critic", "claude:b", "--message", "x"])
      .stderr,
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
    ["discuss", "--author", "claude:a", "--critic", "claude:b", "--message", "x"],
    ["discuss", "resume", "id"],
    ["swarm", "init", "--message", "x"],
    ["swarm", "start", "--role", "reviewer", "--chunks", "missing.json"],
    ["swarm", "resume", "id"],
  ]) {
    const result = invoke(home, args, process.env.PATH, env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /inside a larp Turn/);
  }
  assert.equal(invoke(home, ["agent", "roles"], process.env.PATH, env).status, 0);
});

test("CLI swarm init/edit/start/resume uses saved inputs and produces reports with clean stdout", (t) => {
  const home = tempDir(t);
  configureHome(home);
  const bin = join(home, "bin");
  mkdirSync(bin);
  const trace = join(home, "trace.jsonl");
  const fail = join(home, "fail-once");
  writeFileSync(fail, "");
  writeFileSync(
    join(bin, "claude"),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
let prompt = '';
process.stdin.on('data', c => prompt += c);
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({args, prompt, cwd:process.cwd(), nested:process.env.LARP_TURN}) + '\\n');
  console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'HIDDEN PROGRESS'}]}}));
  if (args.includes('--json-schema')) {
    console.log(JSON.stringify({type:'result',structured_output:{version:1,task:'model task',chunks:[{id:'original',paths:['src/'],focus:'Review'}]}}));
    return;
  }
  const chunk = JSON.parse(prompt.split('Chunk:\\n')[1].split('\\n\\nReturn')[0]);
  if(chunk.id === 'b' && fs.existsSync(${JSON.stringify(fail)})) {
    fs.unlinkSync(${JSON.stringify(fail)});
    console.error('temporary failure'); process.exitCode = 1; return;
  }
  console.log(JSON.stringify({type:'result',result:'# Report ' + chunk.id}));
});`,
    { mode: 0o755 }
  );
  const path = `${bin}:${process.env.PATH}`;
  const init = invoke(
    home,
    ["swarm", "init", "--message", "Original task", "--role", "reviewer"],
    path
  );
  assert.equal(init.status, 0, init.stderr);
  const chunksPath = init.stdout.trim();
  assert.match(chunksPath, /chunks.json$/);
  assert.equal(JSON.parse(readFileSync(chunksPath, "utf8")).task, "Original task");
  writeFileSync(
    chunksPath,
    JSON.stringify({
      version: 1,
      task: "Edited task",
      chunks: ["a", "b", "c"].map((id) => ({ id, paths: [id], focus: "Edited focus" })),
    })
  );
  const reviewerPath = join(home, ".config/larp/roles/reviewer.md");
  writeFileSync(
    reviewerPath,
    readFileSync(reviewerPath, "utf8")
      .replace("permission: read-only", "permission: write")
      .replace("web: true", "web: true\nschema: missing.json")
  );
  const out = join(dirname(chunksPath), "results");
  const start = invoke(
    home,
    ["swarm", "start", "--chunks", chunksPath, "--role", "reviewer", "--parallel", "2"],
    path
  );
  assert.equal(start.status, 1, start.stderr);
  assert.match(start.stdout, /2 succeeded, 1 failed/);
  assert.doesNotMatch(start.stdout, /HIDDEN PROGRESS|\[start\]/);
  assert.match(start.stderr, /\[start\] a/);
  assert.doesNotMatch(start.stderr, /\x1b/);
  const id = /Swarm ([\w-]+):/.exec(start.stdout)![1]!;
  assert.equal(id, /swarm ([\w-]+)/.exec(init.stderr)![1]);
  assert.match(start.stdout, new RegExp(out));
  const store = SwarmStore.open(id, join(home, ".larp/swarms"));
  assert.equal(store.data.kind === "execution" && store.data.document.task, "Edited task");
  const restart = invoke(
    home,
    ["swarm", "start", "--chunks", chunksPath, "--role", "reviewer"],
    path
  );
  assert.equal(restart.status, 1);
  assert.match(restart.stderr, /already started.*larp swarm resume/);
  assert.equal(readdirSync(join(home, ".larp/swarms")).length, 1);
  rmSync(chunksPath);
  rmSync(reviewerPath);
  const resume = invoke(home, ["swarm", "resume", id], path);
  assert.equal(resume.status, 0, resume.stderr);
  assert.match(resume.stdout, /3 succeeded, 0 failed/);
  assert.deepEqual(
    readdirSync(out).filter((file) => file.endsWith(".md")),
    ["a.md", "b.md", "c.md"]
  );
  const requests = readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(requests.length, 5);
  assert.match(requests[0].prompt, /Intended execution Role/);
  assert.equal(requests[0].args[requests[0].args.indexOf("--model") + 1], "swarm-planner-model");
  assert.match(requests[0].prompt, /You plan independent swarms/);
  assert.equal(requests[0].args[requests[0].args.indexOf("--permission-mode") + 1], "plan");
  for (const request of requests.slice(1)) {
    assert.ok(request.args.includes("--dangerously-skip-permissions"));
    assert.doesNotMatch(request.prompt, /Never edit files|LARP read-only swarm/);
  }
  for (const request of requests) {
    assert.equal(request.nested, "1");
    assert.ok(!request.args.includes("--resume"));
  }
  const again = invoke(home, ["swarm", "resume", id], path);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(trace, "utf8").trim().split("\n").length, 5);
  assert.match(invoke(home, ["swarm", "list"], path).stdout, /3\/3 complete/);
  assert.match(invoke(home, ["swarm", "show", id], path).stdout, /temporary failure/);
});

test("CLI rejects misplaced swarm flags and invalid chunks before invoking a Harness", (t) => {
  const home = tempDir(t);
  configureHome(home);
  const chunks = join(home, "chunks.json");
  writeFileSync(chunks, JSON.stringify({ version: 1, task: "Sweep", chunks: [] }));
  for (const args of [
    ["swarm", "resume", "id", "--parallel", "2"],
    ["swarm", "init", "--message", "x", "--chunks", chunks],
    ["swarm", "start", "--chunks", chunks, "--role", "reviewer", "--message", "x"],
    ["swarm", "start", "--chunks", chunks, "--role", "reviewer", "--parallel", "9"],
    ["swarm", "start", "--chunks", chunks, "--role", "reviewer"],
  ])
    assert.equal(invoke(home, args, home).status, 1);
  assert.equal(invoke(home, ["swarm", "list"], home).stdout, "");
});

test("swarm init requires its dedicated Role and never falls back to the plan planner", (t) => {
  const home = tempDir(t);
  configureHome(home);
  rmSync(join(home, ".config/larp/roles/swarm-planner.md"));
  const result = invoke(home, ["swarm", "init", "--message", "Split this repository"], home);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No Role file .*swarm-planner\.md.*larp config/);
  assert.equal(invoke(home, ["swarm", "list"], home).stdout, "");
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
