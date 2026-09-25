import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { participantFor, type Participant } from "../config.js";
import type { RoleDefinition } from "../roles.js";
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

/** A Role snapshot saved for the life of an Agent. */
export interface AgentParticipant extends Participant {
  /** File access for every Turn. */
  permission: RoleDefinition["permission"];
  /** Required reply format; absent for free-text replies. */
  schema?: object;
}
/** Persisted identity of an Agent. Delivery state is derived from its log. */
export interface AgentData {
  /** Unique Agent identifier. */
  id: string;
  /** Name of the Role the Agent was started from. */
  role: string;
  /** Harness settings and instructions for every Turn. */
  participant: AgentParticipant;
  /** Working directory for every Turn. */
  cwd: string;
  /** Agent creation time in ISO 8601 format. */
  createdAt: string;
}
/** One durable Agent log entry. */
export interface AgentEntry {
  /** Unique log entry identifier. */
  id: string;
  /** Entry creation time in ISO 8601 format. */
  at: string;
  /** Origin of the entry. */
  from: "caller" | "agent" | "relay";
  /** A Caller message, an Agent reply, or a failed Turn. */
  kind: "message" | "reply" | "failure";
  /** Message text, reply text, or failure description. */
  body: string;
  /** Structured reply, when the Role has a schema. */
  output?: unknown;
  /** Harness session and Caller messages answered by a reply. */
  completion?: { sessionId: string; delivered: string[] };
}
/** Default Agent storage, separate from Runs and the working repository. */
export const AGENTS_PATH = join(homedir(), ".larp/agents");
const METADATA_FILE = "agent.json";

/** Append-only Agent log with a process lock that serializes Turns. */
export class AgentStore {
  /** Absolute artifact directory. */
  readonly directory: string;
  /** Saved identity and Role snapshot. */
  readonly data: AgentData;

  private constructor({ directory, data }: { directory: string; data: AgentData }) {
    this.directory = directory;
    this.data = data;
  }

  /** Create an Agent from a Role without writing to its working directory. */
  static create(
    role: RoleDefinition,
    schema?: object,
    root = AGENTS_PATH,
    cwd = process.cwd()
  ): AgentStore {
    return new AgentStore(
      createArtifact(root, METADATA_FILE, {
        role: role.name,
        participant: {
          ...participantFor(role),
          permission: role.permission,
          ...(schema ? { schema } : {}),
        },
        cwd: resolve(cwd),
      })
    );
  }

  /** Open a saved Agent by ID. */
  static open(id: string, root = AGENTS_PATH): AgentStore {
    return new AgentStore(openArtifact<AgentData>(root, id, METADATA_FILE, "Agent"));
  }

  /**
   * Append a complete entry; safe while another process appends.
   *
   * @throws When the entry cannot be read back after three attempts.
   */
  append(entry: AgentEntry): void {
    appendRecord(logPath(this.directory), entry);
  }

  /** Read complete entries in durable order. */
  entries(): AgentEntry[] {
    return readRecords<AgentEntry>(logPath(this.directory));
  }

  /** Caller messages that no committed reply has answered, read fresh from the log. */
  undelivered(): AgentEntry[] {
    const entries = this.entries();
    const delivered = new Set(entries.flatMap((entry) => entry.completion?.delivered ?? []));

    return entries.filter((entry) => entry.kind === "message" && !delivered.has(entry.id));
  }

  /** Harness session from the latest committed reply, read fresh from the log. */
  sessionId(): string | undefined {
    return this.entries().findLast((entry) => entry.completion)?.completion?.sessionId;
  }

  /**
   * Take the Turn lock, or report the live process that holds it.
   *
   * @throws When a harness process from an earlier Turn is still running.
   */
  tryAcquire(): ReturnType<typeof tryAcquireTurns> {
    return tryAcquireTurns(this.directory, "agent.lock");
  }

  /** Allocate the next raw-output directory. */
  nextTurnDir(): string {
    return nextTurnDir(this.directory);
  }
}

/** List saved Agent identities, newest first. */
export function listAgents(root = AGENTS_PATH): AgentData[] {
  return listArtifacts<AgentData>(root, METADATA_FILE);
}
