import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { Participant } from "./config.js";
import { ROLES, type Entry, type Role } from "./message.js";
import { ROUND_CAP } from "./workflow/plan.js";

/** Persisted identity and recoverable delivery cache for a Run. */
export interface RunData {
  id: string;
  task: string;
  cwd: string;
  createdAt: string;
  /** Absent on legacy Runs, whose review cap was three. */
  reviewRoundCap?: number;
  participants: Record<Role, Participant>;
  sessions: Partial<Record<Role, string>>;
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
    const path = join(this.directory, "messages.jsonl");
    const content = readFileSync(path);
    if (content.length && content[content.length - 1] !== 10)
      truncateSync(path, content.lastIndexOf(10) + 1);
    appendFileSync(path, JSON.stringify(entry) + "\n");
  }
  /** Exclude concurrent Relays; recover a lock left by a dead process. */
  acquire(): () => void {
    const path = join(this.directory, "relay.lock");
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, "utf8"));
      if (!Number.isInteger(pid) || pid <= 0)
        throw new Error("Invalid relay.lock; inspect it before removing it.");
      try {
        process.kill(pid, 0);
        throw new Error(`Run already active in process ${pid}.`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      unlinkSync(path);
    }
    writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
    return () => unlinkSync(path);
  }
  /** Read entries in durable order; ignore a torn final line after a crash. */
  entries(): Entry[] {
    const content = readFileSync(join(this.directory, "messages.jsonl"), "utf8");
    return content
      .split("\n")
      .slice(0, -1)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Entry);
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
    this.atomicWrite(this.handoffPath, text);
  }
  /** Replace the Plan before appending its request entry. */
  writePlan(text: string): void {
    this.atomicWrite(this.planPath, text);
  }
  /** Create a numbered raw-output directory; existing attempts are never overwritten. */
  turnDir(n: number): string {
    const path = join(this.directory, "turns", String(n).padStart(2, "0"));
    mkdirSync(path, { recursive: true });
    return path;
  }
  /** Allocate the next attempt directory, including after a crash. */
  nextTurnDir(): string {
    const root = join(this.directory, "turns");
    const numbers = existsSync(root) ? readdirSync(root).map(Number).filter(Number.isFinite) : [];
    return this.turnDir(Math.max(0, ...numbers) + 1);
  }
  private save(): void {
    this.atomicWrite(join(this.directory, "run.json"), JSON.stringify(this.data, null, 2) + "\n");
  }
  private atomicWrite(path: string, text: string): void {
    writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
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
