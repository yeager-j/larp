import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { jsonEvent, spawnTurn } from "./spawn.js";
import type { Harness, ParsedEvent, TurnRequest } from "./types.js";

/** Build first/resumed exec arguments; cwd belongs to spawn, never -C. */
export function buildCodexArgs(req: TurnRequest): string[] {
  const prompt = req.first ? `${req.rolePrompt}\n\n${req.prompt}` : req.prompt;
  return [
    "exec",
    ...(req.sessionId ? ["resume", req.sessionId] : []),
    ...req.extraArgs,
    "--json",
    "-m",
    req.model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(req.effort)}`,
    "-c",
    `sandbox_mode=${JSON.stringify(req.permission === "write" ? "workspace-write" : "read-only")}`,
    "--output-schema",
    join(req.turnDir, "schema.json"),
    "-o",
    join(req.turnDir, "last.json"),
    "--",
    prompt,
  ];
}
/** Normalize Codex JSON events; agent messages are progress, never final output. */
export function parseCodexEvent(value: unknown): ParsedEvent {
  const parsed: ParsedEvent = { events: [] };
  if (!value || typeof value !== "object") return parsed;
  const event = value as Record<string, any>;
  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    parsed.sessionId = event.thread_id;
    parsed.events.push({ type: "session", sessionId: event.thread_id });
  }
  if (event.type === "item.completed") {
    const item = event.item;
    if (item?.type === "agent_message" && typeof item.text === "string")
      parsed.events.push({ type: "text", text: item.text });
    else if (item?.type === "reasoning") parsed.events.push({ type: "thinking" });
    else if (item && typeof item.type === "string")
      parsed.events.push({
        type: "tool",
        name: item.type,
        detail: item.command ?? JSON.stringify(item),
      });
  }
  if (event.type === "turn.failed" || event.type === "error")
    parsed.error = event.error?.message ?? event.message ?? JSON.stringify(event);
  return parsed;
}
/** Read only the final-message artifact, treating malformed JSON as schema failure. */
export function readCodexOutput(turnDir: string): unknown {
  const path = join(turnDir, "last.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}
/** Codex exec adapter, with session IDs sourced solely from thread.started. */
export const codexHarness: Harness = {
  id: "codex",
  async runTurn(req) {
    writeFileSync(join(req.turnDir, "schema.json"), JSON.stringify(req.schema, null, 2));
    let sessionId = req.sessionId ?? "";
    const errors: string[] = [];
    const result = await spawnTurn({
      command: "codex",
      args: buildCodexArgs(req),
      cwd: req.cwd,
      turnDir: req.turnDir,
      onLine(line) {
        const parsed = parseCodexEvent(jsonEvent(line));
        if (parsed.sessionId) sessionId = parsed.sessionId;
        if (parsed.error) errors.push(parsed.error);
        for (const event of parsed.events) req.onEvent(event);
      },
    });
    if (result.error) errors.push(result.error);
    if (result.exitCode !== 0 && result.stderr) errors.push(result.stderr);
    if (!sessionId) errors.push("Codex did not emit thread.started.");
    return {
      sessionId,
      exitCode: result.exitCode,
      output: readCodexOutput(req.turnDir),
      ...(errors.length ? { error: errors.join("\n") } : {}),
    };
  },
};
