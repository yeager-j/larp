import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { ROLES, type Role } from "./message.js";
import { builtInRole, type RoleDefinition } from "./roles.js";

/** Supported external harness executables. */
export type HarnessId = "claude" | "codex";
/** A model bound to its harness. */
export interface Model {
  /** Harness that provides the model. */
  harness: HarnessId;
  /** Model name passed to the harness. */
  model: string;
}
/** A resolved role configuration saved for the lifetime of a Run. */
export interface Participant extends Model {
  /** Reasoning effort passed to the harness. */
  effort: string;
  /** Additional arguments for the selected harness. */
  extraArgs: string[];
  /** Role instructions; absent on Runs created before Role files. */
  instructions?: string;
}
/** Explicit user configuration written only by the config command. */
export interface Config {
  /** Show session events in terminal output. Defaults to false. */
  verbose?: boolean;
  /** Models offered by the configuration picker. */
  models: Model[];
}
/** Role settings kept in config.json before Role files; read only for migration. */
export interface LegacyConfig extends Config {
  /** Former default model for each Role. */
  defaults?: Partial<Record<string, Model>>;
  /** Former effort and harness arguments for each Role. */
  roles?: Partial<Record<string, { effort: string; extraArgs: Record<HarnessId, string[]> }>>;
}
/** Location of the user-managed config. */
export const CONFIG_PATH = join(homedir(), ".config/larp/config.json");
/** Built-in Claude choices; custom names can be supplied in the picker. */
export const CLAUDE_MODELS: Model[] = ["claude-fable-5-1", "haiku", "sonnet", "opus"].map(
  (model) => ({ harness: "claude", model })
);
/** Read the local Codex model cache without network calls. */
export function readCodexModels(path = join(homedir(), ".codex/models_cache.json")): {
  models: Model[];
  fetchedAt?: string;
} {
  if (!existsSync(path)) return { models: [] };
  const cache = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(cache.models)) throw new Error(`Invalid Codex model cache: ${path}`);
  return {
    models: cache.models
      .filter((model: { slug?: unknown }) => typeof model?.slug === "string")
      .map((model: { slug: string }) => ({ harness: "codex", model: model.slug })),
    ...(typeof cache.fetched_at === "string" ? { fetchedAt: cache.fetched_at } : {}),
  };
}
/** Parse an explicit harness:model selection. */
export function parseModel(value: string): Model {
  const colon = value.indexOf(":");
  const harness = value.slice(0, colon);
  const model = value.slice(colon + 1).trim();
  if (colon < 0 || (harness !== "claude" && harness !== "codex") || !model)
    throw new Error(`Expected claude:<model> or codex:<model>, received ${value}`);
  return { harness, model };
}
/** Load and validate config; never seed it implicitly. Legacy Role settings are kept for migration. */
export function loadConfig(path = CONFIG_PATH): LegacyConfig {
  if (!existsSync(path)) throw new Error("No larp configuration. Run `larp config` first.");
  const config = JSON.parse(readFileSync(path, "utf8")) as LegacyConfig;
  if (config.verbose !== undefined && typeof config.verbose !== "boolean")
    throw new Error("Config verbose must be a boolean.");
  if (!Array.isArray(config.models))
    throw new Error("Config models must be an array. Run `larp config`.");
  for (const model of config.models) {
    if (!model || typeof model.model !== "string")
      throw new Error("Invalid model in config. Run `larp config`.");
    parseModel(`${model.harness}:${model.model}`);
  }
  return config;
}
/** Convert valid legacy Planner and Reviewer settings into built-in Roles. */
export function legacyRoles(config: LegacyConfig): Partial<Record<Role, RoleDefinition>> {
  const roles: Partial<Record<Role, RoleDefinition>> = {};
  for (const role of ROLES) {
    const model = config.defaults?.[role];
    if (!model || (model.harness !== "claude" && model.harness !== "codex") || !model.model)
      continue;
    const settings = config.roles?.[role];
    const valid =
      typeof settings?.effort === "string" &&
      (["claude", "codex"] as const).every(
        (harness) =>
          Array.isArray(settings.extraArgs?.[harness]) &&
          settings.extraArgs[harness].every((arg) => typeof arg === "string")
      );
    roles[role] = builtInRole(
      role,
      { harness: model.harness, model: model.model },
      valid ? settings : undefined
    );
  }
  return roles;
}
/** Atomically save an explicitly selected configuration. */
export function writeConfig(config: Config, path = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
/** Resolve a Role and an optional model override into a durable Participant. */
export function participantFor(role: RoleDefinition, override?: Model): Participant {
  const model = override ?? { harness: role.harness, model: role.model };
  return {
    ...model,
    effort: role.effort,
    extraArgs: role.extraArgs[model.harness],
    instructions: role.instructions,
  };
}
/** Resolve Workflow Roles and per-role overrides into durable Participants. */
export function participantsFor(
  roles: Record<Role, RoleDefinition>,
  overrides: Partial<Record<Role, Model>> = {}
): Record<Role, Participant> {
  return Object.fromEntries(
    ROLES.map((role) => [role, participantFor(roles[role], overrides[role])])
  ) as Record<Role, Participant>;
}
