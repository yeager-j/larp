import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { jsonEvent, spawnTurn } from "./spawn.js";
import type { Harness, ParsedEvent, TurnRequest } from "./types.js";

/** Build Claude arguments with the design's exact permission profiles. */
export function buildClaudeArgs(req: TurnRequest, sessionId: string): string[] {
  const permissions =
    req.permission === "write"
      ? ["--dangerously-skip-permissions"]
      : [
          "--permission-mode",
          "plan",
          "--permission-prompts",
          "none",
          "--tools",
          "Read,Glob,Grep,ToolSearch,Skill,Agent,Write",
          "--allowedTools",
          "Read,Glob,Grep,ToolSearch,Skill,Agent",
          "--disallowedTools",
          "Bash,Edit,NotebookEdit,ExitPlanMode",
        ];
  return [
    "-p",
    ...req.extraArgs,
    req.sessionId ? "--resume" : "--session-id",
    sessionId,
    "--settings",
    '{"disableAllHooks":true}',
    "--model",
    req.model,
    "--effort",
    req.effort,
    "--output-format",
    "stream-json",
    "--verbose",
    ...(req.schema ? ["--json-schema", JSON.stringify(req.schema)] : []),
    "--append-system-prompt",
    req.rolePrompt,
    ...permissions,
  ];
}
/** Normalize Claude stream-json records without relying on assistant free text for results. */
export function parseClaudeEvent(value: unknown): ParsedEvent {
  const parsed: ParsedEvent = { events: [] };
  if (!value || typeof value !== "object") return parsed;
  const event = value as Record<string, any>;
  if (typeof event.session_id === "string") {
    parsed.sessionId = event.session_id;
    parsed.events.push({ type: "session", sessionId: event.session_id });
  }
  if (event.type === "stream_event" && event.event?.delta?.type === "thinking_delta")
    parsed.events.push({ type: "thinking" });
  if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (block.type === "text" && typeof block.text === "string")
        parsed.events.push({ type: "text", text: block.text });
      if (block.type === "thinking") parsed.events.push({ type: "thinking" });
      if (block.type === "tool_use" && typeof block.name === "string")
        parsed.events.push({
          type: "tool",
          name: block.name,
          detail: JSON.stringify(block.input ?? {}),
        });
    }
  }
  if (event.type === "result") {
    parsed.output = event.structured_output;
    if (!event.is_error && typeof event.result === "string") parsed.text = event.result;
    const errors: string[] = [];
    if (event.is_error)
      errors.push(
        typeof event.result === "string"
          ? event.result
          : JSON.stringify(event.errors ?? "Claude reported an error")
      );
    if (Array.isArray(event.permission_denials) && event.permission_denials.length)
      errors.push(`Permission denials: ${JSON.stringify(event.permission_denials)}`);
    if (errors.length) parsed.error = errors.join("\n");
  }
  return parsed;
}
/** Claude CLI adapter; larp owns the UUID, including on resumed Turns. */
export const claudeHarness: Harness = {
  id: "claude",
  async runTurn(req) {
    const sessionId = req.sessionId ?? randomUUID();
    let output: unknown;
    const errors: string[] = [];
    if (req.schema)
      writeFileSync(join(req.turnDir, "schema.json"), JSON.stringify(req.schema, null, 2));
    const result = await spawnTurn({
      command: "claude",
      args: buildClaudeArgs(req, sessionId),
      cwd: req.cwd,
      turnDir: req.turnDir,
      stdin: req.first ? `${req.rolePrompt}\n\n${req.prompt}` : req.prompt,
      onLine(line) {
        const parsed = parseClaudeEvent(jsonEvent(line));
        for (const event of parsed.events) req.onEvent(event);
        const reply = req.schema ? parsed.output : parsed.text;
        if (reply !== undefined) output = reply;
        if (parsed.error) errors.push(parsed.error);
      },
    });
    if (result.error) errors.push(result.error);
    if (result.exitCode !== 0 && result.stderr) errors.push(result.stderr);
    if (output !== undefined) writeFileSync(join(req.turnDir, "last.json"), JSON.stringify(output));
    return {
      sessionId,
      exitCode: result.exitCode,
      output,
      ...(errors.length ? { error: errors.join("\n") } : {}),
    };
  },
};
