import { randomUUID } from "node:crypto";

import { TurnInterrupted } from "../harness/spawn.js";
import type { TurnOutcome } from "../harness/turn.js";
import type { Harness } from "../harness/types.js";
import { drive } from "../kernel/drive.js";
import type { TurnSpec, Workflow } from "../kernel/types.js";
import { CHUNK_SCHEMA, parseChunkDocument } from "./chunks.js";
import { chunkEnvelope, chunkRolePrompt, splitterEnvelope, splitterRolePrompt } from "./prompt.js";
import type { SwarmData, SwarmEntry, SwarmStore } from "./store.js";

/** A generated draft or the settled result of one execution invocation. */
export type SwarmOutcome =
  | { kind: "draft"; path: string }
  | { kind: "execution"; complete: number; total: number; failed: string[] };

/** Display notifications; the log remains the only source of durable progress. */
export interface SwarmUI {
  /** Initialize from committed progress after taking the lock. */
  begin?(data: SwarmData, entries: SwarmEntry[], outputPath: string): void;
  /** One new attempt has started. */
  start?(key: string): void;
  /** An outcome has committed and any reply has been exported. */
  settled?(entry: SwarmEntry): void;
  /** A reply is durable but its file could not be written. */
  exportFailed?(entry: SwarmEntry, error: string): void;
  /** Stop rendering; unresolved running rows represent interrupted attempts. */
  close?(): void;
}

/** Run or resume one draft/execution, preserving completed chunks and exporting their replies. */
export async function runSwarm(
  store: SwarmStore,
  harnesses: Record<"claude" | "codex", Harness>,
  ui: SwarmUI = {}
): Promise<SwarmOutcome> {
  const started = new Map<string, number>();
  let acquired = false;
  try {
    const result = await drive(
      store,
      workflow(store, ui, started, () => {
        acquired = true;
      }),
      {
        harnesses,
        parallel: store.data.kind === "draft" ? 1 : store.data.parallel,
        startTurn(turn) {
          started.set(turn.key, performance.now());
          ui.start?.(turn.key);
        },
      }
    );
    if (result.status === "held")
      throw new Error(`Swarm ${store.data.id} is running in process ${result.heldBy}.`);
    return result.outcome;
  } catch (error) {
    if (!acquired) throw error;
    const reason =
      error instanceof TurnInterrupted
        ? "Turn interrupted."
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(
      `Swarm ${store.data.id}: ${reason}\nResume with: larp swarm resume ${store.data.id}`,
      { cause: error }
    );
  } finally {
    ui.close?.();
  }
}

function workflow(
  store: SwarmStore,
  ui: SwarmUI,
  started: Map<string, number>,
  acquired: () => void
): Workflow<SwarmEntry, string, undefined, never, SwarmOutcome> {
  const data = store.data;
  return {
    begin(entries) {
      acquired();
      store.restoreOutputs(entries);
      ui.begin?.(data, entries, data.kind === "draft" ? store.chunksPath : store.outputPath);
    },
    next(entries, { resumedAt }) {
      if (data.kind === "draft") {
        if (entries.some((entry) => entry.kind === "split"))
          return { kind: "done", outcome: { kind: "draft", path: store.chunksPath } };
        const failure = entries.slice(resumedAt).find((entry) => entry.kind === "failure");
        if (failure?.kind === "failure") throw new Error(failure.body);
        return {
          kind: "turns",
          turns: [
            {
              ...baseTurn(data, "splitter"),
              rolePrompt: splitterRolePrompt(data.participant.instructions),
              prompt: splitterEnvelope(data),
              schema: CHUNK_SCHEMA,
            },
          ],
        };
      }
      const completed = new Set(
        entries.filter((entry) => entry.kind === "reply").map((entry) => entry.key)
      );
      const failed = new Set(
        entries
          .slice(resumedAt)
          .filter((entry) => entry.kind === "failure")
          .map((entry) => entry.key)
      );
      const pending = data.document.chunks.filter(
        (chunk) => !completed.has(chunk.id) && !failed.has(chunk.id)
      );
      if (pending.length)
        return {
          kind: "turns",
          turns: pending.map((chunk) => ({
            ...baseTurn(data, chunk.id),
            rolePrompt: chunkRolePrompt(data.participant.instructions),
            prompt: chunkEnvelope(data, chunk),
          })),
        };
      return { kind: "done", outcome: executionProgress(data, entries) };
    },
    commit(turn, outcome, _entries, turnDir) {
      const durationMs = Math.max(
        0,
        Math.round(performance.now() - (started.get(turn.key) ?? performance.now()))
      );
      const entry: SwarmEntry = {
        id: randomUUID(),
        at: new Date().toISOString(),
        key: turn.key,
        durationMs,
        ...(turnDir ? { turnDir } : {}),
        ...replyFields(data, outcome),
      };
      store.append(entry);
      // Export failure must leave the successful reply committed for recovery without a model call.
      try {
        store.materialize(entry);
      } catch (error) {
        ui.exportFailed?.(entry, error instanceof Error ? error.message : String(error));
        throw error;
      }
      ui.settled?.(entry);
    },
  };
}

function baseTurn(data: SwarmData, key: string): Omit<TurnSpec<string>, "rolePrompt" | "prompt"> {
  return {
    key,
    participant: data.participant,
    cwd: data.cwd,
    permission: data.participant.permission ?? "read-only",
    delivered: [],
    detail: undefined,
  };
}

type ReplyFields =
  | Pick<Extract<SwarmEntry, { kind: "split" }>, "kind" | "document" | "sessionId">
  | Pick<Extract<SwarmEntry, { kind: "reply" }>, "kind" | "body" | "sessionId">
  | Pick<Extract<SwarmEntry, { kind: "failure" }>, "kind" | "body">;

function replyFields(data: SwarmData, outcome: TurnOutcome): ReplyFields {
  if (!outcome.ok) return { kind: "failure", body: outcome.error };
  if (data.kind === "execution") {
    if (typeof outcome.output !== "string" || !outcome.output.trim())
      return { kind: "failure", body: "Harness returned no Markdown reply text." };
    return { kind: "reply", body: outcome.output.trim(), sessionId: outcome.sessionId };
  }
  try {
    const document = parseChunkDocument(outcome.output);
    return {
      kind: "split",
      document: { ...document, task: data.task },
      sessionId: outcome.sessionId,
    };
  } catch (error) {
    return {
      kind: "failure",
      body: `Invalid chunk reply: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Derive completed counts and unfinished IDs from committed execution replies. */
export function executionProgress(
  data: Extract<SwarmData, { kind: "execution" }>,
  entries: SwarmEntry[]
): Extract<SwarmOutcome, { kind: "execution" }> {
  const replies = new Set(
    entries.filter((entry) => entry.kind === "reply").map((entry) => entry.key)
  );
  const failed = data.document.chunks
    .filter((chunk) => !replies.has(chunk.id))
    .map((chunk) => chunk.id);
  return {
    kind: "execution",
    complete: data.document.chunks.length - failed.length,
    total: data.document.chunks.length,
    failed,
  };
}
