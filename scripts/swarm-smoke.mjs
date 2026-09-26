import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { codexHarness } from "../dist/harness/codex.js";
import { TURN_ENV } from "../dist/harness/spawn.js";
import { parseChunkDocument } from "../dist/swarm/chunks.js";
import { createSwarmOutput } from "../dist/swarm/output.js";
import { runSwarm } from "../dist/swarm/run.js";
import { SwarmStore } from "../dist/swarm/store.js";

if (process.env.LARP_LIVE_SMOKE !== "1") {
  console.error("Opt in with LARP_LIVE_SMOKE=1 npm run smoke:swarm.");
  process.exit(1);
}
if (process.env[TURN_ENV]) {
  console.error(`The live swarm smoke test cannot run inside a LARP Turn (${TURN_ENV} is set).`);
  process.exit(1);
}

const cwd = fileURLToPath(new URL("../", import.meta.url));
const modules = readdirSync(join(cwd, "src"), { recursive: true, withFileTypes: true })
  .filter(
    (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
  )
  .map((entry) => join(entry.parentPath, entry.name).slice(cwd.length).replaceAll("\\", "/"))
  .sort();

const participant = {
  harness: "codex",
  model: "gpt-6-luna",
  effort: "medium",
  extraArgs: [],
  web: false,
};
const instructions = `Explain what each assigned LARP source module does. For each file, write a Markdown heading containing its exact repository-relative path, then two to four sentences about its responsibility and how it connects to other modules. Read the files before explaining them. Simply explain the existing code; do not review style, propose changes, run tests, or edit files. Use your own tools directly; do not delegate to subagents.`;
const task = `Explain what every non-test TypeScript module under src/ in LARP does. Include test-support.ts as a source module. Split the work into 3 to 6 independent chunks of related modules. Use only explicit file paths from the inventory below: include every file exactly once across all chunk paths, with no directories, omitted files, duplicate paths, or additional files. Each chunk must explain all its assigned modules. Do not delegate to subagents.\n\nModule inventory:\n${modules.join("\n")}`;

let calls = 0;
let running = 0;
let peak = 0;
const harnesses = {
  codex: {
    id: "codex",
    async runTurn(request) {
      assert.equal(request.model, "gpt-6-luna");
      assert.equal(request.effort, "medium");
      assert.equal(request.permission, "read-only");
      assert.equal(request.web, false);
      calls++;
      peak = Math.max(peak, ++running);
      try {
        return await codexHarness.runTurn(request);
      } finally {
        running--;
      }
    },
  },
  claude: {
    id: "claude",
    async runTurn() {
      throw new Error("This smoke test must use Codex gpt-6-luna for every Turn.");
    },
  },
};

async function smoke() {
  assert.ok(modules.length > 0, "The source module inventory must not be empty.");
  console.log(
    `Live swarm smoke test: ${participant.model}, ${participant.effort} effort, ${modules.length} modules.`
  );
  const draft = SwarmStore.createDraft(
    {
      task,
      participant: {
        ...participant,
        instructions:
          "Inspect the repository and split the task according to the requested file inventory and chunk count. Do not delegate to subagents.",
      },
      roleContext: {
        name: "module-explainer",
        description: "Explains existing source modules",
        instructions,
      },
    },
    undefined,
    cwd
  );
  console.log(`Draft: ${draft.data.id}`);
  await runSwarm(draft, harnesses, createSwarmOutput());
  const document = parseChunkDocument(JSON.parse(readFileSync(draft.chunksPath, "utf8")));
  assert.ok(
    document.chunks.length >= 3 && document.chunks.length <= 6,
    `Expected 3–6 chunks; inspect ${draft.chunksPath}.`
  );
  assert.deepEqual(
    document.chunks.flatMap((chunk) => chunk.paths).sort(),
    modules,
    `Every module must appear exactly once; inspect ${draft.chunksPath}.`
  );

  const execution = SwarmStore.startExecution(
    draft.chunksPath,
    {
      role: "module-explainer",
      participant: { ...participant, instructions },
      parallel: 3,
    },
    undefined,
    cwd
  );
  assert.equal(execution.data.id, draft.data.id);
  assert.equal(execution.outputPath, join(draft.directory, "results"));
  console.log(`Execution: ${execution.data.id}`);
  const outcome = await runSwarm(execution, harnesses, createSwarmOutput());
  assert.equal(outcome.kind, "execution");
  assert.equal(
    outcome.failed.length,
    0,
    `Failed chunks: ${outcome.failed.join(", ")}. Resume with: node dist/cli.js swarm resume ${execution.data.id}`
  );
  assert.equal(outcome.complete, document.chunks.length);
  assert.equal(peak, 3, "The execution must exercise three simultaneous Harness Turns.");
  assert.equal(
    calls,
    1 + document.chunks.length,
    "One splitter and one Turn per chunk should run."
  );

  for (const chunk of document.chunks) {
    const path = join(execution.outputPath, `${chunk.id}.md`);
    const report = readFileSync(path, "utf8");
    assert.ok(report.trim(), `Empty report: ${path}`);
    for (const module of chunk.paths)
      assert.ok(report.includes(module), `${path} does not mention assigned module ${module}.`);
  }

  const callsBeforeResume = calls;
  const entriesBeforeResume = execution.entries();
  const resumed = await runSwarm(
    SwarmStore.open(execution.data.id),
    harnesses,
    createSwarmOutput()
  );
  assert.deepEqual(resumed, outcome);
  assert.equal(calls, callsBeforeResume, "Resuming a complete swarm must not launch more agents.");
  assert.deepEqual(execution.entries(), entriesBeforeResume);

  console.log(
    `PASS: ${modules.length} modules explained in ${document.chunks.length} reports; completed resume launched no agents.`
  );
  console.log(
    `Model: ${participant.model} · effort ${participant.effort} · ${calls} real Turns · peak concurrency ${peak}`
  );
  console.log(`Chunks: ${draft.chunksPath}`);
  console.log(`Reports: ${execution.outputPath}`);
}

smoke().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
