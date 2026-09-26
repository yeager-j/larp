#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { deliver, formatReplies } from "./agent/run.js";
import { AgentStore, listAgents } from "./agent/store.js";
import {
  CONFIG_PATH,
  loadConfig,
  parseModel,
  participantFor,
  participantsFor,
  type Model,
  type Participant,
} from "./config.js";
import { createDiscussOutput } from "./discuss/output.js";
import { formatOutcome, runDiscussion } from "./discuss/run.js";
import { DiscussionStore, listDiscussions } from "./discuss/store.js";
import { DEFAULT_ROUNDS, MAX_ROUNDS } from "./discuss/workflow.js";
import { openCodexHandoff } from "./handoff.js";
import { claudeHarness } from "./harness/claude.js";
import { codexHarness } from "./harness/codex.js";
import { TURN_ENV } from "./harness/spawn.js";
import { ROLES, type Role } from "./message.js";
import { runRelay } from "./relay.js";
import { listRoles, loadRole, loadRoleSchema, type RoleDefinition } from "./roles.js";
import { listRuns, RunStore } from "./run-store.js";
import { parseChunkDocument, parseParallel } from "./swarm/chunks.js";
import { createSwarmOutput, terminalText } from "./swarm/output.js";
import { executionProgress, runSwarm } from "./swarm/run.js";
import { listSwarms, SwarmStore } from "./swarm/store.js";
import { configure, createUI, pickModel } from "./tui.js";
import { replay, ROUND_CAP } from "./workflow/plan.js";

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
larp discuss --author <role|harness:model> --critic <role|harness:model> --message "<text>" [--blind] [--max-rounds n]
larp discuss resume <discussion-id>
larp discuss continue <discussion-id> --message "<text>"
larp discuss list
larp discuss show <discussion-id>
larp swarm init --message "<text>" [--role <name>]
larp swarm start --chunks <path> --role <name> [--parallel 1-8] [--out <new-directory>]
larp swarm resume <swarm-id>
larp swarm list
larp swarm show <swarm-id>

During a plan Turn, type @planner <message> (or another active Role).
larp agent start and message block until the reply is ready, then print it.
larp discuss blocks until the Critic agrees (exit 0) or the round cap is reached (exit 2).
Run them as background commands from a coding agent.
Swarm commands block and display live chunk status on stderr (plain logs when redirected).
init uses the planner Role; --role supplies context. start always creates a new execution.
Chunk paths are relative to start's working directory. Resume reads current repository files
in the saved directory, uses saved inputs, and retries only unfinished chunks.
--parallel defaults to 3. --out must not exist. Result files are generated and replaced on resume.

Roles: ~/.config/larp/roles/. Runs: ~/.larp/runs/. Agents: ~/.larp/agents/.
Discussions: ~/.larp/discussions/. Swarms: ~/.larp/swarms/.`;
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
  author?: string;
  critic?: string;
  blind?: boolean;
  "max-rounds"?: string;
  chunks?: string;
  parallel?: string;
  out?: string;
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
      author: { type: "string" },
      critic: { type: "string" },
      blind: { type: "boolean" },
      "max-rounds": { type: "string" },
      chunks: { type: "string" },
      parallel: { type: "string" },
      out: { type: "string" },
    },
  });
  if (values.help || !positionals.length) {
    console.log(help);
    return;
  }

  const [command, ...operands] = positionals;
  const planTask = command === "plan" && !["resume", "list", "show"].includes(operands[0]!);
  const agentTurn = command === "agent" && ["start", "message"].includes(operands[0]!);
  const discussStart =
    command === "discuss" && !["resume", "continue", "list", "show"].includes(operands[0]!);
  const discussContinue = command === "discuss" && operands[0] === "continue";
  const swarmInit = command === "swarm" && operands[0] === "init";
  const swarmStart = command === "swarm" && operands[0] === "start";

  if (!planTask && (values.pick || ROLES.some((role) => values[role])))
    throw new Error('Participant flags apply only to larp plan "<task>".');
  if (!agentTurn && !discussStart && !discussContinue && !swarmInit && values.message !== undefined)
    throw new Error(
      "--message applies only to larp agent start, larp agent message, starting a larp discuss, larp discuss continue, and larp swarm init."
    );
  if (
    !discussStart &&
    [values.author, values.critic, values.blind, values["max-rounds"]].some((v) => v !== undefined)
  )
    throw new Error(
      "--author, --critic, --blind, and --max-rounds apply only when starting a larp discuss."
    );
  if (
    values.role !== undefined &&
    !(command === "agent" && operands[0] === "start") &&
    !swarmInit &&
    !swarmStart
  )
    throw new Error(
      "--role applies only to larp agent start, larp swarm init, and larp swarm start."
    );
  if (
    !swarmStart &&
    [values.chunks, values.parallel, values.out].some((value) => value !== undefined)
  )
    throw new Error("--chunks, --parallel, and --out apply only to larp swarm start.");
  if (command === "swarm" && values.quiet !== undefined)
    throw new Error("--quiet does not apply to larp swarm.");

  if (command === "config") {
    if (operands.length) throw new Error("Usage: larp config");
    await configure();
    return;
  }
  if (command === "plan") return planCommand(operands, values);
  if (command === "agent") return agentCommand(operands, values);
  if (command === "discuss") return discussCommand(operands, values);
  if (command === "swarm") return swarmCommand(operands, values);
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

  const run = RunStore.create({
    task,
    participants: participantsFor(roles, overrides),
    reviewRoundCap: ROUND_CAP,
  });
  await runPlan(run, values.quiet ?? false, config.verbose ?? false);
}

async function runPlan(run: RunStore, quiet: boolean, verbose: boolean): Promise<void> {
  const state = replay(run.entries(), run.data.reviewRoundCap);

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

  const delivery = await deliver(agent, harnesses);

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
  if (delivery.status === "interrupted")
    throw new Error(`Agent ${id} Turn interrupted; the message is still waiting. ${retry}`);
}

async function discussCommand(operands: string[], values: Options): Promise<void> {
  const [subcommand, ...rest] = operands;

  if (subcommand === "list") {
    if (rest.length) throw new Error("Usage: larp discuss list");
    for (const data of listDiscussions())
      console.log(`${data.id}\t${data.createdAt}\t${data.task.replaceAll("\n", " ")}`);
    return;
  }

  if (subcommand === "show") {
    if (rest.length !== 1) throw new Error("Usage: larp discuss show <discussion-id>");
    for (const item of DiscussionStore.open(rest[0]!).entries()) console.log(JSON.stringify(item));
    return;
  }

  if (subcommand === "resume") {
    if (rest.length !== 1) throw new Error("Usage: larp discuss resume <discussion-id>");
    refuseInsideTurn("larp discuss resume");

    await discussAndPrint(DiscussionStore.open(rest[0]!));
    return;
  }

  if (subcommand === "continue") {
    const followup = values.message?.trim();
    if (rest.length !== 1 || !followup)
      throw new Error('Usage: larp discuss continue <discussion-id> --message "<text>"');
    refuseInsideTurn("larp discuss continue");

    await discussAndPrint(DiscussionStore.open(rest[0]!), followup);
    return;
  }

  const task = values.message?.trim();
  if (operands.length || !task || !values.author || !values.critic)
    throw new Error(
      'Usage: larp discuss --author <role|harness:model> --critic <role|harness:model> --message "<text>" [--blind] [--max-rounds n]'
    );
  refuseInsideTurn("larp discuss");

  const store = DiscussionStore.create({
    task,
    blind: values.blind ?? false,
    maxRounds: parseRounds(values["max-rounds"]),
    participants: {
      author: parseParticipantSpec(values.author),
      critic: parseParticipantSpec(values.critic),
    },
  });

  console.error(`[larp] discussion ${store.data.id} started`);
  await discussAndPrint(store);
}

async function discussAndPrint(store: DiscussionStore, followup?: string): Promise<void> {
  // stdout carries only the outcome, so the transcript goes to stderr.
  const terminal = Boolean(process.stderr.isTTY) && process.env.TERM !== "dumb";
  const ui = createDiscussOutput({
    terminal,
    cwd: store.data.cwd,
    write: (line) => console.error(line),
  });
  const outcome = await runDiscussion(store, harnesses, ui, followup);

  console.log(formatOutcome(store.data, outcome));
  if (outcome.kind === "capped") process.exitCode = 2;
}

/** A value with a colon is harness:model with Role defaults; any other value names a Role file. */
function parseParticipantSpec(value: string): Participant {
  if (value.includes(":"))
    return { ...parseModel(value), effort: "high", extraArgs: [], web: true };

  return participantFor(loadRole(value));
}

function parseRounds(value?: string): number {
  if (value === undefined) return DEFAULT_ROUNDS;

  const rounds = Number(value);
  if (!/^\d+$/.test(value) || rounds < 1 || rounds > MAX_ROUNDS)
    throw new Error(`--max-rounds must be an integer from 1 to ${MAX_ROUNDS}.`);

  return rounds;
}

async function swarmCommand(operands: string[], values: Options): Promise<void> {
  const [command, ...rest] = operands;
  if (command === "list") {
    if (rest.length) throw new Error("Usage: larp swarm list");
    for (const data of listSwarms()) {
      const entries = SwarmStore.open(data.id).entries();
      const task = data.kind === "draft" ? data.task : data.document.task;
      const progress =
        data.kind === "draft"
          ? entries.some((entry) => entry.kind === "split")
            ? "ready"
            : "unfinished"
          : `${executionProgress(data, entries).complete}/${data.document.chunks.length} complete`;
      console.log(
        terminalText(`${data.id}\t${data.kind}\t${data.createdAt}\t${progress}\t${task}`)
      );
    }
    return;
  }
  if (command === "show") {
    if (rest.length !== 1) throw new Error("Usage: larp swarm show <swarm-id>");
    const store = SwarmStore.open(rest[0]!);
    console.log(
      JSON.stringify(
        {
          ...store.data,
          outputPath: store.data.kind === "draft" ? store.chunksPath : store.outputPath,
          entries: store.entries(),
        },
        null,
        2
      )
    );
    return;
  }
  if (command === "resume") {
    if (rest.length !== 1) throw new Error("Usage: larp swarm resume <swarm-id>");
    refuseInsideTurn("larp swarm resume");
    await swarmAndPrint(SwarmStore.open(rest[0]!));
    return;
  }
  if (command === "init") {
    const task = values.message?.trim();
    if (rest.length || !task)
      throw new Error('Usage: larp swarm init --message "<text>" [--role <name>]');
    refuseInsideTurn("larp swarm init");
    const role = values.role === undefined ? undefined : loadRole(values.role);
    const store = SwarmStore.createDraft({
      task,
      participant: participantFor(loadRole("planner")),
      ...(role
        ? {
            roleContext: {
              name: role.name,
              description: role.description,
              instructions: role.instructions,
            },
          }
        : {}),
    });
    await swarmAndPrint(store);
    return;
  }
  if (command === "start") {
    if (rest.length || !values.chunks || !values.role || values.out === "")
      throw new Error(
        "Usage: larp swarm start --chunks <path> --role <name> [--parallel 1-8] [--out <new-directory>]"
      );
    refuseInsideTurn("larp swarm start");
    const parallel = parseParallel(values.parallel);
    const document = parseChunkDocument(JSON.parse(readFileSync(values.chunks, "utf8")));
    const role = loadRole(values.role);
    const store = SwarmStore.createExecution({
      document,
      role: role.name,
      participant: participantFor(role),
      parallel,
      ...(values.out === undefined ? {} : { out: values.out }),
    });
    await swarmAndPrint(store);
    return;
  }
  throw new Error(`Unknown swarm command: ${command ?? ""}\n${help}`);
}

async function swarmAndPrint(store: SwarmStore): Promise<void> {
  const outcome = await runSwarm(store, harnesses, createSwarmOutput());
  if (outcome.kind === "draft") {
    console.log(outcome.path);
    return;
  }
  console.log(
    `Swarm ${store.data.id}: ${outcome.complete} succeeded, ${outcome.failed.length} failed.`
  );
  console.log(`Results: ${terminalText(store.outputPath)}`);
  if (outcome.failed.length) {
    console.log(`Failed: ${outcome.failed.join(", ")}`);
    console.log(`Resume: larp swarm resume ${store.data.id}`);
    process.exitCode = 1;
  }
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
