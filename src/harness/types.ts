/** Normalized harness progress. */
export type HarnessEvent =
  | { type: "tool"; name: string; detail?: string }
  | { type: "text"; text: string }
  | { type: "thinking" }
  | { type: "session"; sessionId: string };
/** One harness invocation with explicit working directory and artifacts. */
export interface TurnRequest {
  cwd: string;
  model: string;
  effort: string;
  permission: "read-only" | "write";
  rolePrompt: string;
  prompt: string;
  first: boolean;
  schema: object;
  sessionId?: string;
  extraArgs: string[];
  turnDir: string;
  onEvent: (event: HarnessEvent) => void;
}
/** Final structured reply and independently reported process errors. */
export interface TurnResult {
  sessionId: string;
  exitCode: number;
  output?: unknown;
  error?: string;
}
/** Adapter boundary used by the Relay. */
export interface Harness {
  id: "claude" | "codex";
  runTurn(req: TurnRequest): Promise<TurnResult>;
}
/** Pure parser output; adapters accumulate final reply and errors. */
export interface ParsedEvent {
  events: HarnessEvent[];
  output?: unknown;
  error?: string;
  sessionId?: string;
}
