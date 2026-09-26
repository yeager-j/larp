import type { HarnessId } from "../config.js";
import { attemptTurn } from "../harness/turn.js";
import type { Harness, HarnessEvent, TurnRequest } from "../harness/types.js";
import type { DriveResult, TurnSpec, Workflow, WorkflowLog } from "./types.js";

/** Settings for one `drive` call. */
export interface DriveOptions<K extends string, D> {
  /** Adapter for each harness. */
  harnesses: Record<HarnessId, Harness>;
  /** Most Turns in flight at once; defaults to 1. */
  parallel?: number;
  /** Announce a Turn as it starts. */
  startTurn?(turn: TurnSpec<K, D>): void;
  /** Display harness progress during a Turn. */
  event?(turn: TurnSpec<K, D>, event: HarnessEvent): void;
}

/**
 * Run a Workflow over its log until `next` returns an outcome.
 *
 * Takes the log's lock, calls `begin`, then repeats: ask `next` for a Step, start its Turns up to
 * `parallel` at a time with at most one per key, commit each Turn as it ends, and perform actions
 * only when no Turn is in flight. A Step computed while Turns are in flight is decided again after
 * the next Turn commits.
 *
 * @returns `held` without starting anything when another live process holds the lock.
 * @throws The first error from a Turn, `commit`, `act`, or `alongsideTurns`, after every Turn in
 *   flight has settled and committed. `TurnInterrupted` leaves its own Turn uncommitted.
 */
export async function drive<E, K extends string, D, A, O>(
  log: WorkflowLog<E>,
  workflow: Workflow<E, K, D, A, O>,
  options: DriveOptions<K, D>
): Promise<DriveResult<O>> {
  const lock = log.tryAcquire();
  if ("heldBy" in lock) return { status: "held", heldBy: lock.heldBy };

  try {
    workflow.begin?.(log.entries());

    return { status: "done", outcome: await runLoop(log, workflow, options) };
  } finally {
    lock.release();
  }
}

async function runLoop<E, K extends string, D, A, O>(
  log: WorkflowLog<E>,
  workflow: Workflow<E, K, D, A, O>,
  options: DriveOptions<K, D>
): Promise<O> {
  const resumedAt = log.entries().length;
  const parallel = options.parallel ?? 1;
  const inFlight = new Map<K, Promise<void>>();
  const errors: unknown[] = [];
  let alongside: Alongside | undefined;

  const startTurn = (turn: TurnSpec<K, D>) => {
    if (!inFlight.size && workflow.alongsideTurns)
      alongside = startAlongside(workflow.alongsideTurns.bind(workflow));

    options.startTurn?.(turn);
    inFlight.set(turn.key, runTurn(turn));
  };

  const runTurn = async (turn: TurnSpec<K, D>): Promise<void> => {
    let turnDir: string | undefined;

    try {
      const outcome = await attemptTurn(options.harnesses[turn.participant.harness], () => {
        turnDir = log.nextTurnDir();
        return turnRequest(turn, turnDir, (event) => options.event?.(turn, event));
      });

      workflow.commit(turn, outcome, log.entries(), turnDir);
    } catch (error) {
      errors.push(error);
    } finally {
      // Stop reading alongside input in the same synchronous step as the commit that ends the
      // batch, so no input is handled between them.
      inFlight.delete(turn.key);
      if (!inFlight.size) alongside?.controller.abort();
    }
  };

  const finishBatch = async () => {
    const finished = alongside;
    alongside = undefined;
    if (!finished) return;

    // Usually aborted already; not when the batch ended before its first Turn started.
    finished.controller.abort();
    await finished.done;
    if (finished.error !== undefined) errors.push(finished.error);
  };

  while (true) {
    if (errors.length) {
      await Promise.all(inFlight.values());
      await finishBatch();
      throw errors[0];
    }

    if (!inFlight.size) await finishBatch();
    if (errors.length) continue;

    // Any error goes through `errors`, so Turns in flight settle before the lock is released.
    try {
      const step = workflow.next(log.entries(), { resumedAt });

      if (step.kind === "turns") {
        for (const turn of step.turns)
          if (inFlight.size < parallel && !inFlight.has(turn.key)) startTurn(turn);

        if (!inFlight.size) throw new Error("The Workflow returned no Turn to run.");
      } else if (!inFlight.size) {
        if (step.kind === "done") return step.outcome;
        if (!workflow.act) throw new Error("The Workflow returned an action but has no act.");

        await workflow.act(step.action, log.entries());
        continue;
      }
    } catch (error) {
      errors.push(error);
      continue;
    }

    await Promise.race(inFlight.values());
  }
}

interface Alongside {
  controller: AbortController;
  done: Promise<void>;
  error?: unknown;
}

function startAlongside(run: (signal: AbortSignal) => Promise<void>): Alongside {
  const controller = new AbortController();
  const alongside: Alongside = { controller, done: Promise.resolve() };

  alongside.done = run(controller.signal).catch((error) => {
    alongside.error = error;
  });

  return alongside;
}

/** Map a TurnSpec to the harness request. */
export function turnRequest(
  spec: TurnSpec<string, unknown>,
  turnDir: string,
  onEvent: TurnRequest["onEvent"]
): TurnRequest {
  const { participant } = spec;

  return {
    cwd: spec.cwd,
    model: participant.model,
    effort: participant.effort,
    extraArgs: participant.extraArgs,
    permission: spec.permission,
    // Participants saved before web access existed run without it (ADR 0006).
    web: participant.web ?? false,
    rolePrompt: spec.rolePrompt,
    prompt: spec.prompt,
    ...(spec.schema ? { schema: spec.schema } : {}),
    ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
    turnDir,
    onEvent,
  };
}
