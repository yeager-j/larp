/** Normalized harness progress. */
export type HarnessEvent =
  | { type: "tool"; name: string; detail?: string }
  | { type: "text"; text: string }
  | { type: "thinking" }
  | { type: "session"; sessionId: string };
/** One harness invocation with explicit working directory and artifacts. */
export interface TurnRequest {
  /** Working directory for the harness process. */
  cwd: string;
  /** Model selected for this Participant. */
  model: string;
  /** Reasoning effort passed to the harness. */
  effort: string;
  /** File access granted to the Turn. */
  permission: "read-only" | "write";
  /** Role instructions supplied to the harness. */
  rolePrompt: string;
  /** Relay Envelope delivered to the Participant. */
  prompt: string;
  /** Whether this Role has no existing harness session. */
  first: boolean;
  /** Required structured reply format. */
  schema: object;
  /** Existing harness session to resume. */
  sessionId?: string;
  /** Configured arguments for the harness executable. */
  extraArgs: string[];
  /** Directory for raw Turn artifacts. */
  turnDir: string;
  /** Receive normalized progress events during the Turn. */
  onEvent: (event: HarnessEvent) => void;
}
/** Final structured reply and independently reported process errors. */
export interface TurnResult {
  /** Session identifier to use for the next Turn. */
  sessionId: string;
  /** Harness process exit code. */
  exitCode: number;
  /** Final structured reply, if produced. */
  output?: unknown;
  /** Harness or process error, if one occurred. */
  error?: string;
}
/** Adapter boundary used by the Relay. */
export interface Harness {
  /** Harness implementation identifier. */
  id: "claude" | "codex";
  /** Execute one Turn and return its final result. */
  runTurn(req: TurnRequest): Promise<TurnResult>;
}
/** Pure parser output; adapters accumulate final reply and errors. */
export interface ParsedEvent {
  /** Progress events found in one harness record. */
  events: HarnessEvent[];
  /** Structured reply found in the record. */
  output?: unknown;
  /** Error reported in the record. */
  error?: string;
  /** Session identifier found in the record. */
  sessionId?: string;
}
