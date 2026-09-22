import assert from "node:assert/strict";
import test from "node:test";

import { RECIPIENT, ROLES } from "../message.js";
import { message } from "../test-support.js";
import {
  activeRoles,
  initial,
  nextTurn,
  reduce,
  ROUND_CAP,
  schemaFor,
  validReply,
  type PlanState,
} from "./plan.js";

const request = message("planner", "request", "reviewer");
const feedback = message("reviewer", "feedback", "planner");
const approval = message("reviewer", "approve", "planner");
const humanApproval = message("human", "approve", "run");
test("happy path, review cap, active Roles, and terminal stability", () => {
  let state = initial();
  assert.deepEqual(activeRoles(state), ["planner", "reviewer"]);
  for (const item of [request, feedback, request, approval]) state = reduce(state, item);
  assert.equal(state.phase, "gate");
  assert.equal(nextTurn(state), null);
  state = reduce(state, humanApproval);
  assert.deepEqual(activeRoles(state), ["planner", "implementer"]);
  state = reduce(state, message("implementer", "done", "human"));
  assert.equal(state.phase, "done");
  assert.equal(reduce(state, message("human", "abort", "run")), state);
  state = initial();
  for (let i = 0; i < ROUND_CAP; i++) {
    state = reduce(state, request);
    state = reduce(state, feedback);
  }
  assert.equal(state.phase, "gate");
  assert.equal(state.round, ROUND_CAP);
});
test("Planner questions, Gate feedback, Implementer questions, and escalation", () => {
  let state = reduce(initial(), message("planner", "question", "human"));
  assert.equal(state.phase, "gate");
  assert.equal(reduce(state, humanApproval), state);
  state = reduce(state, message("human", "feedback", "planner"));
  assert.equal(nextTurn(state), "planner");
  for (const item of [
    request,
    approval,
    humanApproval,
    message("implementer", "question", "planner"),
  ])
    state = reduce(state, item);
  assert.equal(nextTurn(state), "planner");
  state = reduce(state, message("planner", "question", "human"));
  state = reduce(state, message("human", "feedback", "planner"));
  assert.equal(state.phase, "implementing");
  state = reduce(state, message("planner", "feedback", "implementer"));
  assert.equal(nextTurn(state), "implementer");
});
test("interjections do not schedule Turns; failures return to the original phase", () => {
  const state = initial();
  assert.equal(reduce(state, message("human", "feedback", "reviewer")), state);
  for (const phase of ["planning", "implementing"] as const) {
    let current: PlanState = { ...state, phase };
    const failure = message("relay", "failure", "run", { role: "planner", reason: "schema" });
    const retry = message("relay", "retry", "run", { role: "planner" });
    current = reduce(current, failure);
    assert.equal(current.failure?.attempts, 1);
    current = reduce(current, retry);
    assert.equal(current.phase, phase);
    current = reduce(current, failure);
    assert.equal(current.failure?.attempts, 2);
    current = reduce(current, message("human", "retry", "run", { role: "planner" }));
    assert.equal(current.phase, phase);
    assert.equal(current.failure, undefined);
    const success = phase === "planning" ? request : message("planner", "feedback", "implementer");
    assert.equal(reduce(current, success).failure, undefined);
  }
});
test("abort works from each live phase; unrelated model moves are ignored", () => {
  for (const phase of ["planning", "gate", "implementing", "failure"] as const) {
    assert.equal(
      reduce({ ...initial(), phase }, message("human", "abort", "run")).phase,
      "aborted"
    );
  }
  const state = initial();
  assert.equal(reduce(state, message("implementer", "done", "human")), state);
  assert.equal(reduce(state, message("planner", "request", "human")), state);
});
test("schemas match the fixed routing table and validate strict replies", () => {
  for (const role of ROLES) {
    const schema = schemaFor(role) as { properties: { kind: { enum: string[] } } };
    assert.deepEqual(schema.properties.kind.enum, Object.keys(RECIPIENT[role]));
    assert.ok(!("to" in schema.properties));
  }
  assert.ok(validReply("planner", { kind: "request", body: "plan", plan: "full plan" }));
  assert.ok(validReply("planner", { kind: "question", body: "why?", plan: null }));
  assert.ok(!validReply("planner", { kind: "request", body: "plan", plan: " " }));
  assert.ok(!validReply("reviewer", { kind: "approve", body: "yes", to: "planner" }));
  assert.ok(!validReply("implementer", { kind: "approve", body: "yes" }));
  assert.ok(!validReply("planner", { kind: "question", body: "why?", plan: "overwrite" }));
});
