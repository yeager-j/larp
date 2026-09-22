import assert from "node:assert/strict";
import test from "node:test";

import { codexHandoffUrl, renderHandoff } from "./handoff.js";
import { message } from "./test-support.js";

test("a long plan stays in the handoff document while the desktop link contains only its path", () => {
  const plan = "# Approved\nUse A & B? Include π and #fragment.\n".repeat(10000);
  const document = renderHandoff({
    cwd: "/repo with spaces/π",
    task: "Fix #42 & test",
    plan,
    entries: [
      message("human", "feedback", "planner", { body: "Keep the old API" }),
      message("reviewer", "feedback", "planner", { body: "Add tests" }),
    ],
  });
  assert.ok(document.includes(plan));
  assert.match(document, /Fix #42 & test/);
  assert.match(document, /Keep the old API/);
  assert.match(document, /Add tests/);
  assert.match(document, /run-and-queue/);
  const handoffPath = "/Users/name with spaces/.larp/runs/π & #42/handoff.md";
  const link = codexHandoffUrl({ cwd: "/repo with spaces/π", handoffPath });
  const url = new URL(link);
  assert.equal(url.protocol, "codex:");
  assert.equal(url.host, "threads");
  assert.equal(url.pathname, "/new");
  assert.equal(url.searchParams.get("mode"), "codex");
  assert.equal(url.searchParams.get("path"), "/repo with spaces/π");
  const prompt = url.searchParams.get("prompt")!;
  assert.ok(prompt.includes(JSON.stringify(handoffPath)));
  assert.match(prompt, /Read this file before starting/);
  assert.ok(!prompt.includes(plan));
  assert.ok(link.length < 1500);
  assert.equal(url.searchParams.has("model"), false);
});
