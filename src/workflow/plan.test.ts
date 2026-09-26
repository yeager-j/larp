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
  assert.deepEqual(activeRoles(state), []);
  assert.equal(nextTurn(state), null);
  state = reduce(state, message("relay", "handoff", "human"));
  assert.equal(state.phase, "handed-off");
  assert.equal(reduce(state, message("human", "abort", "run")), state);
  state = initial();
  assert.equal(ROUND_CAP, 5);
  for (let i = 0; i < ROUND_CAP; i++) {
    state = reduce(state, request);
    state = reduce(state, feedback);
    if (i < 4) assert.equal(state.phase, "planning");
  }
  assert.equal(state.phase, "gate");
  assert.equal(state.round, ROUND_CAP);
});
test("Planner questions and Gate feedback resume planning", () => {
  let state = reduce(initial(), message("planner", "question", "human"));
  assert.equal(state.phase, "gate");
  assert.equal(reduce(state, humanApproval), state);
  state = reduce(state, message("human", "feedback", "planner"));
  assert.equal(nextTurn(state), "planner");
  for (const item of [request, approval]) state = reduce(state, item);
  state = reduce(state, message("human", "feedback", "planner"));
  assert.equal(state.phase, "planning");
  assert.equal(state.round, 0);
});
test("interjections do not schedule Turns; failures return to the original phase", () => {
  const state = initial();
  assert.equal(nextTurn(reduce(state, message("human", "feedback", "reviewer"))), "planner");
  for (const phase of ["planning"] as const) {
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
    const success = request;
    assert.equal(reduce(current, success).failure, undefined);
  }
});
test("abort works from each live phase; unrelated model moves are ignored", () => {
  for (const phase of ["planning", "gate", "handoff", "failure"] as const) {
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
  assert.ok(!validReply("planner", { kind: "feedback", body: "yes", plan: null }));
  assert.ok(!validReply("planner", { kind: "question", body: "why?", plan: "overwrite" }));
});

test("a Planner question after a saved plan cannot approve that plan", () => {
  let state = [request, feedback, message("planner", "question", "human")].reduce(
    reduce,
    initial()
  );
  assert.equal(state.lastPlanEntryId, request.id);
  assert.equal(state.gateReason, "question");
  assert.equal(reduce(state, humanApproval), state);
});

for (const role of ["planner", "reviewer"] as const) {
  test(`final review waits for an unread ${role} interjection`, () => {
    const interjection = message("human", "feedback", role, { id: "interjection" });
    let state = [request, interjection, approval].reduce(reduce, initial());
    assert.equal(state.phase, "planning");
    assert.equal(nextTurn(state), role);
    assert.equal(reduce(state, humanApproval), state);
    const response = message(
      role,
      role === "planner" ? "request" : "approve",
      role === "planner" ? "reviewer" : "planner",
      {
        completion: { sessionId: "session", delivered: [interjection.id] },
      }
    );
    state = reduce(state, response);
    if (role === "planner") state = reduce(state, approval);
    assert.equal(state.phase, "gate");
    assert.equal(reduce(state, humanApproval).phase, "handoff");
  });
}
