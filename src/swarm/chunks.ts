/** One independent reporting scope within a repository task. */
export interface Chunk {
  /** Unique, filename-safe identifier. */
  id: string;
  /** Literal paths relative to the execution's working directory. */
  paths: string[];
  /** Self-contained instructions for this scope. */
  focus: string;
}

/** Editable input to a swarm execution. */
export interface ChunkDocument {
  /** Supported document format. */
  version: 1;
  /** Shared task for all chunks. */
  task: string;
  /** Independent scopes, in scheduling and display order. */
  chunks: Chunk[];
}

const ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";

/** Structured splitter output; semantic validation also runs locally. */
export const CHUNK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "task", "chunks"],
  properties: {
    version: { type: "integer", enum: [1] },
    task: { type: "string", minLength: 1 },
    chunks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "paths", "focus"],
        properties: {
          id: { type: "string", pattern: ID_PATTERN },
          paths: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          focus: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

/** Parse model output or edited JSON; throws an error identifying the invalid field. */
export function parseChunkDocument(value: unknown): ChunkDocument {
  const document = object(value, "document", ["version", "task", "chunks"]);
  if (document.version !== 1) throw new Error("version must be 1.");
  const task = text(document.task, "task");
  const ids = new Set<string>();
  const chunks = array(document.chunks, "chunks").map((value, index) => {
    const field = `chunks[${index}]`;
    const chunk = object(value, field, ["id", "paths", "focus"]);
    const id = text(chunk.id, `${field}.id`);
    if (!new RegExp(ID_PATTERN).test(id)) throw new Error(`${field}.id must match ${ID_PATTERN}.`);
    if (ids.has(id)) throw new Error(`Duplicate chunk ID: ${id}.`);
    ids.add(id);
    const paths = array(chunk.paths, `${field}.paths`).map((value, index) => {
      const name = `${field}.paths[${index}]`;
      const path = text(value, name);
      if (
        path.startsWith("/") ||
        /^[a-z]:/i.test(path) ||
        /[\\*?\[\]{}\x00-\x1f\x7f-\x9f]/.test(path) ||
        path.split("/").includes("..")
      )
        throw new Error(`${name} must be a literal relative path without parent traversal.`);
      return path;
    });
    return { id, paths, focus: text(chunk.focus, `${field}.focus`) };
  });
  return { version: 1, task, chunks };
}

function object(value: unknown, field: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${field} must be an object.`);
  for (const key of Object.keys(value))
    if (!keys.includes(key)) throw new Error(`${field}.${key} is not supported.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${field} must be nonempty text.`);
  return value;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${field} must be a nonempty array.`);
  return value;
}

/** Parse the CLI concurrency bound; defaults to three simultaneous Turns. */
export function parseParallel(value?: string): number {
  if (value === undefined) return 3;
  if (!/^[1-8]$/.test(value)) throw new Error("--parallel must be an integer from 1 to 8.");
  return Number(value);
}
