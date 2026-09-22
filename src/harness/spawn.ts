import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** Set on every harness process so larp commands inside a Turn can refuse to start Turns. */
export const TURN_ENV = "LARP_TURN";
/** Signals stop the Relay without committing the interrupted Turn. */
export class TurnInterrupted extends Error {}
/** Run one child, persist raw streams, send the prompt and close stdin. */
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
  const stderrFile = openSync(join(input.turnDir, "stderr.log"), "w", 0o600);
  let stderr = "";
  let error: string | undefined;
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: { ...process.env, [TURN_ENV]: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      input.onLine(line);
    } catch (caught) {
      error = String(caught);
    }
  });
  child.stdout.on("data", (chunk) => writeSync(stdoutFile, chunk));
  child.stderr.on("data", (chunk) => {
    writeSync(stderrFile, chunk);
    stderr = (stderr + String(chunk)).slice(-16000);
  });
  child.stdin.on("error", (caught) => {
    if ((caught as NodeJS.ErrnoException).code !== "EPIPE") error = caught.message;
  });
  child.on("error", (caught) => {
    error = caught.message;
  });
  let interrupted: NodeJS.Signals | undefined;
  const forwardSignal = (signal: NodeJS.Signals) => {
    interrupted = signal;
    child.kill(signal);
  };
  const interrupt = () => forwardSignal("SIGINT");
  const terminate = () => forwardSignal("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  child.stdin.end(input.stdin ?? "");
  try {
    const exitCode = await new Promise<number>((resolve) =>
      child.once("close", (code) => resolve(code ?? 1))
    );
    if (interrupted)
      throw new TurnInterrupted(`Turn interrupted by ${interrupted}; resume this Run to retry.`);
    return { exitCode, stderr, ...(error ? { error } : {}) };
  } finally {
    lines.close();
    closeSync(stdoutFile);
    closeSync(stderrFile);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
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
