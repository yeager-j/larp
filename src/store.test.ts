import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

import { appendLine, appendRecord, readRecords, tryAcquireTurns } from "./store.js";
import { tempDir } from "./test-support.js";

const store = resolve("src/store.ts");

function worker(script: string): Promise<number> {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    stdio: ["ignore", "ignore", "inherit"],
  });

  return new Promise((done) => child.once("close", (code) => done(code ?? 1)));
}

test("concurrent processes never share the lock or lose appended records", async (t) => {
  const dir = tempDir(t);
  const log = join(dir, "log.jsonl");
  const lock = join(dir, "test.lock");
  const workers = 6;
  const rounds = 40;

  writeFileSync(log, "");
  writeFileSync(lock, "999999999");

  const script = (n: number) => `
    import { appendLine, appendRecord, tryAcquire } from ${JSON.stringify(store)};
    let held = 0;
    while (held < ${rounds}) {
      const lock = tryAcquire(${JSON.stringify(lock)});
      if (!("release" in lock)) continue;
      appendRecord(${JSON.stringify(log)}, { worker: ${n}, event: "enter" });
      appendRecord(${JSON.stringify(log)}, { worker: ${n}, event: "exit", pad: "x".repeat(20000) });
      lock.release();
      held++;
    }
  `;
  const codes = await Promise.all(Array.from({ length: workers }, (_, n) => worker(script(n))));

  assert.deepEqual(codes, Array(workers).fill(0));

  const records = readRecords<{ worker: number; event: string }>(log);
  assert.equal(records.length, workers * rounds * 2);

  for (let i = 0; i < records.length; i += 2) {
    assert.equal(records[i]!.event, "enter");
    assert.equal(records[i + 1]!.event, "exit");
    assert.equal(records[i + 1]!.worker, records[i]!.worker);
  }

  assert.deepEqual(readdirSync(dir).sort(), ["log.jsonl"]);
});

// A smoke test: local file systems rarely split one append, so this cannot prove the read-back retry.
test("concurrent unlocked appends keep every record readable", async (t) => {
  const dir = tempDir(t);
  const log = join(dir, "log.jsonl");
  const workers = 6;
  const records = 60;

  writeFileSync(log, "");

  const script = (n: number) => `
    import { appendRecord } from ${JSON.stringify(store)};
    for (let i = 0; i < ${records}; i++)
      appendRecord(${JSON.stringify(log)}, { id: "${n}-" + i, pad: "x".repeat(i % 3 === 0 ? 300000 : 50) });
  `;
  const codes = await Promise.all(Array.from({ length: workers }, (_, n) => worker(script(n))));

  assert.deepEqual(codes, Array(workers).fill(0));

  const ids = new Set(readRecords<{ id: string }>(log).map((record) => record.id));
  for (let n = 0; n < workers; n++)
    for (let i = 0; i < records; i++) assert.ok(ids.has(`${n}-${i}`), `missing ${n}-${i}`);
});

test("an append never truncates another writer's unfinished line", (t) => {
  const log = join(tempDir(t), "log.jsonl");

  writeFileSync(log, '{"id":"other-in-progress');
  appendRecord(log, { id: "mine" });

  assert.match(readFileSync(log, "utf8"), /^\{"id":"other-in-progress\n\{"id":"mine"\}\n$/);
  assert.deepEqual(readRecords(log), [{ id: "mine" }]);
});

test("a harness process that outlives a killed Relay blocks the next Turn until it exits", async (t) => {
  const dir = tempDir(t);
  const spawnModule = resolve("src/harness/spawn.ts");
  const relay = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
        import { spawnTurn } from ${JSON.stringify(spawnModule)};
        import { nextTurnDir, tryAcquireTurns } from ${JSON.stringify(store)};
        tryAcquireTurns(${JSON.stringify(dir)}, "test.lock");
        await spawnTurn({
          command: "sleep",
          args: ["30"],
          cwd: ${JSON.stringify(dir)},
          turnDir: nextTurnDir(${JSON.stringify(dir)}),
          onLine() {},
        });
      `,
    ],
    { stdio: "ignore" }
  );
  const pidFile = join(dir, "turns", "01", "harness.pid");

  while (!existsSync(pidFile)) await setTimeout(20);

  const harnessPid = Number(readFileSync(pidFile, "utf8"));
  t.after(() => killIfAlive(harnessPid));

  relay.kill("SIGKILL");
  await once(relay, "close");

  assert.throws(() => tryAcquireTurns(dir, "test.lock"), /harness process \(PID \d+\)/);
  assert.ok(!existsSync(join(dir, "test.lock")), "a refused acquire releases the lock");

  process.kill(harnessPid, "SIGTERM");
  while (isRunning(harnessPid)) await setTimeout(20);

  const lock = tryAcquireTurns(dir, "test.lock");
  assert.ok("release" in lock);
  assert.ok(!existsSync(pidFile), "the stale record is removed");
  lock.release();
});

test("a live harness process in any Turn directory blocks the lock; other files are ignored", (t) => {
  const dir = tempDir(t);
  const earlier = join(dir, "turns", "01", "harness.pid");

  mkdirSync(join(dir, "turns", "01"), { recursive: true });
  mkdirSync(join(dir, "turns", "02"), { recursive: true });
  writeFileSync(earlier, String(process.pid));

  assert.throws(() => tryAcquireTurns(dir, "test.lock"), /harness process \(PID \d+\)/);

  writeFileSync(earlier, "999999999");
  writeFileSync(join(dir, "turns", ".DS_Store"), "");
  const lock = tryAcquireTurns(dir, "test.lock");
  assert.ok("release" in lock);
  assert.ok(!existsSync(earlier), "the exited process's record is removed");
  lock.release();
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killIfAlive(pid: number): void {
  if (isRunning(pid)) process.kill(pid, "SIGKILL");
}

test("atomic replacements from concurrent writers always complete", async (t) => {
  const dir = tempDir(t);
  const path = join(dir, "role.json");
  const codes = await Promise.all(
    Array.from({ length: 6 }, (_, n) =>
      worker(`
    import { atomicWrite } from ${JSON.stringify(store)};
    for (let i = 0; i < 50; i++) atomicWrite(${JSON.stringify(path)}, JSON.stringify({writer: ${n}, body: "x".repeat(100000)}));
  `)
    )
  );
  assert.deepEqual(codes, Array(6).fill(0));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).body.length, 100000);
  assert.deepEqual(readdirSync(dir), ["role.json"]);
});

test("appendLine recovers a torn tail in a large log", (t) => {
  const path = join(tempDir(t), "large.jsonl");
  const prefix = '{"saved":true}\n'.repeat(1000000);
  writeFileSync(path, prefix + "x".repeat(9000));
  appendLine(path, { next: true });
  assert.equal(readFileSync(path, "utf8"), prefix + '{"next":true}\n');
  writeFileSync(path, "torn");
  appendLine(path, { first: true });
  assert.equal(readFileSync(path, "utf8"), '{"first":true}\n');
});

test("a Relay crash before recording the child cannot start an unrecorded harness", async (t) => {
  const dir = tempDir(t);
  const marker = join(dir, "started");
  const code = await worker(`
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { spawnTurn } from ${JSON.stringify(resolve("src/harness/spawn.ts"))};
    const original = fs.writeFileSync;
    fs.writeFileSync = (path, ...args) => {
      if (String(path).includes('harness.pid')) process.exit(88);
      return original(path, ...args);
    };
    syncBuiltinESMExports();
    await spawnTurn({ command: process.execPath,
      args: ['-e', ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'started')`)}],
      cwd: ${JSON.stringify(dir)}, turnDir: ${JSON.stringify(dir)}, onLine() {} });
  `);
  assert.equal(code, 88);
  await setTimeout(100);
  assert.equal(existsSync(marker), false);
});

test("appending to an intact large log reads only a bounded tail", async (t) => {
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const path = join(tempDir(t), "large.jsonl");
  writeFileSync(path, '{"saved":true}\n'.repeat(1000000));
  const original = fs.readSync;
  let bytes = 0;
  t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
    const count = Reflect.apply(original, fs, args);
    bytes += count;
    return count;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  appendLine(path, { next: true });
  assert.ok(bytes <= 4096, `read ${bytes} bytes`);
});
