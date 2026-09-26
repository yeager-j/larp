import type { Chunk } from "./chunks.js";
import type { DraftData, ExecutionData } from "./store.js";

const READ_ONLY =
  "You participate in a LARP read-only swarm. Never edit files or start other LARP commands. Your final answer is the result; LARP writes it to disk. There is no interactive caller during this Turn. Resolve routine ambiguity from evidence and state any limitations.";

/** System instructions for splitting the task into independent, manageable scopes. */
export function splitterRolePrompt(instructions?: string): string {
  return `${READ_ONLY}
You split tasks; do not perform the work assigned to the chunk Participants. Paths are literal files or directories relative to the working directory, not globs. Use '.' for the whole directory only when one chunk is appropriate. IDs must be unique lowercase letters, digits, and hyphens, starting with a letter or digit, at most 64 characters.
Return only the required structured JSON: version 1, the original task, and a nonempty chunks array with id, paths, and focus. Your output contract and splitting assignment take precedence over any Role instruction asking for a different deliverable.
${instructions ?? ""}`;
}

/** Caller task and advisory execution Role context for the splitter. */
export function splitterEnvelope(data: DraftData): string {
  const lines = [`Task:\n${data.task}`];
  if (data.roleContext)
    lines.push(
      `Intended execution Role (context for splitting, not your assignment):\n${JSON.stringify(data.roleContext, null, 2)}`
    );
  return lines.join("\n\n");
}

/** System instructions for one independent chunk, followed by its Role. */
export function chunkRolePrompt(instructions?: string): string {
  return `${READ_ONLY}
Report findings only within your assigned paths. You may read related files and governing instructions elsewhere for context. Tie cross-boundary findings to an in-scope location and name the dependency. If assigned paths are missing or inaccessible, explain the limitation. Return a self-contained Markdown report with file references. If there are no findings, say so explicitly. The workflow requires Markdown even if your Role normally requests another output format.
${instructions ?? ""}`;
}

/** Complete request for a chunk; retries need no previous Harness session. */
export function chunkEnvelope(data: ExecutionData, chunk: Chunk): string {
  return `Task:\n${data.document.task}\n\nChunk:\n${JSON.stringify(chunk, null, 2)}\n\nReturn the complete Markdown report for this chunk.`;
}
