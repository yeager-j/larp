import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { Harness, TurnRequest, TurnResult } from "../harness/types.js";
import { builtInRole } from "../roles.js";
import { tempDir } from "../test-support.js";
import { agentEnvelope } from "./prompt.js";
import { deliver, formatReplies } from "./run.js";
import { AgentStore, listAgents, type AgentEntry } from "./store.js";

const role = {
  ...builtInRole("reviewer", { harness: "codex", model: "gpt-test" }),
  permission: "write" as const,
};

function send(agent: AgentStore, body: string): AgentEntry {
  const entry: AgentEntry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    from: "caller",
    kind: "message",
    body,
  };

  agent.append(entry);

  return entry;
}

function fakeHarness(
  turns: TurnRequest[],
  reply: (req: TurnRequest, n: number) => Partial<TurnResult> = () => ({})
): Harness {
  return {
    id: "codex",
    async runTurn(req) {
      turns.push(req);
      return {
        sessionId: req.sessionId ?? "thread-1",
        exitCode: 0,
        output: `reply ${turns.length}`,
        ...reply(req, turns.length),
      };
    },
  };
}

function harnesses(fake: Harness) {
  return { claude: fake, codex: fake };
}

test("first Turn starts a session with Role settings; later Turns resume it", async (t) => {
  const root = tempDir(t);
  const agent = AgentStore.create(role, undefined, root, root);
  const turns: TurnRequest[] = [];
  const fake = fakeHarness(turns);
  const first = send(agent, "Review the plan");

  const delivery = await deliver(agent, harnesses(fake));
  assert.equal(delivery.status, "replied");
  assert.deepEqual(delivery.status === "replied" && delivery.replies.map((reply) => reply.body), [
    "reply 1",
  ]);
  assert.equal(turns[0]!.first, true);
  assert.equal(turns[0]!.permission, "write");
  assert.equal(turns[0]!.schema, undefined);
  assert.equal(turns[0]!.prompt, "Review the plan");
  assert.match(turns[0]!.rolePrompt, /Caller[\s\S]*You are a reviewer/);

  send(agent, "Again");
  await deliver(AgentStore.open(agent.data.id, root), harnesses(fake));
  assert.equal(turns[1]!.first, false);
  assert.equal(turns[1]!.sessionId, "thread-1");

  const reopened = AgentStore.open(agent.data.id, root);
  assert.equal(reopened.sessionId(), "thread-1");
  assert.deepEqual(reopened.undelivered(), []);
  assert.deepEqual(reopened.entries()[1]?.completion?.delivered, [first.id]);
  assert.equal(listAgents(root)[0]?.role, "reviewer");
  assert.throws(() => AgentStore.open("../x", root), /Invalid Agent ID/);
});

test("a message queued during a Turn is delivered by the same process in the next Turn", async (t) => {
  const root = tempDir(t);
  const agent = AgentStore.create(role, undefined, root, root);
  const turns: TurnRequest[] = [];
  const fake = fakeHarness(turns, (_req, n) => {
    if (n === 1) {
      const other = AgentStore.open(agent.data.id, root);
      send(other, "Also check tests");
      send(other, "And docs");
    }
    return {};
  });

  send(agent, "Review");
  const delivery = await deliver(agent, harnesses(fake));

  assert.equal(turns.length, 2);
  assert.match(
    turns[1]!.prompt,
    /2 messages[\s\S]*Message 1:\nAlso check tests[\s\S]*Message 2:\nAnd docs/
  );
  assert.equal(delivery.status === "replied" && delivery.replies.length, 2);
  const replies = delivery.status === "replied" ? delivery.replies : [];
  assert.equal(
    formatReplies(agent.data, replies, agent.entries()),
    [
      '[larp] Reply to: "Review"',
      "",
      "reply 1",
      "",
      "---",
      "",
      '[larp] Reply to: "Also check tests" (and 1 more)',
      "",
      "reply 2",
      "",
      `[larp] agent ${agent.data.id} · reviewer · codex:gpt-test`,
      `[larp] Continue: larp agent message ${agent.data.id} --message "<text>"`,
    ].join("\n")
  );
  assert.doesNotMatch(formatReplies(agent.data, replies.slice(0, 1), agent.entries()), /Reply to/);
});

test("a live lock queues the message; a dead lock is recovered", async (t) => {
  const root = tempDir(t);
  const agent = AgentStore.create(role, undefined, root, root);
  const turns: TurnRequest[] = [];
  const lock = agent.tryAcquire();

  send(agent, "Review");
  assert.ok("release" in lock);
  assert.deepEqual(await deliver(agent, harnesses(fakeHarness(turns))), {
    status: "queued",
    heldBy: process.pid,
  });
  assert.equal(turns.length, 0);

  lock.release();
  writeFileSync(join(agent.directory, "agent.lock"), "999999999");
  assert.equal((await deliver(agent, harnesses(fakeHarness(turns)))).status, "replied");
  assert.equal(turns.length, 1);
});

test("stale lock recovery defers to a live recoverer, and release keeps another holder's lock", (t) => {
  const agent = AgentStore.create(role, undefined, tempDir(t));
  const lock = join(agent.directory, "agent.lock");
  const guard = `${lock}.recover`;

  writeFileSync(lock, "999999999");
  writeFileSync(guard, String(process.pid));
  assert.deepEqual(agent.tryAcquire(), { heldBy: process.pid });
  assert.equal(readFileSync(lock, "utf8"), "999999999");

  writeFileSync(guard, "999999998");
  assert.throws(() => agent.tryAcquire(), /Stale agent.lock.recover/);

  unlinkSync(guard);
  const taken = agent.tryAcquire();
  assert.ok("release" in taken);
  assert.equal(existsSync(guard), false);

  writeFileSync(lock, "999999997");
  taken.release();
  assert.equal(readFileSync(lock, "utf8"), "999999997");
});

test("a failed Turn leaves its message waiting, and the next delivery carries it", async (t) => {
  const root = tempDir(t);
  const agent = AgentStore.create(role, undefined, root, root);
  const turns: TurnRequest[] = [];
  const failing = fakeHarness(turns, () => ({ exitCode: 2, output: undefined }));

  send(agent, "First");
  assert.deepEqual(await deliver(agent, harnesses(failing)), {
    status: "failed",
    replies: [],
    error: "Harness exited with code 2.",
  });
  assert.equal(agent.entries().at(-1)?.kind, "failure");
  assert.equal(agent.sessionId(), undefined);

  send(agent, "Second");
  await deliver(agent, harnesses(fakeHarness(turns)));
  assert.equal(turns[1]!.first, true);
  assert.match(turns[1]!.prompt, /First[\s\S]*Second/);
  assert.deepEqual(agent.undelivered(), []);
});

test("a Role schema is passed to the harness and structured replies are kept", async (t) => {
  const root = tempDir(t);
  const schema = { type: "object" };
  const agent = AgentStore.create(role, schema, root, root);
  const turns: TurnRequest[] = [];
  const fake = fakeHarness(turns, () => ({ output: { verdict: "ok" } }));

  send(agent, "Review");
  const delivery = await deliver(agent, harnesses(fake));

  assert.deepEqual(turns[0]!.schema, schema);
  assert.equal(
    delivery.status === "replied" && delivery.replies[0]?.body,
    '{\n  "verdict": "ok"\n}'
  );
  assert.deepEqual(agent.entries().at(-1)?.output, { verdict: "ok" });

  send(agent, "Again");
  const textFromSchema = fakeHarness(turns, () => ({ output: undefined }));
  assert.equal((await deliver(agent, harnesses(textFromSchema))).status, "failed");
});

test("a torn or in-progress log line never hides a later entry", (t) => {
  const root = tempDir(t);
  const agent = AgentStore.create(role, undefined, root, root);

  appendFileSync(join(agent.directory, "messages.jsonl"), '{"id":"torn');
  const message = send(agent, "After crash");
  appendFileSync(join(agent.directory, "messages.jsonl"), '{"id":"in-progress');

  assert.deepEqual(agent.entries(), [message]);
});

test("one waiting message is sent as written", () => {
  const entry = (body: string): AgentEntry => ({
    id: body,
    at: "",
    from: "caller",
    kind: "message",
    body,
  });

  assert.equal(agentEnvelope([entry("Only")]), "Only");
});
