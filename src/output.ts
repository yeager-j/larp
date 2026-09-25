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
/** Capitalize the first letter of a Role or kind for display. */
export function title(value: string): string {
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
  } catch {}
  if (isAbsolute(detail)) detail = relative(cwd, detail) || ".";
  detail = stripVTControlCharacters(detail).replace(/\s+/g, " ").trim();
  if (detail.length > 160) detail = `${detail.slice(0, 157)}…`;
  const name = event.name === "command_execution" ? "Run" : event.name;
  return `${name}${detail ? ` ${detail}` : ""}`;
}
/** Options shared by every transcript. */
export interface TranscriptOptions {
  /** Hide Turn headings and progress; committed replies still print. */
  quiet?: boolean;
  /** Show raw tool input, session IDs, every thinking event, and structured replies. */
  verbose?: boolean;
  /** Directory that tool paths are shown relative to. */
  cwd?: string;
  /** Use Unicode symbols; defaults to whether stdout is a terminal. */
  terminal?: boolean;
  /** Use ANSI colors. */
  color?: boolean;
  /** Receive each finished line. */
  write?: (line: string) => void;
}
/** Format a scrolling transcript without cursor movement or new dependencies. */
export function createTranscript({
  quiet = false,
  verbose = false,
  cwd = process.cwd(),
  terminal = Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb",
  color = terminal && process.env.NO_COLOR === undefined,
  write = (line: string) => console.log(line),
}: TranscriptOptions = {}) {
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
    symbols,
    lines,
    /** Open a Turn with a heading in the ANSI color `code`. */
    startTurn(heading: string, code: number) {
      thinking = false;
      if (!quiet) write(`\n${paint(code, `${symbols.start} ${heading}`)}`);
    },
    /** Show one harness progress event, hiding the structured reply unless verbose. */
    event(event: HarnessEvent) {
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
          if (reply && typeof reply === "object") return;
        } catch {}
      }
      lines(event.text);
    },
    /** Close a Turn with a result line in the ANSI color `code`. */
    end(heading: string, code: number) {
      write(paint(code, `${symbols.end} ${heading}`));
    },
  };
}
/** Plan transcript: Planner and Reviewer Turns and the messages they commit. */
export function createOutput(options: TranscriptOptions = {}) {
  const transcript = createTranscript(options);
  const { symbols } = transcript;
  return {
    startTurn(role: Role, model: string) {
      transcript.startTurn(`${title(role)} · ${model}`, ROLE_COLOR[role]);
    },
    event(_role: Role, _model: string, event: HarnessEvent) {
      transcript.event(event);
    },
    message(entry: Entry) {
      const success = entry.kind === "done" || entry.kind === "approve" || entry.kind === "handoff";
      const marker = success
        ? symbols.ok
        : entry.kind === "question"
          ? symbols.question
          : symbols.start;
      transcript.lines(entry.body);
      transcript.end(
        `${marker} ${STATUS[entry.kind] ?? title(entry.kind)} · ${title(entry.from)} → ${title(entry.to)}`,
        success ? 32 : 33
      );
    },
    failure(role: Role, body: string) {
      transcript.lines(body);
      transcript.end(`${symbols.fail} ${title(role)} Turn failed`, 31);
    },
  };
}
