import assert from "node:assert/strict";
import test from "node:test";

import { envelope } from "./message.js";
import { message } from "./test-support.js";

test("first Envelope names the protocol, task, senders, models, plan, and schema", () => {
  assert.equal(
    envelope({
      role: "planner",
      model: "p",
      task: "Build it",
      firstForRole: true,
      planPath: "/runs/plan.md",
      models: { reviewer: "r" },
      entries: [
        message("reviewer", "feedback", "planner"),
        message("human", "feedback", "planner", { body: "Keep it small" }),
        message("human", "retry", "run", { role: "planner", body: "Try again" }),
      ],
      schemaReminder: "kind, body, plan",
    }),
    `larp is relaying messages to planner (p).

Original task:
Build it

Plan file: /runs/plan.md

From: reviewer (r); kind: feedback
message

From: human; kind: feedback
Keep it small

From: human; kind: retry
Try again

Reply with structured JSON: kind, body, plan`
  );
});
test("later Envelopes omit original task and absent plan", () => {
  assert.equal(
    envelope({
      role: "reviewer",
      model: "r",
      task: "hidden",
      firstForRole: false,
      entries: [],
      schemaReminder: "kind, body",
    }),
    "larp is relaying messages to reviewer (r).\n\nReply with structured JSON: kind, body"
  );
});
