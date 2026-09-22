import assert from "node:assert/strict";
import test from "node:test";

import { createOutput } from "./output.js";
import { message } from "./test-support.js";
import { parseInterjection } from "./tui.js";

test("interjection syntax requires a known Role and body", () => {
  assert.deepEqual(parseInterjection("@planner keep it simple"), {
    role: "planner",
    body: "keep it simple",
  });
  for (const line of ["hello", "@unknown hi", "@planner ", "@reviewer"])
    assert.equal(parseInterjection(line), null);
});
test("Turn output shortens tools and prints the committed reply once without terminal escapes", () => {
  const lines: string[] = [];
  const output = createOutput({ terminal: false, cwd: "/repo", write: (line) => lines.push(line) });
  output.startTurn("planner", "haiku");
  output.event("planner", "haiku", { type: "session", sessionId: "hidden" });
  output.event("planner", "haiku", {
    type: "tool",
    name: "Read",
    detail: '{"file_path":"/repo/README.md"}',
  });
  output.event("planner", "haiku", {
    type: "tool",
    name: "StructuredOutput",
    detail: '{"kind":"request","body":"Review this"}',
  });
  output.event("planner", "haiku", {
    type: "text",
    text: '{"kind":"request","body":"Review this"}',
  });
  output.message(message("planner", "request", "reviewer", { body: "Review this" }));
  assert.deepEqual(lines, [
    "\n> Planner · haiku",
    "| Read README.md",
    "| Review this",
    "`- > Plan ready for review · Planner → Reviewer",
  ]);
});
