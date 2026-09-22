import assert from "node:assert/strict";
import test from "node:test";

import { parseInterjection, renderEvent } from "./tui.js";

test("interjection syntax requires a known Role and body", () => {
  assert.deepEqual(parseInterjection("@planner keep it simple"), {
    role: "planner",
    body: "keep it simple",
  });
  for (const line of ["hello", "@unknown hi", "@planner ", "@reviewer"])
    assert.equal(parseInterjection(line), null);
});
test("event rendering gives Role, model, and tool detail", () => {
  assert.equal(
    renderEvent("planner", "model", { type: "tool", name: "Read", detail: "src/foo.ts" }),
    "Planner · model · Read src/foo.ts"
  );
});
