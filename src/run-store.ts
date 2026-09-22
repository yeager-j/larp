import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { Participant } from "./config.js";
import { ROLES, type Entry, type Role } from "./message.js";
import { appendLine, atomicWrite, nextTurnDir, readLines, tryAcquire } from "./store.js";
import { ROUND_CAP } from "./workflow/plan.js";

/** Persisted identity and recoverable delivery cache for a Run. */
export interface RunData {
  /** Unique Run identifier. */
  id: string;
  /** Original Human task. */
  task: string;
  /** Working directory for every Turn in this Run. */
  cwd: string;
  /** Run creation time in ISO 8601 format. */
  createdAt: string;
  /** Absent on legacy Runs, whose review cap was three. */
  reviewRoundCap?: number;
  /** Fixed Role assignments for this Run. */
  participants: Record<Role, Participant>;
  /** Resumable harness session identifiers by Role. */
  sessions: Partial<Record<Role, string>>;
  /** Entry identifiers already delivered to a Participant. */
  delivered: string[];
}
/** Default Run storage, separate from the working repository. */
export const RUNS_PATH = join(homedir(), ".larp/runs");
/** Synchronous append-only Run log and atomic metadata updates. */
export class RunStore {
  /** Absolute artifact directory. */
  readonly directory: string;
  /** Current metadata, including saved Participants and working directory. */
  readonly data: RunData;
  private constructor(directory: string, data: RunData) {
    this.directory = directory;
    this.data = data;
  }
  /** Create a Run without writing to its working directory. */
  static create(
    task: string,
    participants: Record<Role, Participant>,
    root = RUNS_PATH,
    cwd = process.cwd()
  ): RunStore {
    const id = randomUUID();
    const directory = join(root, id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const run = new RunStore(directory, {
      id,
      task,
      participants,
      cwd: resolve(cwd),
      createdAt: new Date().toISOString(),
      reviewRoundCap: ROUND_CAP,
      sessions: {},
      delivered: [],
    });
    writeFileSync(join(directory, "messages.jsonl"), "", { mode: 0o600 });
    run.save();
    return run;
  }
  /** Open a Run, repairing delivery metadata from committed replies. */
  static open(id: string, root = RUNS_PATH): RunStore {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid Run ID.");
    const directory = join(root, id);
    const run = new RunStore(
      directory,
      JSON.parse(readFileSync(join(directory, "run.json"), "utf8"))
    );
    for (const entry of run.entries()) {
      if (entry.completion && ROLES.includes(entry.from as Role)) {
        run.data.sessions[entry.from as Role] = entry.completion.sessionId;
        run.data.delivered = [...new Set([...run.data.delivered, ...entry.completion.delivered])];
      }
    }
    return run;
  }
  /** Append a complete state-changing entry. */
  append(entry: Entry): void {
    appendLine(join(this.directory, "messages.jsonl"), entry);
  }
  /** Exclude concurrent Relays; recover a lock left by a dead process. */
  acquire(): () => void {
    const lock = tryAcquire(join(this.directory, "relay.lock"));
    if ("heldBy" in lock) throw new Error(`Run already active in process ${lock.heldBy}.`);
    return lock.release;
  }
  /** Read entries in durable order; ignore a torn final line after a crash. */
  entries(): Entry[] {
    return readLines<Entry>(join(this.directory, "messages.jsonl"));
  }
  /** Persist a harness session for a Role. */
  setSession(role: Role, id: string): void {
    this.data.sessions[role] = id;
    this.save();
  }
  /** Persist the IDs acknowledged by a successful Turn. */
  markDelivered(ids: string[]): void {
    this.data.delivered = [...new Set([...this.data.delivered, ...ids])];
    this.save();
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
  private save(): void {
    atomicWrite(join(this.directory, "run.json"), JSON.stringify(this.data, null, 2) + "\n");
  }
}
/** List saved Run identities without starting any harness. */
export function listRuns(root = RUNS_PATH): RunData[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((id) => existsSync(join(root, id, "run.json")))
    .map((id) => JSON.parse(readFileSync(join(root, id, "run.json"), "utf8")) as RunData)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
