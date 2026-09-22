import { isAbsolute, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { HarnessEvent } from "./harness/types.js";
import type { Entry, Role } from "./message.js";

const ROLE_COLOR: Record<Role, number> = { planner: 36, reviewer: 35 };
const STATUS: Partial<Record<Entry["kind"], string>> = {
  request: "Plan ready for review",
  approve: "Approved",
  feedback: "Feedback",
  question: "Question",
  done: "Complete",
  handoff: "Opened in Codex",
};
function title(value: string): string {
  return value[0]!.toUpperCase() + value.slice(1);
}
function shortTool(event: Extract<HarnessEvent, { type: "tool" }>, cwd: string): string {
  let detail = event.detail ?? "";
  try {
    const input = JSON.parse(detail);
    detail =
      [
        input.file_path,
        input.path,
        input.command,
        input.pattern,
        input.query,
        input.description,
        input.message,
      ].find((value) => typeof value === "string") ?? "";
  } catch {
    /* Plain command strings are already readable. */
  }
  if (isAbsolute(detail)) detail = relative(cwd, detail) || ".";
  detail = stripVTControlCharacters(detail).replace(/\s+/g, " ").trim();
  if (detail.length > 160) detail = `${detail.slice(0, 157)}…`;
  const name = event.name === "command_execution" ? "Run" : event.name;
  return `${name}${detail ? ` ${detail}` : ""}`;
}
/** Format a scrolling transcript without cursor movement or new dependencies. */
export function createOutput({
  quiet = false,
  verbose = false,
  cwd = process.cwd(),
  terminal = Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb",
  color = terminal && process.env.NO_COLOR === undefined,
  write = (line: string) => console.log(line),
}: {
  quiet?: boolean;
  verbose?: boolean;
  cwd?: string;
  terminal?: boolean;
  color?: boolean;
  write?: (line: string) => void;
} = {}) {
  const paint = (code: number, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const symbols = terminal
    ? { start: "◆", bar: "│", end: "└", ok: "✓", fail: "✗", question: "?" }
    : { start: ">", bar: "|", end: "`-", ok: "OK", fail: "ERROR", question: "?" };
  let thinking = false;
  const lines = (text: string) => {
    for (const line of stripVTControlCharacters(text).split(/\r?\n/))
      write(`${paint(90, symbols.bar)} ${line}`);
  };
  return {
    startTurn(role: Role, model: string) {
      thinking = false;
      if (!quiet)
        write(`\n${paint(ROLE_COLOR[role], `${symbols.start} ${title(role)} · ${model}`)}`);
    },
    event(_role: Role, _model: string, event: HarnessEvent) {
      if (quiet) return;
      if (event.type === "session") {
        if (verbose) lines(`Session ${event.sessionId}`);
        return;
      }
      if (event.type === "thinking") {
        if (!thinking || verbose) lines("Thinking…");
        thinking = true;
        return;
      }
      if (event.type === "tool") {
        if (!verbose && event.name === "StructuredOutput") return;
        lines(verbose ? `${event.name} ${event.detail ?? ""}` : shortTool(event, cwd));
        return;
      }
      if (!verbose) {
        if (event.text.includes("<StructuredOutput>")) return;
        try {
          const reply = JSON.parse(event.text);
          if (reply && typeof reply === "object" && "kind" in reply) return;
        } catch {
          /* Ordinary prose is displayed as progress. */
        }
      }
      lines(event.text);
    },
    message(entry: Entry) {
      const success = entry.kind === "done" || entry.kind === "approve" || entry.kind === "handoff";
      const marker = success
        ? symbols.ok
        : entry.kind === "question"
          ? symbols.question
          : symbols.start;
      const heading = `${symbols.end} ${marker} ${STATUS[entry.kind] ?? title(entry.kind)} · ${title(entry.from)} → ${title(entry.to)}`;
      lines(entry.body);
      write(paint(success ? 32 : 33, heading));
    },
    failure(role: Role, body: string) {
      lines(body);
      write(paint(31, `${symbols.end} ${symbols.fail} ${title(role)} Turn failed`));
    },
  };
}
