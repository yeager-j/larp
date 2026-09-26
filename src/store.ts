import { randomUUID } from "node:crypto";
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
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

/** Append one JSON line, first discarding a torn final line left by a crash. */
export function appendLine(path: string, value: unknown): void {
  const file = openSync(path, "r");
  try {
    let end = fstatSync(file).size;
    const buffer = Buffer.alloc(4096);
    while (end > 0) {
      const start = Math.max(0, end - buffer.length);
      const length = readSync(file, buffer, 0, end - start, start);
      const newline = buffer.subarray(0, length).lastIndexOf(10);
      if (newline >= 0) {
        if (start + newline + 1 < fstatSync(file).size) truncateSync(path, start + newline + 1);
        break;
      }
      end = start;
      if (end === 0) truncateSync(path, 0);
    }
  } finally {
    closeSync(file);
  }

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
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
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

const TURN_PID_FILE = "harness.pid";

/** Record the harness process of a running Turn, so a later Relay can see that it still runs. */
export function recordTurnProcess(turnDir: string, pid: number): void {
  atomicWrite(join(turnDir, TURN_PID_FILE), String(pid));
}

/** Remove the record written by `recordTurnProcess` after the harness process exits. */
export function clearTurnProcess(turnDir: string): void {
  rmSync(join(turnDir, TURN_PID_FILE), { force: true });
}

/**
 * Take a Turn lock, then refuse it while a harness process from an earlier Turn still runs.
 *
 * A Relay that is killed or crashes can leave its harness process running, so a dead lock holder
 * does not prove that its Turn has stopped.
 *
 * @returns `release` when this process took the lock, or `heldBy` with the PID of the live holder.
 * @throws When a harness process from an earlier Turn is still running, or `tryAcquire` throws.
 */
export function tryAcquireTurns(
  directory: string,
  lockFile: string
): ReturnType<typeof tryAcquire> {
  const lock = tryAcquire(join(directory, lockFile));
  if ("heldBy" in lock) return lock;

  try {
    refuseRunningTurn(directory);
  } catch (error) {
    lock.release();
    throw error;
  }

  return lock;
}

/** Refuse while any Turn's harness process still runs; Turns of different Participants can overlap. */
function refuseRunningTurn(directory: string): void {
  const root = join(directory, "turns");
  if (!existsSync(root)) return;

  for (const turn of readdirSync(root).filter((name) => Number.isFinite(Number(name)))) {
    const path = join(root, turn, TURN_PID_FILE);
    const pid = readPid(path);
    if (pid === undefined) continue;

    if (!isAlive(pid)) {
      unlinkSync(path);
      continue;
    }

    throw new Error(
      `The harness process (PID ${pid}) of an earlier Turn is still running. Wait for it to exit or stop it, then retry. If that PID now belongs to another program, remove ${path}.`
    );
  }
}

/** A log entry before the log assigns its ID and time; distributes over entry unions. */
export type Unsaved<T> = T extends unknown ? Omit<T, "id" | "at"> : never;

/** Log file name in every artifact directory. */
const LOG_FILE = "messages.jsonl";

/** Absolute path of the log in an artifact directory. */
export function logPath(directory: string): string {
  return join(directory, LOG_FILE);
}

/** Identity fields that every artifact metadata file holds. */
export interface ArtifactIdentity {
  /** Unique artifact identifier, which is also its directory name. */
  id: string;
  /** Creation time in ISO 8601 format. */
  createdAt: string;
}

/**
 * Create an artifact directory with an empty log and its metadata file.
 *
 * The metadata file is written last, so `listArtifacts` and `openArtifact` never find an artifact
 * without a log.
 */
export function createArtifact<T extends object>(
  root: string,
  metadataFile: string,
  fields: T
): { directory: string; data: T & ArtifactIdentity } {
  const id = randomUUID();
  const directory = join(root, id);
  const data = { ...fields, id, createdAt: new Date().toISOString() };

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(logPath(directory), "", { mode: 0o600 });
  atomicWrite(join(directory, metadataFile), JSON.stringify(data, null, 2) + "\n");

  return { directory, data };
}

/**
 * Open a saved artifact by ID.
 *
 * @param noun Artifact name for error messages, such as "Agent".
 * @throws When the ID has characters outside `[a-zA-Z0-9_-]`, or no artifact has that ID.
 */
export function openArtifact<T>(
  root: string,
  id: string,
  metadataFile: string,
  noun: string
): { directory: string; data: T } {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid ${noun} ID.`);

  const directory = join(root, id);
  const path = join(directory, metadataFile);
  if (!existsSync(path)) throw new Error(`No ${noun} ${id}.`);

  return { directory, data: JSON.parse(readFileSync(path, "utf8")) as T };
}

/** List saved artifact metadata, newest first. */
export function listArtifacts<T extends ArtifactIdentity>(root: string, metadataFile: string): T[] {
  if (!existsSync(root)) return [];

  return readdirSync(root)
    .filter((id) => existsSync(join(root, id, metadataFile)))
    .map((id) => JSON.parse(readFileSync(join(root, id, metadataFile), "utf8")) as T)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
