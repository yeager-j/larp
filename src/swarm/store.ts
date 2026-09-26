import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import type { Participant } from "../config.js";
import {
  appendLine,
  createArtifact,
  listArtifacts,
  logPath,
  nextTurnDir,
  openArtifact,
  readLines,
  tryAcquireTurns,
  type ArtifactIdentity,
} from "../store.js";
import { parseChunkDocument, type ChunkDocument } from "./chunks.js";

/** Worker Role guidance supplied as context to the splitter. */
export interface RoleContext {
  /** User-managed Role name. */
  name: string;
  /** When to use this Role. */
  description: string;
  /** Instructions used to estimate and divide the task. */
  instructions: string;
}

interface CommonData extends ArtifactIdentity {
  cwd: string;
  participant: Participant;
}

/** Immutable inputs for chunk generation. */
export interface DraftData extends CommonData {
  /** Drafts generate a file; they never execute its chunks. */
  kind: "draft";
  /** Authoritative caller task before user editing. */
  task: string;
  /** Optional intended execution Role, used only as context. */
  roleContext?: RoleContext;
}

/** Immutable inputs for a parallel chunk execution. */
export interface ExecutionData extends CommonData {
  /** Executions always have a separate identity from their draft. */
  kind: "execution";
  /** Snapshot of the reviewed input. */
  document: ChunkDocument;
  /** Role selected at start. */
  role: string;
  /** Maximum simultaneous direct Harness processes. */
  parallel: number;
  /** Canonical custom result directory; absent for artifact-local results. */
  out?: string;
}

/** Saved inputs; progress lives only in the log. */
export type SwarmData = DraftData | ExecutionData;

interface EntryFields {
  id: string;
  at: string;
  key: string;
  durationMs: number;
  turnDir?: string;
}

/** Committed splitter/chunk output or a failed attempt. */
export type SwarmEntry = EntryFields &
  (
    | { kind: "split"; document: ChunkDocument; sessionId: string }
    | { kind: "reply"; body: string; sessionId: string }
    | { kind: "failure"; body: string }
  );

/** Default artifact root, separate from Roles and repository content. */
export const SWARMS_PATH = join(homedir(), ".larp/swarms");
const METADATA = "swarm.json";
const OWNER = ".larp-swarm.json";

/** One swarm identity, single-writer log, and recoverable output files. */
export class SwarmStore {
  /** Absolute private artifact directory. */
  readonly directory: string;
  /** Immutable draft or execution inputs. */
  readonly data: SwarmData;

  private constructor(artifact: { directory: string; data: SwarmData }) {
    this.directory = realpathSync(artifact.directory);
    this.data = structuredClone(artifact.data);
  }

  /** Create a draft with snapshotted planner settings. */
  static createDraft(
    input: Pick<DraftData, "task" | "participant" | "roleContext">,
    root = SWARMS_PATH,
    cwd = process.cwd()
  ): SwarmStore {
    return new SwarmStore(
      createArtifact(root, METADATA, { ...input, kind: "draft" as const, cwd: resolve(cwd) })
    );
  }

  /** Create an execution and reserve a new output directory before any Turn starts. */
  static createExecution(
    input: Pick<ExecutionData, "document" | "participant" | "role" | "parallel" | "out">,
    root = SWARMS_PATH,
    cwd = process.cwd()
  ): SwarmStore {
    const document = parseChunkDocument(input.document);
    if (!Number.isInteger(input.parallel) || input.parallel < 1 || input.parallel > 8)
      throw new Error("parallel must be an integer from 1 to 8.");
    const out = input.out === undefined ? undefined : canonicalDestination(resolve(cwd, input.out));
    const store = new SwarmStore(
      createArtifact(root, METADATA, {
        ...input,
        ...(out === undefined ? {} : { out }),
        document,
        kind: "execution" as const,
        cwd: resolve(cwd),
      })
    );
    try {
      store.reserveOutput();
    } catch (error) {
      // Creation failed before publishing the identity or launching a Harness.
      rmSync(store.directory, { recursive: true, force: true });
      throw error;
    }
    return store;
  }

  /** Open one saved identity without loading current Role or chunk files. */
  static open(id: string, root = SWARMS_PATH): SwarmStore {
    return new SwarmStore(openArtifact<SwarmData>(root, id, METADATA, "Swarm"));
  }

  /** Append an outcome while holding the swarm lock. */
  append(entry: SwarmEntry): void {
    appendLine(logPath(this.directory), entry);
  }

  /** Read durable outcomes, ignoring an incomplete final log line. */
  entries(): SwarmEntry[] {
    return readLines<SwarmEntry>(logPath(this.directory));
  }

  /** Exclude another Relay and any surviving Harness processes. */
  tryAcquire(): ReturnType<typeof tryAcquireTurns> {
    return tryAcquireTurns(this.directory, "swarm.lock");
  }

  /** Allocate a unique raw-output directory for the next attempt. */
  nextTurnDir(): string {
    return nextTurnDir(this.directory);
  }

  /** Editable generated document path for a draft. */
  get chunksPath(): string {
    return join(this.directory, "chunks.json");
  }

  /** Owned output directory for an execution. */
  get outputPath(): string {
    return this.data.kind === "execution" && this.data.out
      ? this.data.out
      : join(this.directory, "results");
  }

  private reserveOutput(): void {
    mkdirSync(this.outputPath, { mode: 0o700 });
    writeFileSync(join(this.outputPath, OWNER), JSON.stringify({ id: this.data.id }), {
      mode: 0o600,
      flag: "wx",
    });
  }

  /** Rebuild exports from committed replies, while preserving an existing editable draft. */
  restoreOutputs(entries: SwarmEntry[]): void {
    if (this.data.kind === "execution") this.checkOutput();
    for (const entry of entries) this.materialize(entry);
  }

  /** Export a committed reply. Never call this before appending its entry. */
  materialize(entry: SwarmEntry): void {
    if (entry.kind === "failure") return;
    if (entry.kind === "split") {
      const exists = regularFile(this.chunksPath);
      if (!exists) replaceFile(this.chunksPath, JSON.stringify(entry.document, null, 2) + "\n");
      return;
    }
    this.checkOutput();
    replaceFile(join(this.outputPath, `${entry.key}.md`), entry.body + "\n");
  }

  private checkOutput(): void {
    const path = this.outputPath;
    if (canonicalDestination(path) !== path) throw new Error(`Output parent changed: ${path}`);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) {
      this.reserveOutput();
      return;
    }
    if (!stat.isDirectory()) throw new Error(`Output must be a real directory: ${path}`);
    const owner = join(path, OWNER);
    if (!regularFile(owner) || JSON.parse(readFileSync(owner, "utf8")).id !== this.data.id)
      throw new Error(`Output directory is not owned by swarm ${this.data.id}: ${path}`);
  }
}

function canonicalDestination(path: string): string {
  return join(realpathSync(dirname(path)), basename(path));
}

function regularFile(path: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && !stat.isFile())
    throw new Error(`Expected a regular file, not a symlink or directory: ${path}`);
  return Boolean(stat);
}

function replaceFile(path: string, text: string): void {
  regularFile(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** List saved swarm inputs, newest first, without starting any Turns. */
export function listSwarms(root = SWARMS_PATH): SwarmData[] {
  return listArtifacts<SwarmData>(root, METADATA);
}
