#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { CONFIG_PATH, loadConfig, parseModel, participantsFor, type Model } from "./config.js";
import { openCodexHandoff } from "./handoff.js";
import { claudeHarness } from "./harness/claude.js";
import { codexHarness } from "./harness/codex.js";
import { ROLES, type Role } from "./message.js";
import { runRelay } from "./relay.js";
import { listRuns, RunStore } from "./run-store.js";
import { configure, createUI, pickModel } from "./tui.js";
import { initial, reduceWithCap } from "./workflow/plan.js";

const help = `larp config
larp plan "<task>" [--pick] [--planner harness:model] [--reviewer harness:model] [--quiet]
larp resume <run-id> [--quiet]
larp runs
larp show <run-id>

During a Turn, type @planner <message> (or another active Role).
Run artifacts are stored in ~/.larp/runs/. Configuration is required: larp config.`;
/** Parse commands and run the requested workflow; exported for CLI tests. */
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      pick: { type: "boolean" },
      quiet: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      planner: { type: "string" },
      reviewer: { type: "string" },
    },
  });
  if (values.help || !positionals.length) {
    console.log(help);
    return;
  }
  const [command, ...operands] = positionals;
  if (command !== "plan" && (values.pick || ROLES.some((role) => values[role])))
    throw new Error("Participant flags apply only to larp plan.");
  if (command === "config") {
    if (operands.length) throw new Error("Usage: larp config");
    await configure();
    return;
  }
  if (command === "runs") {
    if (operands.length) throw new Error("Usage: larp runs");
    for (const run of listRuns())
      console.log(`${run.id}\t${run.createdAt}\t${run.task.replaceAll("\n", " ")}`);
    return;
  }
  if (command === "show") {
    if (operands.length !== 1) throw new Error("Usage: larp show <run-id>");
    for (const item of RunStore.open(operands[0]!).entries()) console.log(JSON.stringify(item));
    return;
  }
  let run: RunStore;
  let verbose = false;
  if (command === "resume") {
    if (operands.length !== 1) throw new Error("Usage: larp resume <run-id>");
    run = RunStore.open(operands[0]!);
    if (existsSync(CONFIG_PATH)) verbose = loadConfig().verbose ?? false;
  } else if (command === "plan") {
    const task = operands.join(" ").trim();
    if (!task) throw new Error('Usage: larp plan "<task>"');
    const config = loadConfig();
    verbose = config.verbose ?? false;
    const overrides: Partial<Record<Role, Model>> = {};
    for (const role of ROLES) {
      const explicit = values[role];
      if (explicit) overrides[role] = parseModel(explicit);
      else if (values.pick)
        overrides[role] = await pickModel(role, config.models, config.defaults[role]);
    }
    run = RunStore.create(task, participantsFor(config, overrides));
  } else throw new Error(`Unknown command: ${command}\n${help}`);
  console.log(
    `Run ${run.data.id} · ${run.entries().reduce((state, item) => reduceWithCap(state, item, run.data.reviewRoundCap ?? 3), initial()).phase}`
  );
  const phase = await runRelay({
    run,
    participants: run.data.participants,
    harnesses: { claude: claudeHarness, codex: codexHarness },
    handoff: openCodexHandoff,
    ui: createUI({ quiet: values.quiet ?? false, verbose, cwd: run.data.cwd }),
  });
  console.log(`Run ${run.data.id}: ${phase}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
