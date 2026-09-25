import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { Participant } from "../config.js";
import { appendRecord, atomicWrite, nextTurnDir, readRecords, tryAcquire } from "../store.js";

/** The two Participants in a Discussion. */
export type Side = "author" | "critic";
/** Persisted identity of a Discussion. Progress is derived from its log. */
export interface DiscussionData {
  /** Unique Discussion identifier. */
  id: string;
  /** The Caller's message that both sides answer. */
  task: string;
  /** Working directory for every Turn. */
  cwd: string;
  /** Whether the Critic answers the task before it sees the first proposal. */
  blind: boolean;
  /** Critic verdicts allowed before the Discussion ends without agreement. */
  maxRounds: number;
  /** Harness settings and instructions for each side. */
  participants: Record<Side, Participant>;
  /** Discussion creation time in ISO 8601 format. */
  createdAt: string;
}
/** One durable Discussion log entry. */
export interface DiscussEntry {
  /** Unique log entry identifier. */
  id: string;
  /** Entry creation time in ISO 8601 format. */
  at: string;
  /** Origin of the entry. */
  from: Side | "relay" | "caller";
  /**
   * An Author proposal, a blind Critic draft, a Critic verdict, a failed attempt, or a Caller
   * follow-up that reopens a finished Discussion.
   */
  kind: "proposal" | "draft" | "verdict" | "failure" | "followup";
  /** Note to the other side, a failure description, or the follow-up message. */
  body: string;
  /** Full proposal text of a proposal or draft. */
  proposal?: string;
  /** Proposal version, set by the Relay on proposals and on the verdicts that answer them. */
  version?: number;
  /** The Critic's decision on one proposal version. */
  verdict?: "agree" | "revise";
  /** The strongest objection the Critic gave with its verdict. */
  objection?: string;
  /** Side whose Turn failed. */
  role?: Side;
  /** Harness session that produced the entry. */
  completion?: { sessionId: string };
}
/** Default Discussion storage, separate from Runs, Agents, and the working repository. */
export const DISCUSSIONS_PATH = join(homedir(), ".larp/discussions");

/** Append-only Discussion log with a process lock that serializes Turns. */
export class DiscussionStore {
  /** Absolute artifact directory. */
  readonly directory: string;
  /** Saved identity and Participants. */
  readonly data: DiscussionData;

  private constructor(directory: string, data: DiscussionData) {
    this.directory = directory;
    this.data = data;
  }

  /** Create a Discussion without writing to its working directory. */
  static create(
    input: Pick<DiscussionData, "task" | "blind" | "maxRounds" | "participants">,
    root = DISCUSSIONS_PATH,
    cwd = process.cwd()
  ): DiscussionStore {
    const id = randomUUID();
    const directory = join(root, id);
    const data: DiscussionData = {
      id,
      ...input,
      cwd: resolve(cwd),
      createdAt: new Date().toISOString(),
    };

    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "messages.jsonl"), "", { mode: 0o600 });
    atomicWrite(join(directory, "discussion.json"), JSON.stringify(data, null, 2) + "\n");

    return new DiscussionStore(directory, data);
  }

  /** Open a saved Discussion by ID. */
  static open(id: string, root = DISCUSSIONS_PATH): DiscussionStore {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid Discussion ID.");

    const directory = join(root, id);
    if (!existsSync(join(directory, "discussion.json"))) throw new Error(`No Discussion ${id}.`);

    return new DiscussionStore(
      directory,
      JSON.parse(readFileSync(join(directory, "discussion.json"), "utf8"))
    );
  }

  /**
   * Append a complete entry.
   *
   * @throws When the entry cannot be read back after three attempts.
   */
  append(entry: DiscussEntry): void {
    appendRecord(join(this.directory, "messages.jsonl"), entry);
  }

  /** Read complete entries in durable order. */
  entries(): DiscussEntry[] {
    return readRecords<DiscussEntry>(join(this.directory, "messages.jsonl"));
  }

  /** Harness session from the side's latest committed entry, read fresh from the log. */
  sessionId(side: Side): string | undefined {
    return this.entries().findLast((entry) => entry.from === side && entry.completion)?.completion
      ?.sessionId;
  }

  /** Take the Turn lock, or report the live process that holds it. */
  tryAcquire(): ReturnType<typeof tryAcquire> {
    return tryAcquire(join(this.directory, "discussion.lock"));
  }

  /** Allocate the next raw-output directory. */
  nextTurnDir(): string {
    return nextTurnDir(this.directory);
  }
}

/** List saved Discussion identities, newest first. */
export function listDiscussions(root = DISCUSSIONS_PATH): DiscussionData[] {
  if (!existsSync(root)) return [];

  return readdirSync(root)
    .filter((id) => existsSync(join(root, id, "discussion.json")))
    .map(
      (id) => JSON.parse(readFileSync(join(root, id, "discussion.json"), "utf8")) as DiscussionData
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
