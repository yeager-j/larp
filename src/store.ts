import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

/** Append one JSON line, first discarding a torn final line left by a crash. */
export function appendLine(path: string, value: unknown): void {
  const content = readFileSync(path);

  if (content.length && content[content.length - 1] !== 10)
    truncateSync(path, content.lastIndexOf(10) + 1);

  appendFileSync(path, JSON.stringify(value) + "\n");
}

/** Read complete JSON lines in order, ignoring a torn final line. */
export function readLines<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .slice(0, -1)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

/**
 * Append one JSON record to a log that several processes write without a shared lock.
 *
 * Never truncates, since an unterminated final line may be another process's write in progress.
 * The leading newline keeps a record separate from a line torn by a crash. Read with `readRecords`.
 *
 * @throws When the record cannot be read back after three attempts.
 */
export function appendRecord(path: string, value: unknown): void {
  const line = JSON.stringify(value);

  for (let attempt = 0; attempt < 3; attempt++) {
    const start = statSync(path).size;
    appendFileSync(path, `\n${line}\n`);

    // A split write interleaved with another process's append leaves an unreadable line.
    if (readFrom(path, start).split("\n").includes(line)) return;
  }

  throw new Error(`Could not append a readable record to ${path}.`);
}

function readFrom(path: string, start: number): string {
  const file = openSync(path, "r");

  try {
    const buffer = Buffer.alloc(Math.max(0, fstatSync(file).size - start));
    readSync(file, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    closeSync(file);
  }
}

/** Read records written by `appendRecord`, skipping torn and in-progress lines. */
export function readRecords<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .slice(0, -1)
    .flatMap((line) => {
      if (!line) return [];
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

/** Replace a file so readers never see a partial write. */
export function atomicWrite(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/**
 * Take a process lock file, recovering one left by a dead process.
 *
 * @returns `release` when this process took the lock, or `heldBy` with the PID of the live holder.
 * @throws When a lock file does not contain a PID, or a recovery was interrupted by a crash.
 */
export function tryAcquire(path: string): { release: () => void } | { heldBy: number } {
  while (true) {
    if (createPidFile(path)) return { release: () => releaseOwned(path) };

    const holder = readPid(path);
    if (holder === undefined) continue;
    if (isAlive(holder)) return { heldBy: holder };

    const recovery = removeStale(path, holder);
    if (recovery) return recovery;
  }
}

/**
 * Remove a dead holder's lock under a recovery guard, so two processes that both saw the dead PID
 * cannot remove the lock that one of them has just taken.
 */
function removeStale(path: string, deadPid: number): { heldBy: number } | undefined {
  const guard = `${path}.recover`;

  if (!createPidFile(guard)) {
    const recoverer = readPid(guard);
    if (recoverer === undefined) return undefined;
    if (isAlive(recoverer)) return { heldBy: recoverer };

    throw new Error(`Stale ${basename(guard)}; inspect ${guard} before removing it.`);
  }

  try {
    if (readPid(path) === deadPid) unlinkSync(path);
  } finally {
    unlinkSync(guard);
  }

  return undefined;
}

/** Publish a file holding this process's PID unless one exists, so readers never see it empty. */
function createPidFile(path: string): boolean {
  const staged = `${path}.${process.pid}.tmp`;

  writeFileSync(staged, String(process.pid), { mode: 0o600 });

  try {
    linkSync(staged, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  } finally {
    unlinkSync(staged);
  }
}

function releaseOwned(path: string): void {
  if (readPid(path) === process.pid) unlinkSync(path);
}

function readPid(path: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const pid = Number(text);
  if (!Number.isInteger(pid) || pid <= 0)
    throw new Error(`Invalid ${basename(path)}; inspect ${path} before removing it.`);

  return pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** Allocate the next numbered raw-output directory; existing attempts are never overwritten. */
export function nextTurnDir(directory: string): string {
  const root = join(directory, "turns");
  const numbers = existsSync(root) ? readdirSync(root).map(Number).filter(Number.isFinite) : [];
  const path = join(root, String(Math.max(0, ...numbers) + 1).padStart(2, "0"));

  mkdirSync(path, { recursive: true });

  return path;
}
