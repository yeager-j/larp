import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { HarnessId, Model } from "./config.js";
import { atomicWrite } from "./store.js";

/** A Role file: the instructions and Harness settings for one named job. */
export interface RoleDefinition {
  /** Role name, taken from the file name. */
  name: string;
  /** One line that tells a Caller when to use this Role. */
  description: string;
  /** Harness that runs the Role. */
  harness: HarnessId;
  /** Model name passed to the Harness. */
  model: string;
  /** Reasoning effort passed to the Harness. */
  effort: string;
  /** File access for an Agent. Workflows may apply a stricter limit. */
  permission: "read-only" | "write";
  /** Whether the Role may search and fetch the web. Defaults to true. */
  web: boolean;
  /** JSON Schema path for Agent replies, relative to the roles directory. */
  schema?: string;
  /** Additional arguments for each Harness. */
  extraArgs: Record<HarnessId, string[]>;
  /** Role instructions from the file body. */
  instructions: string;
}
/** Location of user-managed Role files. */
export const ROLES_PATH = join(homedir(), ".config/larp/roles");

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const KEYS = [
  "description",
  "harness",
  "model",
  "effort",
  "permission",
  "web",
  "schema",
  "claude-args",
  "codex-args",
] as const;
type Key = (typeof KEYS)[number];

/** Descriptions and instructions for the Roles that `larp config` creates. */
export const BUILT_IN_ROLES = {
  planner: {
    description: "Writes complete implementation plans grounded in repository evidence",
    instructions:
      "You are a planner. Produce complete, self-contained implementation plans grounded in repository evidence.",
  },
  reviewer: {
    description: "Critiques plans and changes for correctness risks",
    instructions:
      "You are a reviewer. Read what you are pointed to, inspect repository evidence, and report material problems first with file references. Say plainly when you find none.",
  },
  "swarm-planner": {
    description: "Splits repository tasks into manageable, independent swarm chunks",
    instructions: `You plan independent swarms. Inspect repository structure and applicable instructions before dividing the task. Use the task and intended execution Role guidance to estimate effort. Packages are a starting point, not a required boundary: split large areas and group small related areas. Aim for one useful result per chunk. Cover relevant root configuration, scripts, shared code, and tests. Exclude generated, vendor, and build content unless requested.
Prefer non-overlapping reporting scopes. Use explicit file groups where nested directories would duplicate coverage. Each focus must stand alone; chunks must not depend on other chunks' results. Split the task without performing the full work assigned to the chunk Participants.`,
  },
};

/** Built-in Role names offered by setup, independent of any one workflow's Participants. */
export type BuiltInRoleName = keyof typeof BUILT_IN_ROLES;

/** Build a read-only built-in Role with the given model and optional legacy settings. */
export function builtInRole(
  name: BuiltInRoleName,
  model: Model,
  settings?: { effort: string; extraArgs: Record<HarnessId, string[]> }
): RoleDefinition {
  return {
    name,
    ...BUILT_IN_ROLES[name],
    ...model,
    effort: settings?.effort ?? "high",
    permission: "read-only",
    web: true,
    extraArgs: settings?.extraArgs ?? { claude: [], codex: [] },
  };
}

/**
 * Parse Role file text. Frontmatter is one `key: value` pair per line; args values are JSON arrays.
 *
 * @throws When the name, a key, or a value is invalid.
 */
export function parseRole(name: string, text: string): RoleDefinition {
  if (!NAME.test(name)) throw new Error(`Invalid Role name: ${name}`);

  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error(`Role ${name} must start with --- frontmatter.`);

  const fields = parseFrontmatter(name, match[1]!);
  const field = (key: Key) => fields.get(key);
  const harness = field("harness");
  const permission = field("permission") ?? "read-only";
  const web = field("web") ?? "true";

  if (!field("description")) throw new Error(`Role ${name} needs a description.`);
  if (harness !== "claude" && harness !== "codex")
    throw new Error(`Role ${name} harness must be claude or codex.`);
  if (!field("model")) throw new Error(`Role ${name} needs a model.`);
  if (permission !== "read-only" && permission !== "write")
    throw new Error(`Role ${name} permission must be read-only or write.`);
  if (web !== "true" && web !== "false") throw new Error(`Role ${name} web must be true or false.`);

  const schema = field("schema");

  return {
    name,
    description: field("description")!,
    harness,
    model: field("model")!,
    effort: field("effort") ?? "high",
    permission,
    web: web === "true",
    ...(schema ? { schema } : {}),
    extraArgs: {
      claude: parseArgs(name, "claude-args", field("claude-args")),
      codex: parseArgs(name, "codex-args", field("codex-args")),
    },
    instructions: text.slice(match[0].length).trim(),
  };
}

function parseFrontmatter(name: string, text: string): Map<Key, string> {
  const fields = new Map<Key, string>();

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;

    const colon = line.indexOf(":");
    const key = line.slice(0, colon).trim() as Key;
    if (colon < 0 || !KEYS.includes(key))
      throw new Error(`Role ${name} has an unknown line: ${line}`);

    fields.set(key, line.slice(colon + 1).trim());
  }

  return fields;
}

function parseArgs(name: string, key: Key, value?: string): string[] {
  if (value === undefined) return [];

  let args: unknown;
  try {
    args = JSON.parse(value);
  } catch {
    args = undefined;
  }

  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))
    throw new Error(`Role ${name} ${key} must be a JSON array of strings.`);

  return args;
}

/** Render a Role as file text that `parseRole` reads back unchanged. */
export function renderRole(role: RoleDefinition): string {
  const lines = [
    "---",
    `description: ${role.description}`,
    `harness: ${role.harness}`,
    `model: ${role.model}`,
    `effort: ${role.effort}`,
    `permission: ${role.permission}`,
    `web: ${role.web}`,
    ...(role.schema ? [`schema: ${role.schema}`] : []),
    `claude-args: ${JSON.stringify(role.extraArgs.claude)}`,
    `codex-args: ${JSON.stringify(role.extraArgs.codex)}`,
    "---",
  ];

  return `${lines.join("\n")}\n${role.instructions ? `${role.instructions}\n` : ""}`;
}

/**
 * Load one Role file by name.
 *
 * @throws When the file is missing or invalid.
 */
export function loadRole(name: string, dir = ROLES_PATH): RoleDefinition {
  if (!NAME.test(name)) throw new Error(`Invalid Role name: ${name}`);

  const path = join(dir, `${name}.md`);
  if (!existsSync(path)) throw new Error(`No Role file ${path}. Run \`larp config\` or create it.`);

  return parseRole(name, readFileSync(path, "utf8"));
}

/** Load every Role file, sorted by name. */
export function listRoles(dir = ROLES_PATH): RoleDefinition[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => loadRole(file.slice(0, -3), dir));
}

/** Load the JSON Schema a Role names, or undefined when it has none. */
export function loadRoleSchema(role: RoleDefinition, dir = ROLES_PATH): object | undefined {
  if (!role.schema) return undefined;

  const schema = JSON.parse(readFileSync(resolve(dir, role.schema), "utf8"));
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    throw new Error(`Role ${role.name} schema must be a JSON object.`);

  return schema;
}

/** Atomically save a Role file. */
export function writeRole(role: RoleDefinition, dir = ROLES_PATH): void {
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, `${role.name}.md`), renderRole(role));
}
