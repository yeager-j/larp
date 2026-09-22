import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import * as clack from "@clack/prompts";

import {
  CLAUDE_MODELS,
  CONFIG_PATH,
  loadConfig,
  readCodexModels,
  writeConfig,
  type Config,
  type Model,
} from "./config.js";
import { ROLES, type Role } from "./message.js";
import { createOutput } from "./output.js";
import type { RelayUI } from "./relay.js";

function requireTerminal(): void {
  if (!process.stdin.isTTY)
    throw new Error(
      "Interactive input requires a terminal. Resume this Run in a terminal to act at the Gate."
    );
}
function selected<T>(value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) throw new Error("Cancelled.");
  return value as Exclude<T, symbol>;
}
/** Pick a model, with an escape hatch for model names absent from local lists. */
export async function pickModel(role: Role, models: Model[], current?: Model): Promise<Model> {
  requireTerminal();
  const choices = [
    ...new Map(models.map((model) => [`${model.harness}:${model.model}`, model])).values(),
  ];
  const choice = selected(
    await clack.select({
      message: `Default ${role}`,
      options: [
        ...choices.map((model) => ({
          value: `${model.harness}:${model.model}`,
          label: `${model.model} (${model.harness})`,
        })),
        { value: "custom", label: "Enter another model" },
      ],
      ...(current ? { initialValue: `${current.harness}:${current.model}` } : {}),
    })
  );
  if (choice !== "custom")
    return choices.find((model) => `${model.harness}:${model.model}` === choice)!;
  const harness = selected(
    await clack.select({
      message: "Harness",
      options: [
        { value: "claude" as const, label: "Claude" },
        { value: "codex" as const, label: "Codex" },
      ],
    })
  );
  const model = selected(
    await clack.text({
      message: "Model name",
      validate: (value) => (value?.trim() ? undefined : "Enter a model name."),
    })
  ).trim();
  return { harness, model };
}
/** Refresh local model choices and explicitly save defaults. */
export async function configure(): Promise<void> {
  requireTerminal();
  const previous = existsSync(CONFIG_PATH) ? loadConfig() : undefined;
  const codex = readCodexModels();
  clack.intro("larp configuration");
  clack.log.info(
    `Codex cache fetched: ${codex.fetchedAt ?? "unavailable"}. Run codex to refresh its cache.`
  );
  const models = [...CLAUDE_MODELS, ...codex.models, ...(previous?.models ?? [])];
  const defaults = {} as Record<Role, Model>;
  for (const role of ROLES) {
    defaults[role] = await pickModel(role, models, previous?.defaults[role]);
    models.push(defaults[role]);
  }
  const roles =
    previous?.roles ??
    (Object.fromEntries(
      ROLES.map((role) => [role, { effort: "high", extraArgs: { claude: [], codex: [] } }])
    ) as unknown as Config["roles"]);
  writeConfig({
    verbose: previous?.verbose ?? false,
    models: [
      ...new Map(models.map((model) => [`${model.harness}:${model.model}`, model])).values(),
    ],
    defaults,
    roles,
  });
  clack.outro(`Saved ${CONFIG_PATH}`);
}
/** Recognize only explicit @role interjections with a nonempty message. */
export function parseInterjection(line: string): { role: Role; body: string } | null {
  const match = /^@(planner|reviewer|implementer)\s+(.+)$/.exec(line.trim());
  return match ? { role: match[1] as Role, body: match[2]!.trim() } : null;
}
/** Build terminal Gates and a cancellable stdin reader that yields ownership to clack. */
export function createUI({
  quiet = false,
  verbose = false,
  cwd = process.cwd(),
}: { quiet?: boolean; verbose?: boolean; cwd?: string } = {}): RelayUI {
  return {
    ...createOutput({ quiet, verbose, cwd }),
    log: (line) => console.log(line),
    async phaseGate(state, planPath) {
      requireTerminal();
      clack.note(
        planPath ? `Plan: ${planPath}` : "The Planner needs your answer before continuing.",
        planPath ? "Ready to implement · Phase Gate" : "Planner question · Phase Gate"
      );
      const kind = selected(
        await clack.select({
          message: "Next action",
          options: [
            ...(state.lastPlanEntryId
              ? [{ value: "approve" as const, label: "Approve implementation" }]
              : []),
            { value: "feedback" as const, label: "Message the Planner" },
            { value: "abort" as const, label: "Abort" },
          ],
        })
      );
      if (kind === "feedback")
        return {
          kind,
          body: selected(
            await clack.text({
              message: "Message to Planner",
              validate: (value) => (value?.trim() ? undefined : "Enter a message."),
            })
          ),
        };
      return { kind };
    },
    async failureGate(state) {
      requireTerminal();
      clack.note(`${state.failure?.role}: ${state.failure?.body}`, "Turn failed · Failure Gate");
      const action = selected(
        await clack.select({
          message: "Next action",
          options: [
            { value: "retry", label: "Retry" },
            { value: "note", label: "Retry with a note" },
            { value: "abort", label: "Abort" },
          ],
        })
      );
      if (action === "abort") return { kind: "abort" };
      return {
        kind: "retry",
        body:
          action === "note"
            ? selected(
                await clack.text({
                  message: "Retry note",
                  validate: (value) => (value?.trim() ? undefined : "Enter a note."),
                })
              )
            : "",
      };
    },
    async *interjections(signal) {
      if (!process.stdin.isTTY || signal?.aborted) return;
      const reader = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: Boolean(process.stdout.isTTY),
      });
      const queue: string[] = [];
      let closed = false;
      let wake: (() => void) | undefined;
      const close = () => {
        closed = true;
        reader.close();
        wake?.();
      };
      reader.on("line", (line) => {
        queue.push(line);
        wake?.();
      });
      reader.on("close", () => {
        closed = true;
        wake?.();
      });
      reader.on("SIGINT", () => process.kill(process.pid, "SIGINT"));
      signal?.addEventListener("abort", close, { once: true });
      try {
        while (!closed) {
          if (!queue.length)
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          while (queue.length && !signal?.aborted) {
            const message = parseInterjection(queue.shift()!);
            if (message) yield message;
            else console.log("Use @planner, @reviewer, or @implementer followed by a message.");
          }
        }
      } finally {
        signal?.removeEventListener("abort", close);
        reader.close();
        process.stdin.pause();
      }
    },
  };
}
