import { stripVTControlCharacters } from "node:util";
import { createLogUpdate } from "log-update";
import stringWidth from "string-width";

import type { SwarmUI } from "./run.js";
import type { SwarmData, SwarmEntry } from "./store.js";

/** One display row; running times are local to the current invocation. */
export interface SwarmRow {
  /** Stable chunk ID or splitter label. */
  id: string;
  /** Current visible state. */
  status: "Queued" | "Running" | "Complete" | "Failed" | "Interrupted";
  /** Wall-clock start of the current attempt, in milliseconds. */
  startedAt?: number;
  /** Frozen duration of a settled attempt, in milliseconds. */
  durationMs?: number;
}

/** Remove terminal escape sequences and flatten control characters for display. */
export function terminalText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ");
}

function duration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function progress(rows: SwarmRow[], elapsedMs: number): string {
  const count = (status: SwarmRow["status"]) => rows.filter((row) => row.status === status).length;
  const interrupted = count("Interrupted");
  return `[progress] ${duration(elapsedMs)} elapsed · ${count("Running")} running · ${count("Queued")} waiting · ${count("Complete")} complete · ${count("Failed")} failed${interrupted ? ` · ${interrupted} interrupted` : ""}`;
}

function rowText(row: SwarmRow, now: number): string {
  const elapsed = row.status === "Running" ? now - row.startedAt! : row.durationMs;
  return `• [${row.id}] ${row.status}${elapsed === undefined ? "" : ` (${duration(elapsed)})`}`;
}

/** Render a bounded live frame; rows retain manifest order even when some must be hidden. */
export function swarmFrame(
  rows: SwarmRow[],
  elapsedMs: number,
  now: number,
  columns: number,
  height: number
): string {
  const width = Math.max(1, columns - 1);
  const clip = (line: string) => (line.length <= width ? line : line.slice(0, width - 1) + "…");
  const lines = [progress(rows, elapsedMs)];
  if (height <= 3) return clip(lines[0]!);
  const capacity = Math.max(0, height - 4);
  let visible = rows;
  if (rows.length > capacity) {
    const slots = Math.max(0, capacity - 1);
    const priority = rows.filter((row) => row.status === "Running" || row.status === "Failed");
    const remaining = rows.filter((row) => !priority.includes(row));
    const selected = new Set([...priority, ...remaining].slice(0, slots));
    visible = rows.filter((row) => selected.has(row));
  }
  lines.push("", ...visible.map((row) => rowText(row, now)));
  if (visible.length < rows.length) lines.push(`… ${rows.length - visible.length} more chunks`);
  return lines.map(clip).join("\n");
}

type OutputStream = NodeJS.WritableStream & { isTTY?: boolean; columns?: number; rows?: number };

/** Create one stderr renderer with an inline terminal mode and a plain log fallback. */
export function createSwarmOutput(
  options: { stream?: OutputStream; terminal?: boolean } = {}
): SwarmUI {
  const stream = options.stream ?? process.stderr;
  const terminal = options.terminal ?? (Boolean(stream.isTTY) && process.env.TERM !== "dumb");
  const update = terminal ? createLogUpdate(stream) : undefined;
  let rows: SwarmRow[] = [];
  let began = 0;
  let lastChange = 0;
  let active = false;
  let header: string[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const write = (line: string) => stream.write(terminalText(line) + "\n");
  const redraw = () => {
    const columns = Math.max(1, stream.columns ?? 80);
    const headerHeight = header.reduce(
      (lines, line) => lines + Math.max(1, Math.ceil(stringWidth(line) / columns)),
      0
    );
    const height = Math.max(1, (stream.rows ?? 24) - headerHeight);
    update?.(swarmFrame(rows, Date.now() - began, Date.now(), columns, height));
  };

  const settle = (entry: SwarmEntry, error?: string) => {
    const row = rows.find((row) => row.id === entry.key);
    if (!row) return;
    const display = settlement(entry, error);
    row.status = display.status;
    row.durationMs = entry.durationMs;
    lastChange = Date.now();
    if (terminal) redraw();
    else write(display.line);
  };

  return {
    begin(data, entries, outputPath) {
      active = true;
      rows = initialRows(data, entries);
      began = lastChange = Date.now();
      const description =
        data.kind === "draft"
          ? "splitter"
          : `${data.role} · ${rows.length} chunks · parallel ${data.parallel}`;
      header = [
        `[larp] swarm ${data.id} · ${description}`,
        `[larp] Repository: ${data.cwd}`,
        `[larp] ${data.kind === "draft" ? "Chunks" : "Results"}: ${outputPath}`,
      ].map(terminalText);
      for (const line of header) write(line);
      redraw();
      if (terminal) stream.on("resize", redraw);
      timer = setInterval(() => {
        if (terminal) redraw();
        else if (Date.now() - lastChange >= 30000) {
          write(progress(rows, Date.now() - began));
          lastChange = Date.now();
        }
      }, 1000);
      timer.unref();
    },
    start(key) {
      const row = rows.find((row) => row.id === key);
      if (!row) return;
      row.status = "Running";
      row.startedAt = lastChange = Date.now();
      if (terminal) redraw();
      else write(`[start] ${key}`);
    },
    settled: settle,
    exportFailed: settle,
    close() {
      if (!active) return;
      active = false;
      clearInterval(timer);
      timer = undefined;
      stream.off("resize", redraw);
      try {
        for (const row of rows) {
          if (row.status !== "Running") continue;
          row.status = "Interrupted";
          row.durationMs = Date.now() - row.startedAt!;
          if (!terminal) write(`[interrupted] ${row.id}`);
        }
        redraw();
      } finally {
        update?.done();
      }
    },
  };
}

function settlement(
  entry: SwarmEntry,
  exportError?: string
): { status: "Failed" | "Complete"; line: string } {
  let failure: string | undefined;
  if (entry.kind === "failure") failure = entry.body;
  if (exportError !== undefined) failure = `Export failed: ${exportError}`;
  const result = `${entry.key} (${duration(entry.durationMs)})`;
  if (failure !== undefined) return { status: "Failed", line: `[fail] ${result} · ${failure}` };
  return { status: "Complete", line: `[done] ${result}` };
}

function initialRows(data: SwarmData, entries: SwarmEntry[]): SwarmRow[] {
  const ids = data.kind === "draft" ? ["splitter"] : data.document.chunks.map((chunk) => chunk.id);
  return ids.map((id) => {
    const reply = entries.find((entry) => entry.key === id && entry.kind !== "failure");
    return reply
      ? { id, status: "Complete", durationMs: reply.durationMs }
      : { id, status: "Queued" };
  });
}
