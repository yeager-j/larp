import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";

import { clearTurnProcess, recordTurnProcess } from "../store.js";

/** Set on every harness process so larp commands inside a Turn can refuse to start Turns. */
export const TURN_ENV = "LARP_TURN";
/** Signals stop the Relay without committing the interrupted Turn. */
export class TurnInterrupted extends Error {}
/**
 * Run one child, persist raw streams, send the prompt and close stdin.
 *
 * @returns Exit status and stderr; inspect `error` for process or stream failures.
 *   Callback and artifact-write failures stop the child and return an `error`.
 * @throws {TurnInterrupted} After stopping the child on SIGINT or SIGTERM.
 * @throws When initial artifact setup fails.
 */
export async function spawnTurn(input: {
  command: string;
  args: string[];
  cwd: string;
  turnDir: string;
  stdin?: string;
  onLine: (line: string) => void;
}): Promise<{ exitCode: number; stderr: string; error?: string }> {
  mkdirSync(input.turnDir, { recursive: true });
  const stdoutFile = openSync(join(input.turnDir, "stdout.jsonl"), "w", 0o600);
  let stderrFile: number;
  try {
    stderrFile = openSync(join(input.turnDir, "stderr.log"), "w", 0o600);
  } catch (caught) {
    closeSync(stdoutFile);
    throw caught;
  }
  let stderr = "";
  let error: string | undefined;
  // The shell cannot exec the harness until the parent publishes its PID and releases fd 3.
  // EOF before that handshake exits without starting the harness; exec preserves the recorded PID.
  const child = spawn(
    "/bin/sh",
    [
      "-c",
      'read -r ready <&3 || exit 1; exec 3<&-; exec "$@"',
      "larp",
      input.command,
      ...input.args,
    ],
    {
      cwd: input.cwd,
      env: { ...process.env, [TURN_ENV]: "1" },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    }
  );
  const startup = child.stdio[3] as Writable;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (signal: NodeJS.Signals = "SIGTERM") => {
    child.kill(signal);
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
  };
  const fail = (caught: unknown) => {
    error ??= String(caught);
    stop();
  };
  startup.on("error", fail);
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    try {
      input.onLine(line);
    } catch (caught) {
      fail(caught);
    }
  });
  const persist = (file: number, chunk: Buffer) => {
    if (error) return;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const written = writeSync(file, chunk, offset);
        if (!written) throw new Error("Output write made no progress.");
        offset += written;
      }
    } catch (caught) {
      fail(caught);
    }
  };
  child.stdout!.on("data", (chunk: Buffer) => persist(stdoutFile, chunk));
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr = (stderr + String(chunk)).slice(-16000);
    persist(stderrFile, chunk);
  });
  child.stdin!.on("error", (caught) => {
    if ((caught as NodeJS.ErrnoException).code !== "EPIPE") error = caught.message;
  });
  child.on("error", (caught) => {
    error = caught.message;
  });
  if (child.pid !== undefined) {
    try {
      recordTurnProcess(input.turnDir, child.pid);
    } catch (caught) {
      // Without the record, a crash could leave this process running unseen, so it must not run.
      error = `Could not record the harness process: ${String(caught)}`;
      stop();
    }
  }
  let interrupted: NodeJS.Signals | undefined;
  const forwardSignal = (signal: NodeJS.Signals) => {
    interrupted = signal;
    stop(signal);
  };
  const interrupt = () => forwardSignal("SIGINT");
  const terminate = () => forwardSignal("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  if (!error && child.pid !== undefined) startup.end("ready\n");
  else startup.end();
  child.stdin!.end(input.stdin ?? "");
  try {
    const exitCode = await new Promise<number>((resolve) =>
      child.once("close", (code) => resolve(code ?? 1))
    );
    if (interrupted)
      throw new TurnInterrupted(`Turn interrupted by ${interrupted}; resume this Run to retry.`);
    if ((exitCode === 126 || exitCode === 127) && !error)
      error = `Could not execute harness: ${stderr}`;
    return { exitCode, stderr, ...(error ? { error } : {}) };
  } finally {
    if (killTimer) clearTimeout(killTimer);
    lines.close();
    closeSync(stdoutFile);
    closeSync(stderrFile);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);

    try {
      clearTurnProcess(input.turnDir);
    } catch {
      // A record left behind names an exited process, which the next Turn lock removes.
    }
  }
}
/** Decode a JSON line, ignoring non-protocol stdout. */
export function jsonEvent(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
