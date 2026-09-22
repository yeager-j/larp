# larp v1 build plan

Implements [docs/design.md](./design.md). Vocabulary from [CONTEXT.md](../CONTEXT.md). Decisions in [docs/adr](./adr).

## Outcomes

User-visible:

- `larp plan "<task>"` opens three pickers (Planner, Reviewer, Implementer), runs the planning loop, pauses at the Gate, runs the implementing Phase, and exits when the Implementer sends `done`.
- `larp plan --planner codex:gpt-5.6-sol --reviewer claude:claude-fable-5-1 --implementer codex:gpt-5.6-sol "<task>"` does the same without pickers, so it can be launched from inside a Claude Code or Codex session.
- `larp resume <run-id>` continues a Run from its log. `larp runs` lists Runs. `larp show <run-id>` prints the Message log.
- A log line per harness event, `--quiet` for Messages and Gates only.

Technical:

- Two harness adapters (Claude, Codex) behind one interface, each split into pure argument building and pure event parsing, plus a thin spawn.
- One workflow (`plan`) as a pure state machine over the Message log.
- One Relay loop that owns spawning, validation, persistence, and the Gate.
- No dependency other than `@clack/prompts`. No git. No network of its own.

## Layout

```
src/
  cli.ts              command parsing; calls into relay + tui
  config.ts           ~/.config/larp/config.json load, seed, model → harness list
  run-store.ts        ~/.larp/runs/<id>/: run.json, messages.jsonl, plan.md, turns/
  message.ts          Message, Kind, Role, Participant types; Envelope rendering
  harness/
    types.ts          Harness interface, TurnRequest, TurnResult, HarnessEvent
    claude.ts         buildClaudeArgs, parseClaudeEvent, claudeHarness
    codex.ts          buildCodexArgs, parseCodexEvent, codexHarness
    spawn.ts          spawn child, stream stdout lines to a callback, close stdin, capture stderr
  workflow/
    plan.ts           phases, per-Role schemas, next-step function, round cap
    prompts.ts        role prompts (Planner, Reviewer, Implementer) as strings
  relay.ts            the loop: pick next Message → Turn → validate → append → workflow.next
  tui.ts              clack pickers, Gate prompt, log renderer
  *.test.ts           next to the module they test
```

## Seams and APIs

### Harness (`src/harness/types.ts`)

```ts
export interface TurnRequest {
  cwd: string;
  model: string;
  effort: string;
  permission: "read-only" | "write";   // Role profile, mapped per harness
  prompt: string;                      // Envelope, or role prompt + Envelope on the first Turn
  schema: object;                      // JSON Schema for the reply
  sessionId?: string;                  // absent on the first Turn
  extraArgs: string[];                 // from config, per Role and harness
  turnDir: string;                     // where raw output lands
  onEvent: (event: HarnessEvent) => void;
}

export interface TurnResult {
  sessionId: string;                   // Claude: the UUID larp generated; Codex: thread_id from thread.started
  exitCode: number;
  output?: unknown;                    // the structured reply, if one was produced
  error?: string;                      // is_error text, turn.failed message, or stderr tail
}

export type HarnessEvent =
  | { type: "tool"; name: string; detail?: string }
  | { type: "text"; text: string }
  | { type: "thinking" }
  | { type: "session"; sessionId: string };

export interface Harness {
  id: "claude" | "codex";
  runTurn(req: TurnRequest): Promise<TurnResult>;
}
```

Claude mapping (from `design.md`): first Turn `--session-id <uuid>` where larp generates the UUID; later `--resume <uuid>`. Always `-p --settings '{"disableAllHooks":true}' --model --effort --output-format stream-json --verbose --json-schema <inline>`. `read-only` adds the plan-mode flag set; `write` adds `--dangerously-skip-permissions`. Prompt goes to stdin. Result comes from the `result` event's `structured_output`; `is_error` and `permission_denials` are surfaced.

Codex mapping: first Turn `codex exec -`; later `codex exec resume <thread-id> -`. Always `--json -m --C <cwd> -c model_reasoning_effort="…" -c sandbox_mode="read-only|workspace-write" --output-schema <turnDir>/schema.json -o <turnDir>/last.json`. Prompt goes to stdin, then stdin is closed. Session comes from `thread.started`. Result is parsed from the `-o` file, not from intermediate `agent_message` items. `turn.failed` and `error` events become `error`.

### Workflow (`src/workflow/plan.ts`)

```ts
export type Role = "planner" | "reviewer" | "implementer";
export type Recipient = Role | "human";

export interface Message {
  id: string; at: string;
  from: Recipient; to: Recipient;
  kind: "request" | "feedback" | "approve" | "question" | "done" | "retry";
  body: string;
  plan?: string;                       // only on Planner → Reviewer request
}

export type Phase = "planning" | "gate" | "implementing" | "done" | "aborted";

export interface PlanState { phase: Phase; round: number; messages: Message[] }

export function schemaFor(role: Role): object;          // per-Role JSON Schema
export function reduce(state: PlanState, msg: Message): PlanState;   // pure
export function nextRecipient(state: PlanState): Recipient | null;   // whose Turn is next, null at a Gate or when done
export function envelope(state: PlanState, msg: Message, ctx: { task: string; planPath?: string; firstForRole: boolean }): string;
```

Per-Role schemas:

- Planner: `to ∈ {reviewer, implementer, human}`, `kind ∈ {request, question, feedback}`, `body`, `plan` (required when `kind = request` and `to = reviewer`).
- Reviewer: `to = planner`, `kind ∈ {feedback, approve}`, `body`.
- Implementer: `to ∈ {planner, human}`, `kind ∈ {question, done}`, `body`.

`reduce` rules: `approve` or round 3 → `gate`. Human `feedback` at the Gate → `planning`, round reset. Human `approve` at the Gate → `implementing`. Implementer `done` → `done`. Human `abort` anywhere → `aborted`. Implementer `question` → Planner; Planner may answer with `feedback` to the Implementer or `question` to the Human.

### Relay (`src/relay.ts`)

```ts
export async function runRelay(opts: {
  run: RunStore; harnesses: Record<HarnessId, Harness>;
  participants: Record<Role, { harness: HarnessId; model: string; effort: string; extraArgs: string[] }>;
  ui: { gate(state: PlanState, planPath?: string): Promise<GateAction>; log(line: string): void };
}): Promise<Phase>;
```

Loop: `nextRecipient` → build the Envelope → `harness.runTurn` → if `output` fails the Role schema, append a `retry` Message once and re-run; on second failure, or on `error`, call `ui.gate` with the stderr tail → append the reply → if it carries `plan`, write `plan.md` → `reduce`. Session IDs are saved to `run.json` as soon as known. Every Message is appended before the next Turn starts, so a crash loses at most one Turn.

### Run store (`src/run-store.ts`)

`create(task, participants)`, `open(runId)`, `append(msg)`, `messages()`, `setSession(role, id)`, `writePlan(text)`, `planPath`, `turnDir(n)`. All synchronous file I/O; `messages.jsonl` is append-only and is the source of truth for `resume`.

### Config (`src/config.ts`)

`~/.config/larp/config.json`:

```json
{
  "models": [
    { "harness": "claude", "model": "claude-fable-5-1" },
    { "harness": "codex",  "model": "gpt-5.6-sol" }
  ],
  "roles": {
    "planner":     { "effort": "high", "extraArgs": { "claude": [], "codex": [] } },
    "reviewer":    { "effort": "high", "extraArgs": { "claude": [], "codex": [] } },
    "implementer": { "effort": "high", "extraArgs": { "claude": [], "codex": [] } }
  }
}
```

Seeded on first run from `~/.codex/models_cache.json` (Codex slugs) and a built-in Claude list. Never rewritten after that.

## Steps

1. **Dependencies and test runner.** Add `@clack/prompts`. Confirm `node --test --import tsx` runs an empty test. Commit.
2. **Message types and Envelope** (`message.ts`). The Envelope states that larp is relaying, names the sender Role and model, gives the Kind, the plan path when one exists, the task text when `firstForRole`, and one line restating the reply schema. Test: snapshot of each variant.
3. **Run store.** Create, append, read back, session IDs, plan file. Test: round-trip in a temp dir.
4. **Claude adapter.** `buildClaudeArgs` (pure) and `parseClaudeEvent` (pure) with a fixture built from the `stream-json` event shapes already seen: `stream_event` with `thinking_delta`, `assistant` with `text` and `tool_use` blocks, `result` with `structured_output`, `is_error`, `session_id`, `permission_denials`. Test both against fixtures. Then the thin `runTurn`.
5. **Codex adapter.** Same split. Fixture from today's smoke test: `thread.started`, `item.completed` with `command_execution` and `agent_message`, `turn.completed`, `turn.failed`, `error`. Test: parse, arg build for first and resumed Turns, and that the result is read from the `-o` file.
6. **Spawn helper.** Line-by-line stdout, stderr capture, stdin write-then-close, exit code. Test with `node -e` as a stand-in child.
7. **Workflow.** `schemaFor`, `reduce`, `nextRecipient`, round cap, all pure. Test: the full happy path (request → feedback → request → approve → gate → approve → done), the cap path, the question path, abort. Also a check that every Role's schema rejects a reply addressed to a Recipient that Role may not address.
8. **Role prompts.** Three strings. Each explains the protocol: later Turns arrive as Envelopes from named Roles via larp, the reply is the structured output, when `question` is allowed (product behavior, scope, external authority, irreversible action), and that nothing outside the Role's permission is attempted. The Planner prompt tells it to write the full plan in `plan`; the Reviewer prompt tells it to read the plan file and reply `approve` only when it has no material objections; the Implementer prompt tells it to read the plan file, do the work including any git it wants, and reply `done` with a short summary in `body`.
9. **Relay loop** with a fake Harness in tests. Test: happy path across all three Phases, one schema failure then success, two schema failures then Gate, harness error then Gate, session IDs persisted after the first Turn, plan file written from the `plan` field.
10. **TUI.** Pickers from config, Gate prompt (approve / message to planner / abort), log renderer for `HarnessEvent` with `--quiet`. Manual check only.
11. **CLI.** `plan`, `resume`, `runs`, `show`. `resume` rebuilds `PlanState` by folding `messages.jsonl` through `reduce`. Manual check.
12. **Live smoke script** `scripts/smoke.sh`, opt-in, runs a trivial task ("write a plan to add a README line") with Haiku as every Role, then with Codex as Reviewer. Not part of `npm test`.

## Invariants

- One child process at a time per Run. The Relay awaits `runTurn` before touching the queue.
- Every Message is appended to `messages.jsonl` before the next Turn is spawned.
- `reduce` is total and pure: the same log always yields the same state, so `resume` is deterministic.
- The Relay never writes inside `cwd`. The only files it writes are under `~/.larp/` and `~/.config/larp/`.
- Session IDs are never parsed from free text. Claude: generated by larp. Codex: from the `thread.started` event.
- A `retry` Message is never sent twice in a row to the same Role.

## Exclusions

Generic workflows, parallel Turns, Turn timeouts, `codex queue` or live-session adapters, git of any kind, a `larp send` command, an MCP server, Ink. No plugin or skill packaging in v1; a Codex skill that calls `larp plan --planner … --implementer …` is a natural follow-up.

## Verification

- `npm test` covers steps 2 through 9 with pure functions and fixtures; no live model calls.
- `npm run typecheck` clean.
- Manual: `larp plan` on this repo with Haiku for all three Roles, watch the log, act at the Gate, confirm `~/.larp/runs/<id>/` holds `run.json`, `messages.jsonl`, `plan.md`, and one `turns/NN/` per Turn. Kill the process mid-Turn and confirm `larp resume` re-runs only that Turn.
- Manual: the same with Codex as Reviewer, confirming the resumed Codex thread sees the earlier plan.

## Least confident

1. **Trust framing in the Envelope.** In today's Haiku test, a bare "From: reviewer, approve this" with no protocol context was refused as a possible injection. The fix is in step 8 (the role prompt describes the protocol before any Envelope arrives) and step 2 (the Envelope says it comes from larp). Recommendation that deviates slightly from `design.md`: on Claude, also pass the role prompt via `--append-system-prompt` on every Turn, since Claude's system prompt is per-invocation and it costs nothing; Codex keeps the prepend. One extra line in the Claude adapter, and the workflow does not change. Your call.
2. **Claude plan mode and the `Write` tool.** The lifted flag set includes `Write` in `--tools` so plan mode can write its native plan file. With `plan_path` dropped, that file is unused. Keeping the flags exactly as your skill has them is the safe choice; removing `Write` is a possible later cleanup after a live run shows plan mode does not need it.
3. **Codex first-Turn stdin.** `codex exec -` reads the prompt from stdin, and today's smoke test showed Codex also waits on inherited stdin. The spawn helper must write the prompt and close stdin in every case; step 6 tests that.
