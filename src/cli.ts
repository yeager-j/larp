#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { deliver, formatReplies } from "./agent/run.js";
import { AgentStore, listAgents } from "./agent/store.js";
import { CONFIG_PATH, loadConfig, parseModel, participantsFor, type Model } from "./config.js";
import { openCodexHandoff } from "./handoff.js";
import { claudeHarness } from "./harness/claude.js";
import { codexHarness } from "./harness/codex.js";
import { TURN_ENV, TurnInterrupted } from "./harness/spawn.js";
import { ROLES, type Role } from "./message.js";
import { runRelay } from "./relay.js";
import { listRoles, loadRole, loadRoleSchema, type RoleDefinition } from "./roles.js";
import { listRuns, RunStore } from "./run-store.js";
import { configure, createUI, pickModel } from "./tui.js";
import { initial, reduceWithCap } from "./workflow/plan.js";

const help = `larp config
larp plan "<task>" [--pick] [--planner harness:model] [--reviewer harness:model] [--quiet]
larp plan resume <run-id> [--quiet]
larp plan list
larp plan show <run-id>
larp agent start --role <name> --message "<text>"
larp agent message <agent-id> --message "<text>"
larp agent roles
larp agent list
larp agent show <agent-id>

During a plan Turn, type @planner <message> (or another active Role).
larp agent start and message block until the reply is ready, then print it.
Run them as background commands from a coding agent.

Roles: ~/.config/larp/roles/. Runs: ~/.larp/runs/. Agents: ~/.larp/agents/.`;
const harnesses = { claude: claudeHarness, codex: codexHarness };
const MOVED: Record<string, string> = {
  resume: "larp plan resume",
  runs: "larp plan list",
  show: "larp plan show",
};
type Options = {
  pick?: boolean;
  quiet?: boolean;
  planner?: string;
  reviewer?: string;
  role?: string;
  message?: string;
};

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
      role: { type: "string" },
      message: { type: "string" },
    },
  });
  if (values.help || !positionals.length) {
    console.log(help);
    return;
  }

  const [command, ...operands] = positionals;
  const planTask = command === "plan" && !["resume", "list", "show"].includes(operands[0]!);
  const agentTurn = command === "agent" && ["start", "message"].includes(operands[0]!);

  if (!planTask && (values.pick || ROLES.some((role) => values[role])))
    throw new Error('Participant flags apply only to larp plan "<task>".');
  if (!agentTurn && values.message !== undefined)
    throw new Error("--message applies only to larp agent start and message.");
  if (values.role && !(command === "agent" && operands[0] === "start"))
    throw new Error("--role applies only to larp agent start.");

  if (command === "config") {
    if (operands.length) throw new Error("Usage: larp config");
    await configure();
    return;
  }
  if (command === "plan") return planCommand(operands, values);
  if (command === "agent") return agentCommand(operands, values);
  if (MOVED[command!]) throw new Error(`larp ${command} is now ${MOVED[command!]}.`);

  throw new Error(`Unknown command: ${command}\n${help}`);
}

async function planCommand(operands: string[], values: Options): Promise<void> {
  const [subcommand, ...rest] = operands;

  if (subcommand === "list") {
    if (rest.length) throw new Error("Usage: larp plan list");
    for (const run of listRuns())
      console.log(`${run.id}\t${run.createdAt}\t${run.task.replaceAll("\n", " ")}`);
    return;
  }

  if (subcommand === "show") {
    if (rest.length !== 1) throw new Error("Usage: larp plan show <run-id>");
    for (const item of RunStore.open(rest[0]!).entries()) console.log(JSON.stringify(item));
    return;
  }

  if (subcommand === "resume") {
    if (rest.length !== 1) throw new Error("Usage: larp plan resume <run-id>");
    refuseInsideTurn("larp plan resume");
    const verbose = existsSync(CONFIG_PATH) ? (loadConfig().verbose ?? false) : false;
    await runPlan(RunStore.open(rest[0]!), values.quiet ?? false, verbose);
    return;
  }

  const task = operands.join(" ").trim();
  if (!task) throw new Error('Usage: larp plan "<task>"');
  refuseInsideTurn("larp plan");

  const config = loadConfig();
  const roles = Object.fromEntries(ROLES.map((role) => [role, loadRole(role)])) as Record<
    Role,
    RoleDefinition
  >;
  const overrides: Partial<Record<Role, Model>> = {};

  for (const role of ROLES) {
    const explicit = values[role];
    const current = { harness: roles[role].harness, model: roles[role].model };

    if (explicit) overrides[role] = parseModel(explicit);
    else if (values.pick) overrides[role] = await pickModel(role, config.models, current);
  }

  const run = RunStore.create(task, participantsFor(roles, overrides));
  await runPlan(run, values.quiet ?? false, config.verbose ?? false);
}

async function runPlan(run: RunStore, quiet: boolean, verbose: boolean): Promise<void> {
  const cap = run.data.reviewRoundCap ?? 3;
  const state = run.entries().reduce((state, item) => reduceWithCap(state, item, cap), initial());

  console.log(`Run ${run.data.id} · ${state.phase}`);

  const phase = await runRelay({
    run,
    participants: run.data.participants,
    harnesses,
    handoff: openCodexHandoff,
    ui: createUI({ quiet, verbose, cwd: run.data.cwd }),
  });

  console.log(`Run ${run.data.id}: ${phase}`);
}

async function agentCommand(operands: string[], values: Options): Promise<void> {
  const [subcommand, ...rest] = operands;

  if (subcommand === "roles") {
    if (rest.length) throw new Error("Usage: larp agent roles");
    for (const role of listRoles())
      console.log(
        `${role.name}\t${role.harness}:${role.model}\t${role.permission}\t${role.description}`
      );
    return;
  }

  if (subcommand === "list") {
    if (rest.length) throw new Error("Usage: larp agent list");
    for (const agent of listAgents())
      console.log(`${agent.id}\t${agent.createdAt}\t${agent.role}\t${agent.cwd}`);
    return;
  }

  if (subcommand === "show") {
    if (rest.length !== 1) throw new Error("Usage: larp agent show <agent-id>");
    for (const item of AgentStore.open(rest[0]!).entries()) console.log(JSON.stringify(item));
    return;
  }

  if (subcommand === "start") {
    const body = values.message?.trim();
    if (rest.length || !values.role || !body)
      throw new Error('Usage: larp agent start --role <name> --message "<text>"');
    refuseInsideTurn("larp agent start");

    const role = loadRole(values.role);
    const agent = AgentStore.create(role, loadRoleSchema(role));

    console.error(`[larp] agent ${agent.data.id} (${role.name}) started`);
    await sendAndPrint(agent, body);
    return;
  }

  if (subcommand === "message") {
    const body = values.message?.trim();
    if (rest.length !== 1 || !body)
      throw new Error('Usage: larp agent message <agent-id> --message "<text>"');
    refuseInsideTurn("larp agent message");

    await sendAndPrint(AgentStore.open(rest[0]!), body);
    return;
  }

  throw new Error(`Unknown agent command: ${subcommand ?? ""}\n${help}`);
}

async function sendAndPrint(agent: AgentStore, body: string): Promise<void> {
  const { id } = agent.data;
  const retry = `Send another message to deliver it: larp agent message ${id} --message "<text>"`;

  agent.append({
    id: randomUUID(),
    at: new Date().toISOString(),
    from: "caller",
    kind: "message",
    body,
  });

  let delivery: Awaited<ReturnType<typeof deliver>>;
  try {
    delivery = await deliver(agent, harnesses);
  } catch (error) {
    if (error instanceof TurnInterrupted)
      throw new Error(`Agent ${id} Turn interrupted; the message is still waiting. ${retry}`);
    throw error;
  }

  if (delivery.status === "queued") {
    console.log(
      `[larp] Queued for agent ${id}. larp process ${delivery.heldBy} is running a Turn; it will deliver this message and print the reply.`
    );
    return;
  }

  if (delivery.replies.length)
    console.log(formatReplies(agent.data, delivery.replies, agent.entries()));
  else if (delivery.status === "replied")
    console.log(
      `[larp] Another larp process delivered this message to agent ${id} and printed the reply.`
    );

  if (delivery.status === "failed")
    throw new Error(
      `Agent ${id} Turn failed: ${delivery.error}\nThe message is still waiting. ${retry}`
    );
}

function refuseInsideTurn(command: string): void {
  if (process.env[TURN_ENV])
    throw new Error(`${command} cannot run inside a larp Turn (${TURN_ENV} is set).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
