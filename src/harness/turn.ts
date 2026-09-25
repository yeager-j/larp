import { TurnInterrupted } from "./spawn.js";
import type { Harness, TurnRequest, TurnResult } from "./types.js";

/** A Turn's process result, resolved into a usable reply or one failure description. */
export type TurnOutcome =
  | { ok: true; sessionId: string; output: unknown }
  | { ok: false; reason: "exit" | "error"; error: string };

/**
 * Build the Turn request, run the Turn, and resolve its process result. A failure to build the
 * request, such as allocating its Turn directory, is a failed Turn. Reply validation stays with
 * each workflow.
 *
 * @throws {TurnInterrupted} When a signal stops the Turn; nothing about it should be committed.
 */
export async function attemptTurn(
  harness: Harness,
  buildRequest: () => TurnRequest
): Promise<TurnOutcome> {
  let result: TurnResult;

  try {
    result = await harness.runTurn(buildRequest());
  } catch (error) {
    if (error instanceof TurnInterrupted) throw error;

    return { ok: false, reason: "error", error: String(error) };
  }

  return outcomeOf(result);
}

function outcomeOf(result: TurnResult): TurnOutcome {
  const reason = result.exitCode !== 0 ? "exit" : "error";

  if (result.error) return { ok: false, reason, error: result.error };
  if (result.exitCode !== 0)
    return { ok: false, reason, error: `Harness exited with code ${result.exitCode}.` };
  if (!result.sessionId) return { ok: false, reason, error: "Harness returned no session ID." };

  return { ok: true, sessionId: result.sessionId, output: result.output };
}
