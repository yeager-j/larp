import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
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
  /** Execution settings are fixed when the reviewed chunks are started. */
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
  /** Saved inputs for the phase represented by this handle. */
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
    const store = new SwarmStore(createArtifact(root, METADATA, executionInputs(input, cwd)));
    try {
      store.reserveOutput();
    } catch (error) {
      // Creation failed before publishing the identity or launching a Harness.
      rmSync(store.directory, { recursive: true, force: true });
      throw error;
    }
    return store;
  }

  /** Start a managed draft in place, or create an execution for an external chunk file. */
  static startExecution(
    chunksPath: string,
    input: Pick<ExecutionData, "participant" | "role" | "parallel" | "out">,
    root = SWARMS_PATH,
    cwd = process.cwd()
  ): SwarmStore {
    const path = realpathSync(resolve(cwd, chunksPath));
    const directory = dirname(path);
    const managed =
      basename(path) === "chunks.json" &&
      lstatSync(root, { throwIfNoEntry: false }) &&
      dirname(directory) === realpathSync(root) &&
      lstatSync(join(directory, METADATA), { throwIfNoEntry: false });

    if (!managed) {
      const document = parseChunkDocument(JSON.parse(readFileSync(path, "utf8")));
      return SwarmStore.createExecution({ ...input, document }, root, cwd);
    }

    const draft = SwarmStore.open(basename(directory), root);
    const lock = draft.tryAcquire();
    if ("heldBy" in lock) throw new Error(`Swarm ${draft.data.id} is locked by ${lock.heldBy}.`);

    try {
      if (draft.data.kind !== "draft")
        throw new Error(
          `Swarm ${draft.data.id} has already started. Use larp swarm resume ${draft.data.id}, ` +
            "or copy chunks.json outside its swarm directory to start a new swarm."
        );

      const document = parseChunkDocument(JSON.parse(readFileSync(path, "utf8")));
      const store = new SwarmStore({
        directory,
        data: {
          ...executionInputs({ ...input, document }, cwd),
          id: draft.data.id,
          createdAt: draft.data.createdAt,
        },
      });
      // An interrupted transition may have already reserved this swarm's output directory.
      store.checkOutput();
      replaceFile(join(directory, METADATA), JSON.stringify(store.data, null, 2) + "\n");
      return store;
    } finally {
      lock.release();
    }
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
    const lock = tryAcquireTurns(this.directory, "swarm.lock");
    if ("heldBy" in lock) return lock;

    try {
      const saved: SwarmData = JSON.parse(readFileSync(join(this.directory, METADATA), "utf8"));
      if (saved.kind !== this.data.kind)
        throw new Error(
          `Swarm ${this.data.id} has changed phase. Reopen it with larp swarm resume ${this.data.id}.`
        );
      return lock;
    } catch (error) {
      lock.release();
      throw error;
    }
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
    const staged = `${this.outputPath}.${this.data.id}.reservation`;
    const existing = lstatSync(staged, { throwIfNoEntry: false });
    if (existing && (!existing.isDirectory() || readdirSync(staged).some((name) => name !== OWNER)))
      throw new Error(`Invalid output reservation: ${staged}`);
    if (!existing) mkdirSync(staged, { mode: 0o700 });
    try {
      const owner = join(staged, OWNER);
      regularFile(owner);
      writeFileSync(owner, JSON.stringify({ id: this.data.id }), { mode: 0o600 });
      if (lstatSync(this.outputPath, { throwIfNoEntry: false }))
        throw new Error(`Output directory already exists: ${this.outputPath}`);
      renameSync(staged, this.outputPath);
    } catch (error) {
      rmSync(staged, { recursive: true, force: true });
      throw error;
    }
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
      if (this.data.kind !== "draft") return;
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

function executionInputs(
  input: Pick<ExecutionData, "document" | "participant" | "role" | "parallel" | "out">,
  cwd: string
): Omit<ExecutionData, keyof ArtifactIdentity> {
  const document = parseChunkDocument(input.document);
  if (!Number.isInteger(input.parallel) || input.parallel < 1 || input.parallel > 8)
    throw new Error("parallel must be an integer from 1 to 8.");
  const out = input.out === undefined ? undefined : canonicalDestination(resolve(cwd, input.out));
  return {
    ...input,
    ...(out === undefined ? {} : { out }),
    document,
    kind: "execution",
    cwd: resolve(cwd),
  };
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
