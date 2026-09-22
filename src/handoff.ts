import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Entry } from "./message.js";

/** Approved planning context for a separate Codex desktop task. */
export interface HandoffContext {
  /** Working directory for the implementation task. */
  cwd: string;
  /** Original Human task. */
  task: string;
  /** Approved plan snapshot. */
  plan: string;
  /** Messages retained as planning context. */
  entries: Entry[];
}
/** Local document to read before starting the desktop task. */
export interface Handoff {
  /** Working directory to open in Codex. */
  cwd: string;
  /** Absolute path to the saved handoff document. */
  handoffPath: string;
}
/** Render the approved context as a standalone Markdown snapshot. */
export function renderHandoff(input: HandoffContext): string {
  const context = input.entries
    .filter(
      (entry) => (entry.from === "human" && entry.kind === "feedback") || entry.from === "reviewer"
    )
    .map((entry) => `From ${entry.from} (${entry.kind}):\n${entry.body}`)
    .join("\n\n");
  return [
    "# Approved implementation handoff",
    `Repository: ${input.cwd}`,
    "Implement the Human-approved plan below. Planning and review were completed in larp. Work in this Codex task using its normal tools and skills, including run-and-queue when appropriate. Verify the work before reporting completion. Resolve routine questions from the repository; ask the Human when a decision is needed. No larp reply schema applies here.",
    `## Original task\n\n${input.task}`,
    `## Approved plan\n\n${input.plan}`,
    ...(context
      ? [
          `## Planning context\n\nChronological; the approved plan is the final agreed version.\n\n${context}`,
        ]
      : []),
  ].join("\n\n");
}
/** Build a short composer link pointing to the saved snapshot; it does not submit the task. */
export function codexHandoffUrl(input: Handoff): string {
  const prompt = `Implement the plan in ${JSON.stringify(input.handoffPath)}. Read this file before starting; it contains the original task, approved plan, and planning context. If it mentions a Linear ticket, use the "implement-linear-ticket" workflow.`;
  const url = new URL("codex://threads/new");
  url.searchParams.set("mode", "codex");
  url.searchParams.set("path", input.cwd);
  url.searchParams.set("prompt", prompt);
  return url.toString();
}
/** Ask macOS to open the composer. Success confirms dispatch, not task creation or execution. */
export async function openCodexHandoff(input: Handoff): Promise<void> {
  if (process.platform !== "darwin")
    throw new Error("Codex desktop handoff currently requires macOS.");
  try {
    await promisify(execFile)("/usr/bin/open", [codexHandoffUrl(input)]);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // execFile errors include the full URL/prompt; do not echo that into the terminal.
    throw new Error(
      `Could not open Codex desktop${code ? ` (${code})` : ""}. Check that the app is installed.`
    );
  }
}
