import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { ROLES, type Role } from "./message.js";

/** Supported external harness executables. */
export type HarnessId = "claude" | "codex";
/** A model bound to its harness. */
export interface Model {
  harness: HarnessId;
  model: string;
}
/** A resolved role configuration saved for the lifetime of a Run. */
export interface Participant extends Model {
  effort: string;
  extraArgs: string[];
}
/** Explicit user configuration written only by the config command. */
export interface Config {
  /** Show session events in terminal output. Defaults to false. */
  verbose?: boolean;
  models: Model[];
  defaults: Record<Role, Model>;
  roles: Record<Role, { effort: string; extraArgs: Record<HarnessId, string[]> }>;
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
/** Load and validate config; never seed it implicitly. */
export function loadConfig(path = CONFIG_PATH): Config {
  if (!existsSync(path)) throw new Error("No larp configuration. Run `larp config` first.");
  const config = JSON.parse(readFileSync(path, "utf8")) as Config;
  if (config.verbose !== undefined && typeof config.verbose !== "boolean")
    throw new Error("Config verbose must be a boolean.");
  if (!Array.isArray(config.models))
    throw new Error("Config models must be an array. Run `larp config`.");
  for (const model of [...config.models, ...ROLES.map((role) => config.defaults?.[role])]) {
    if (!model || typeof model.model !== "string")
      throw new Error("Invalid model in config. Run `larp config`.");
    parseModel(`${model.harness}:${model.model}`);
  }
  for (const role of ROLES) {
    const settings = config.roles?.[role];
    if (!settings || typeof settings.effort !== "string" || !settings.effort.trim())
      throw new Error(`Invalid settings for ${role}. Run \`larp config\`.`);
    for (const harness of ["claude", "codex"] as const) {
      if (
        !Array.isArray(settings.extraArgs?.[harness]) ||
        !settings.extraArgs[harness].every((arg) => typeof arg === "string")
      )
        throw new Error(`Invalid extraArgs for ${role}/${harness}.`);
    }
  }
  return config;
}
/** Atomically save an explicitly selected configuration. */
export function writeConfig(config: Config, path = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
/** Resolve defaults and per-role overrides into durable Participants. */
export function participantsFor(
  config: Config,
  overrides: Partial<Record<Role, Model>> = {}
): Record<Role, Participant> {
  return Object.fromEntries(
    ROLES.map((role) => {
      const model = overrides[role] ?? config.defaults[role];
      return [
        role,
        {
          ...model,
          effort: config.roles[role].effort,
          extraArgs: config.roles[role].extraArgs[model.harness],
        },
      ];
    })
  ) as Record<Role, Participant>;
}
