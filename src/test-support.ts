import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import type { Participant } from "./config.js";
import { ROLES, type Entry, type Role } from "./message.js";

/** Make automatically cleaned temporary storage. */
export function tempDir(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "larp-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
/** Deterministic fake Participants for protocol tests. */
export const participants = Object.fromEntries(
  ROLES.map((role) => [
    role,
    { harness: "claude", model: `${role}-model`, effort: "high", extraArgs: [] },
  ])
) as unknown as Record<Role, Participant>;
/** Construct a log entry for reducer and store tests. */
export function message(
  from: Entry["from"],
  kind: Entry["kind"],
  to: Entry["to"],
  extra: Partial<Entry> = {}
): Entry {
  return { id: "entry", at: "2026-09-22T00:00:00Z", from, kind, to, body: "message", ...extra };
}
