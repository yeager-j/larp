import type { Participant } from "../config.js";
import type { TurnOutcome } from "../harness/turn.js";

/** One Turn, fully described by a Workflow's `next` from the log at Turn start. */
export interface TurnSpec<K extends string, D = undefined> {
  /** Participant key; the driver runs at most one Turn per key at a time. */
  key: K;
  /** Harness, model, and settings for the Turn. */
  participant: Participant;
  /** Working directory for the harness process. */
  cwd: string;
  /** File access for the Turn. */
  permission: "read-only" | "write";
  /** Protocol and Role instructions, sent with the first Turn of a session. */
  rolePrompt: string;
  /** The Envelope for this Turn. */
  prompt: string;
  /** Required reply format; absent for a free-text reply. */
  schema?: object;
  /** Harness session to resume; absent to start a new session. */
  sessionId?: string;
  /** IDs of the entries this Turn answers. `commit` records exactly these. */
  delivered: string[];
  /** Workflow data for display, such as a Discussion round. */
  detail: D;
}

/** What the driver does next. */
export type Step<K extends string, D, A, O> =
  | { kind: "turns"; turns: TurnSpec<K, D>[] }
  | { kind: "act"; action: A }
  | { kind: "done"; outcome: O };

/** The log a Workflow runs over. */
export interface WorkflowLog<E> {
  /** Read complete entries in durable order. */
  entries(): E[];
  /** Take the Turn lock, or report the live process that holds it. */
  tryAcquire(): { release(): void } | { heldBy: number };
  /** Allocate the next raw-output directory for a Turn. */
  nextTurnDir(): string;
}

/**
 * One Workflow, as the driver sees it: a pure step function over its log, plus the effects that
 * commit Turns and perform actions.
 *
 * @typeParam E Log entry type.
 * @typeParam K Participant key type.
 * @typeParam D Display data carried by each Turn.
 * @typeParam A Action type, such as a Gate.
 * @typeParam O Outcome type.
 */
export interface Workflow<E, K extends string, D, A, O> {
  /** Run once under the lock, before the loop. May append entries, or throw to refuse the run. */
  begin?(entries: E[]): void;
  /**
   * Decide the next Step from the log alone. Pure.
   *
   * @param context.resumedAt Log length when this process started its loop; entries at or after
   *   it were written by this process.
   */
  next(entries: E[], context: { resumedAt: number }): Step<K, D, A, O>;
  /**
   * Append the reply or failure entries for one finished Turn, and display them. Synchronous, so
   * commits of parallel Turns never interleave. Throw after appending to stop the run.
   *
   * @param entries The log after the Turn; take Turn-start state, such as `delivered`, from `turn`.
   * @param turnDir The Turn's raw-output directory; absent when the Turn failed before allocating it.
   */
  commit(turn: TurnSpec<K, D>, outcome: TurnOutcome, entries: E[], turnDir?: string): void;
  /** Perform one action, such as a Gate or a handoff, and append its entries. */
  act?(action: A, entries: E[]): Promise<void>;
  /** Run while Turns are in flight, such as reading Human interjections; stop when aborted. */
  alongsideTurns?(signal: AbortSignal): Promise<void>;
}

/** Result of one `drive` call. */
export type DriveResult<O> = { status: "done"; outcome: O } | { status: "held"; heldBy: number };
