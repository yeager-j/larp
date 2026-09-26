import assert from "node:assert/strict";
import test from "node:test";

import { parseChunkDocument, parseParallel } from "./chunks.js";

const valid = {
  version: 1,
  task: "Style sweep",
  chunks: [{ id: "harness", paths: ["src/harness/", "README.md"], focus: "Review adapters" }],
};

test("chunk documents preserve user edits and allow whole-directory scope", () => {
  assert.deepEqual(parseChunkDocument(valid), valid);
  const whole = structuredClone(valid);
  whole.chunks[0]!.paths = ["."];
  assert.deepEqual(parseChunkDocument(whole), whole);
});

test("invalid chunk documents name the broken field", () => {
  for (const [value, expected] of [
    [{ ...valid, version: 2 }, /version/],
    [{ ...valid, task: " " }, /task/],
    [{ ...valid, extra: true }, /extra/],
    [{ ...valid, chunks: [] }, /chunks/],
    [{ ...valid, chunks: [valid.chunks[0], valid.chunks[0]] }, /Duplicate.*harness/],
  ] as const)
    assert.throws(() => parseChunkDocument(value), expected);

  for (const changes of [{ id: "../escape" }, { paths: [] }, { focus: " " }, { extra: true }])
    assert.throws(
      () => parseChunkDocument({ ...valid, chunks: [{ ...valid.chunks[0], ...changes }] }),
      /chunks\[0\]/
    );

  for (const path of ["/root", "../a", "a/../b", "C:/a", "a\\b", "**/*.ts", "a\n", "a\u001b", ""]) {
    assert.throws(
      () => parseChunkDocument({ ...valid, chunks: [{ ...valid.chunks[0], paths: [path] }] }),
      /paths\[0\]/
    );
  }
});

test("parallelism defaults to three and is bounded before any Turn", () => {
  assert.equal(parseParallel(), 3);
  assert.equal(parseParallel("8"), 8);
  for (const value of ["0", "9", "1.5", "abc", "", "Infinity"])
    assert.throws(() => parseParallel(value), /1 to 8/);
});
