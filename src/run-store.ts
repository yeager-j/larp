import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { Participant } from "./config.js";
import type { Entry, Role } from "./message.js";
import {
  appendLine,
  atomicWrite,
  createArtifact,
  listArtifacts,
  logPath,
  nextTurnDir,
  openArtifact,
  readLines,
  tryAcquireTurns,
} from "./store.js";

/** Persisted identity of a Run. Sessions and delivery state are derived from its log. */
export interface RunData {
  /** Unique Run identifier. */
  id: string;
  /** Original Human task. */
  task: string;
  /** Working directory for every Turn in this Run. */
  cwd: string;
  /** Run creation time in ISO 8601 format. */
  createdAt: string;
  /** Review rounds before the Phase Gate; absent on legacy Runs. */
  reviewRoundCap?: number;
  /** Fixed Role assignments for this Run. */
  participants: Record<Role, Participant>;
}
/** Default Run storage, separate from the working repository. */
export const RUNS_PATH = join(homedir(), ".larp/runs");
const METADATA_FILE = "run.json";

/** Synchronous append-only Run log with a process lock that excludes concurrent Relays. */
export class RunStore {
  /** Absolute artifact directory. */
  readonly directory: string;
  /** Saved identity and Participants. */
  readonly data: RunData;

  private constructor({ directory, data }: { directory: string; data: RunData }) {
    this.directory = directory;
    this.data = data;
  }

  /** Create a Run without writing to its working directory. */
  static create(
    input: Pick<RunData, "task" | "participants"> & { reviewRoundCap: number },
    root = RUNS_PATH,
    cwd = process.cwd()
  ): RunStore {
    return new RunStore(createArtifact(root, METADATA_FILE, { ...input, cwd: resolve(cwd) }));
  }

  /** Open a saved Run by ID. */
  static open(id: string, root = RUNS_PATH): RunStore {
    return new RunStore(openArtifact<RunData>(root, id, METADATA_FILE, "Run"));
  }

  /** Append a complete state-changing entry. Only the lock holder may append. */
  append(entry: Entry): void {
    appendLine(logPath(this.directory), entry);
  }

  /**
   * Exclude concurrent Relays; recover a lock left by a dead process.
   *
   * @returns A function that releases the lock.
   * @throws When another live Relay holds the Run, or a harness process from an earlier Turn is
   *   still running.
   */
  acquire(): () => void {
    const lock = tryAcquireTurns(this.directory, "relay.lock");
    if ("heldBy" in lock) throw new Error(`Run already active in process ${lock.heldBy}.`);

    return lock.release;
  }

  /** Read entries in durable order; ignore a torn final line after a crash. */
  entries(): Entry[] {
    return readLines<Entry>(logPath(this.directory));
  }

  /** Absolute Plan artifact path. */
  get planPath(): string {
    return join(this.directory, "plan.md");
  }

  /** Absolute approved handoff document path, separate from the editable Plan. */
  get handoffPath(): string {
    return join(this.directory, "handoff.md");
  }

  /** Save a complete approved snapshot before opening the desktop composer. */
  writeHandoff(text: string): void {
    atomicWrite(this.handoffPath, text);
  }

  /** Replace the Plan before appending its request entry. */
  writePlan(text: string): void {
    atomicWrite(this.planPath, text);
  }

  /** Allocate the next attempt directory, including after a crash. */
  nextTurnDir(): string {
    return nextTurnDir(this.directory);
  }
}

/** List saved Run identities without starting any harness. */
export function listRuns(root = RUNS_PATH): RunData[] {
  return listArtifacts<RunData>(root, METADATA_FILE);
}
