import assert from "node:assert/strict";
import test from "node:test";

import type { Participant } from "../config.js";
import type { Unsaved } from "../store.js";
import { createDiscussOutput } from "./output.js";
import type { DiscussEntry } from "./store.js";

const author: Participant = { harness: "claude", model: "fable", effort: "high", extraArgs: [] };
const critic: Participant = { harness: "codex", model: "astra", effort: "high", extraArgs: [] };

function entry(fields: Unsaved<DiscussEntry>): DiscussEntry {
  return { id: "id", at: "2026-09-24T00:00:00Z", ...fields };
}

test("Discussion output shows each Turn's progress and the entry it committed", () => {
  const lines: string[] = [];
  const ui = createDiscussOutput({
    terminal: false,
    cwd: "/repo",
    write: (line) => lines.push(line),
  });

  ui.startTurn!({ side: "author", participant: author, round: 1, mode: "propose", retry: false });
  ui.event!({ type: "thinking" });
  ui.event!({ type: "thinking" });
  ui.event!({ type: "tool", name: "Read", detail: '{"file_path":"/repo/src/lib.rs"}' });
  ui.event!({ type: "text", text: '{"proposal":"# Plan","body":"First draft"}' });
  ui.entry!(
    entry({
      from: "author",
      kind: "proposal",
      proposal: "# Plan",
      body: "First draft",
      version: 1,
      completion: { sessionId: "author" },
    })
  );
  ui.startTurn!({ side: "critic", participant: critic, round: 1, mode: "verdict", retry: false });
  ui.entry!(
    entry({
      from: "critic",
      kind: "verdict",
      verdict: "revise",
      version: 1,
      objection: "No cost data",
      body: "Add costs.",
      completion: { sessionId: "critic" },
    })
  );
  ui.startTurn!({ side: "author", participant: author, round: 2, mode: "propose", retry: false });
  ui.entry!(
    entry({ from: "relay", kind: "failure", role: "author", body: "Harness exited with code 1." })
  );
  ui.startTurn!({ side: "critic", participant: critic, round: 2, mode: "verdict", retry: true });
  ui.entry!(
    entry({
      from: "critic",
      kind: "verdict",
      verdict: "agree",
      version: 2,
      objection: "Minor",
      body: "",
      completion: { sessionId: "critic" },
    })
  );

  assert.deepEqual(lines, [
    "\n> Round 1 · Author · claude:fable · proposal",
    "| Thinking…",
    "| Read src/lib.rs",
    "| First draft",
    "`- > Proposal v1 · Author → Critic",
    "\n> Round 1 · Critic · codex:astra · verdict",
    "| Strongest objection: No cost data",
    "| Add costs.",
    "`- > Revise proposal v1",
    "\n> Round 2 · Author · claude:fable · proposal",
    "| Harness exited with code 1.",
    "`- ERROR Author Turn failed",
    "\n> Round 2 · Critic · codex:astra · verdict (retry)",
    "| Strongest objection: Minor",
    "`- OK Agreed on proposal v2",
  ]);
});
