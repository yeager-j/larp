import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { Participant } from "../config.js";
import {
  appendRecord,
  createArtifact,
  listArtifacts,
  logPath,
  nextTurnDir,
  openArtifact,
  readRecords,
  tryAcquireTurns,
} from "../store.js";

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
/** Fields every Discussion log entry has. */
interface EntryFields {
  /** Unique log entry identifier. */
  id: string;
  /** Entry creation time in ISO 8601 format. */
  at: string;
  /** Note to the other side, a failure description, or the follow-up message. */
  body: string;
}
/** An Author proposal. */
export interface ProposalEntry extends EntryFields {
  from: "author";
  kind: "proposal";
  /** Full proposal text. */
  proposal: string;
  /** Proposal version, set by the Relay in log order. */
  version: number;
  /** Harness session that produced the proposal. */
  completion: { sessionId: string };
}
/** The Critic's blind answer, written before it sees the first proposal. */
export interface DraftEntry extends EntryFields {
  from: "critic";
  kind: "draft";
  /** Full text of the Critic's own answer. */
  proposal: string;
  /** Harness session that produced the draft. */
  completion: { sessionId: string };
}
/** The Critic's decision on one proposal version. */
export interface VerdictEntry extends EntryFields {
  from: "critic";
  kind: "verdict";
  verdict: "agree" | "revise";
  /** The strongest objection the Critic gave with its verdict. */
  objection: string;
  /** Version of the proposal that the verdict answers. */
  version: number;
  /** Harness session that produced the verdict. */
  completion: { sessionId: string };
}
/** A failed or invalid Turn attempt. */
export interface FailureEntry extends EntryFields {
  from: "relay";
  kind: "failure";
  /** Side whose Turn failed. */
  role: Side;
}
/** A Caller follow-up that reopens a finished Discussion. */
export interface FollowupEntry extends EntryFields {
  from: "caller";
  kind: "followup";
}
/** An entry that a side's Turn committed. */
type SideEntry = ProposalEntry | DraftEntry | VerdictEntry;
/** One durable Discussion log entry. */
export type DiscussEntry = ProposalEntry | DraftEntry | VerdictEntry | FailureEntry | FollowupEntry;
/** Default Discussion storage, separate from Runs, Agents, and the working repository. */
export const DISCUSSIONS_PATH = join(homedir(), ".larp/discussions");

const METADATA_FILE = "discussion.json";

/** Append-only Discussion log with a process lock that serializes Turns. */
export class DiscussionStore {
  /** Absolute artifact directory. */
  readonly directory: string;
  /** Saved identity and Participants. */
  readonly data: DiscussionData;

  private constructor({ directory, data }: { directory: string; data: DiscussionData }) {
    this.directory = directory;
    this.data = data;
  }

  /** Create a Discussion without writing to its working directory. */
  static create(
    input: Pick<DiscussionData, "task" | "blind" | "maxRounds" | "participants">,
    root = DISCUSSIONS_PATH,
    cwd = process.cwd()
  ): DiscussionStore {
    return new DiscussionStore(
      createArtifact(root, METADATA_FILE, { ...input, cwd: resolve(cwd) })
    );
  }

  /** Open a saved Discussion by ID. */
  static open(id: string, root = DISCUSSIONS_PATH): DiscussionStore {
    return new DiscussionStore(openArtifact<DiscussionData>(root, id, METADATA_FILE, "Discussion"));
  }

  /**
   * Append a complete entry.
   *
   * @throws When the entry cannot be read back after three attempts.
   */
  append(entry: DiscussEntry): void {
    appendRecord(logPath(this.directory), entry);
  }

  /** Read complete entries in durable order. */
  entries(): DiscussEntry[] {
    return readRecords<DiscussEntry>(logPath(this.directory));
  }

  /**
   * Take the Turn lock, or report the live process that holds it.
   *
   * @throws When a harness process from an earlier Turn is still running.
   */
  tryAcquire(): ReturnType<typeof tryAcquireTurns> {
    return tryAcquireTurns(this.directory, "discussion.lock");
  }

  /** Allocate the next raw-output directory. */
  nextTurnDir(): string {
    return nextTurnDir(this.directory);
  }
}

/** Harness session from the side's latest committed entry. */
export function sideSession(entries: DiscussEntry[], side: Side): string | undefined {
  return entries.findLast((entry): entry is SideEntry => entry.from === side)?.completion.sessionId;
}

/** List saved Discussion identities, newest first. */
export function listDiscussions(root = DISCUSSIONS_PATH): DiscussionData[] {
  return listArtifacts<DiscussionData>(root, METADATA_FILE);
}
