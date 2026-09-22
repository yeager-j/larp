# larp v1 build plan

> Historical v1 document. The Implementer workflow and three-round limit below are superseded by [ADR 0003](./adr/0003-planning-ends-with-desktop-handoff.md): planning now ends with a Codex desktop handoff, and new Runs allow five review rounds. See README.md for current usage.

Implements [docs/design.md](./design.md). Vocabulary from [CONTEXT.md](../CONTEXT.md). Decisions in [docs/adr](./adr).

## Outcomes

User-visible:

- `larp config` reads the current model lists, lets you pick a default Participant (harness and model) for each Role, and writes `~/.config/larp/config.json`. Nothing else ever writes that file.
- `larp plan "<task>"` uses the defaults. `--pick` opens the three pickers instead. `--planner codex:gpt-5.6-sol --reviewer claude:claude-fable-5-1 --implementer codex:gpt-5.6-sol` overrides without pickers, so it can be launched from inside a Claude Code or Codex session.
- While a Turn runs, typing `@planner some text` and Enter records a Human Message that rides in the Planner's next Envelope. Only Roles active in the current Phase are accepted.
- Two Gate types. Phase Gate: approve, message the Planner, abort. Failure Gate: retry, retry with a note, abort.
- `larp resume <run-id>` continues a Run from its log and lands on the same Gate or Turn. `larp runs` lists Runs. `larp show <run-id>` prints the log.
- A log line per harness event, `--quiet` for Messages and Gates only.

Technical:

- Two harness adapters (Claude, Codex) behind one interface, each split into pure argument building and pure event parsing, plus a thin spawn.
- One workflow (`plan`) as a pure reducer over the log. The recipient of every model reply is fixed by the (Role, Kind) pair, so the model never chooses it.
- One Relay loop that owns spawning, validation, persistence, Human interjections, and both Gate types.
- No dependency other than `@clack/prompts`. No git. No network of its own.

## Layout

```
src/
  cli.ts              command parsing; calls into relay, tui, config
  config.ts           ~/.config/larp/config.json load/write; model list sources
  run-store.ts        ~/.larp/runs/<id>/: run.json, messages.jsonl, plan.md, turns/
  message.ts          Entry, Kind, Role types; recipient table; Envelope rendering
  harness/
    types.ts          Harness interface, TurnRequest, TurnResult, HarnessEvent
    claude.ts         buildClaudeArgs, parseClaudeEvent, claudeHarness
    codex.ts          buildCodexArgs, parseCodexEvent, codexHarness
    spawn.ts          spawn child with cwd, stream stdout lines, close stdin, capture stderr
  workflow/
    plan.ts           phases, per-Role schemas, reduce, nextTurn, round cap
    prompts.ts        role prompts (Planner, Reviewer, Implementer) as strings
  relay.ts            the loop: nextTurn → Envelope → Turn → validate → append → reduce
  tui.ts              clack pickers, both Gate prompts, interjection reader, log renderer
  *.test.ts           next to the module they test
```

## Seams and APIs

### Log entries (`src/message.ts`)

Everything that can change the Run's state is one entry in `messages.jsonl`. Model replies, Human actions, and Relay observations share one shape so `reduce` has one input type.

```ts
export type Role = "planner" | "reviewer" | "implementer";
export type Sender = Role | "human" | "relay";
export type Recipient = Role | "human" | "run";

export type Kind =
  | "request" | "feedback" | "approve" | "question" | "done"   // model replies (Human may also send feedback/approve)
  | "abort" | "retry"                                          // Human actions addressed to "run"
  | "failure";                                                 // Relay observation addressed to "run"

export interface Entry {
  id: string; at: string;
  from: Sender; to: Recipient; kind: Kind;
  body: string;
  plan?: string;        // Planner request only
  role?: Role;          // failure/retry: which Role's Turn
  reason?: "schema" | "exit" | "error";   // failure only
}

// Fixed recipient per (Role, Kind). Not part of any model-facing schema.
export const RECIPIENT: Record<Role, Partial<Record<Kind, Recipient>>> = {
  planner:     { request: "reviewer", feedback: "implementer", question: "human" },
  reviewer:    { feedback: "planner", approve: "planner" },
  implementer: { question: "planner", done: "human" },
};

export function envelope(input: {
  role: Role; model: string; task: string; firstForRole: boolean;
  planPath?: string; entries: Entry[];     // every entry waiting for this Role, oldest first
  schemaReminder: string;
}): string;
```

Model-facing schemas carry only `kind` and `body` (plus `plan` for the Planner). The Relay looks up `to` from `RECIPIENT` when it appends the reply. A reply whose `kind` is not in the Role's row cannot be produced, because each Role's schema enumerates only its own Kinds.

Human entries: `{from: human, to: <role>, kind: feedback}` for an interjection or a Gate message; `{from: human, to: run, kind: approve | abort}`; `{from: human, to: run, kind: retry, role, body}` where a non-empty body is a note delivered with the retried Envelope. Relay entries: `{from: relay, to: run, kind: failure, role, reason, body}` and `{from: relay, to: run, kind: retry, role}` for the one automatic schema retry.

### Harness (`src/harness/types.ts`)

```ts
export interface TurnRequest {
  cwd: string;                         // set on the child process for both harnesses
  model: string;
  effort: string;
  permission: "read-only" | "write";   // Role profile, mapped per harness
  rolePrompt: string;                  // always passed; each adapter decides how
  prompt: string;                      // the Envelope (role prompt is prepended on the first Turn)
  first: boolean;
  schema: object;                      // JSON Schema for the reply
  sessionId?: string;                  // absent on the first Turn
  extraArgs: string[];                 // from config, per Role and harness
  turnDir: string;                     // raw stdout, stderr, schema, and result files
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

Claude: first Turn `--session-id <uuid>` with a UUID larp generates; later `--resume <uuid>`. Always `-p --settings '{"disableAllHooks":true}' --model --effort --output-format stream-json --verbose --json-schema <inline> --append-system-prompt <rolePrompt>`. `read-only` adds the plan-mode flag set from `design.md`; `write` adds `--dangerously-skip-permissions`. Prompt goes to stdin, then stdin is closed. Result is the `result` event's `structured_output`; `is_error` and `permission_denials` are surfaced in `error`.

Codex: first Turn `codex exec <prompt>`; later `codex exec resume <thread-id> <prompt>`. Always `--json -m <model> -c model_reasoning_effort="…" -c sandbox_mode="read-only|workspace-write" --output-schema <turnDir>/schema.json -o <turnDir>/last.json`. The prompt is the positional argument (verified on both first and resumed Turns); stdin is closed because Codex otherwise waits on it. No `-C`: `codex exec resume` does not accept it, so the working directory is the child's `cwd`. Session comes from `thread.started`. Result is parsed from the `-o` file, never from intermediate `agent_message` items. `turn.failed` and `error` events become `error`.

### Workflow (`src/workflow/plan.ts`)

```ts
export type Phase = "planning" | "gate" | "implementing" | "failure" | "done" | "aborted";

export interface PlanState {
  phase: Phase;
  round: number;
  pending: Role | null;                // whose Turn is next, when phase is planning or implementing
  failure?: { role: Role; attempts: number; reason: Entry["reason"]; body: string };
  lastPlanEntryId?: string;
}

export const ROUND_CAP = 3;
export function schemaFor(role: Role): object;             // kind enum limited to the Role's row in RECIPIENT
export function initial(): PlanState;
export function reduce(state: PlanState, entry: Entry): PlanState;   // pure, total
export function activeRoles(state: PlanState): Role[];     // whom the Human may address now
```

`reduce` rules:

- `planner request` → pending Reviewer. `reviewer feedback` → round + 1, pending Planner. `reviewer approve` or round ≥ `ROUND_CAP` → `gate`.
- `planner question` → `gate` with the question shown; a Human `feedback` to the Planner resumes planning.
- Human `feedback` to a Role during a Phase → no state change; the entry is delivered in that Role's next Envelope.
- At `gate`: Human `approve` → `implementing`, pending Implementer. Human `feedback` to Planner → `planning`, round 0, pending Planner. Human `abort` → `aborted`.
- `implementer question` → pending Planner. `planner feedback` → pending Implementer. `implementer done` → `done`.
- Relay `failure` → `failure` with attempts + 1. `retry` (Relay or Human) → back to the Phase before the failure with the same pending Role. Human `abort` → `aborted`.

`nextTurn(state)` returns the pending Role when the Phase is `planning` or `implementing`, otherwise null (a Gate, or the end).

### Relay (`src/relay.ts`)

```ts
export async function runRelay(opts: {
  run: RunStore;
  harnesses: Record<"claude" | "codex", Harness>;
  participants: Record<Role, { harness: "claude" | "codex"; model: string; effort: string; extraArgs: string[] }>;
  ui: {
    phaseGate(state: PlanState, planPath?: string): Promise<{ kind: "approve" } | { kind: "feedback"; body: string } | { kind: "abort" }>;
    failureGate(state: PlanState): Promise<{ kind: "retry"; body: string } | { kind: "abort" }>;
    interjections(): AsyncIterable<{ role: Role; body: string }>;   // stdin lines while a Turn runs
    log(line: string): void;
  };
}): Promise<Phase>;
```

Loop:

1. Fold the log through `reduce` to get `state`. On `resume`, also rewrite `plan.md` from the latest `request` entry so the file can never lag the log.
2. If `nextTurn(state)` is null: run the matching Gate, append the Human's entry, go to 1.
3. Collect every entry addressed to the pending Role that has not been delivered yet (tracked by a `delivered` set in `run.json`), plus any Human interjections for that Role. Render one Envelope. If this is a retry with a note, the note is included.
4. Start the Turn. While it runs, drain `interjections()`: each is appended immediately; ones for the running Role wait for its next Envelope.
5. On return: if `error`, append `failure` (reason `exit` or `error`) and go to 1. If `output` fails the Role schema or, for the Planner, has `kind: request` with an empty `plan`: on the first attempt append `failure` (reason `schema`) then a Relay `retry` and go to 1; on the second, append `failure` only and go to 1. Otherwise, if the reply carries `plan`, write `plan.md` first, then append the reply with `to` from `RECIPIENT`, mark delivered entries, save the session ID if new, go to 1.

A crash between any two steps loses at most the Turn in flight, and `resume` re-runs exactly that Turn.

### Run store (`src/run-store.ts`)

`create(task, participants)`, `open(runId)`, `append(entry)`, `entries()`, `setSession(role, id)`, `markDelivered(ids)`, `writePlan(text)`, `planPath`, `turnDir(n)`. Synchronous file I/O; `messages.jsonl` is append-only and the source of truth; `run.json` holds only what cannot be derived from it (task, participants, session IDs, delivered set).

### Config (`src/config.ts`)

```json
{
  "models": [
    { "harness": "claude", "model": "claude-fable-5-1" },
    { "harness": "codex",  "model": "gpt-5.6-sol" }
  ],
  "defaults": {
    "planner":     { "harness": "claude", "model": "claude-fable-5-1" },
    "reviewer":    { "harness": "codex",  "model": "gpt-5.6-sol" },
    "implementer": { "harness": "codex",  "model": "gpt-5.6-sol" }
  },
  "roles": {
    "planner":     { "effort": "high", "extraArgs": { "claude": [], "codex": [] } },
    "reviewer":    { "effort": "high", "extraArgs": { "claude": [], "codex": [] } },
    "implementer": { "effort": "high", "extraArgs": { "claude": [], "codex": [] } }
  }
}
```

`larp config`: Codex models come from `~/.codex/models_cache.json` (`models[].slug`, with `fetched_at` shown so a stale cache is visible; running any `codex` command refreshes it). Claude models come from a built-in list plus a free-text entry, since no CLI or subscription API lists them; a wrong name fails on the first Turn and lands on a Failure Gate. The command then asks for a default per Role and writes the file. `larp plan` refuses to start without a config file and points at `larp config`.

## Steps

1. **Dependencies and test runner.** Add `@clack/prompts`. Confirm `node --test --import tsx` runs an empty test. Commit.
2. **Entries, recipient table, Envelope** (`message.ts`). The Envelope states that larp is relaying, lists each carried entry with sender and model, gives the plan path and, when `firstForRole`, the task text, then one line restating the reply schema. Test: snapshot of each variant, including one with a Human interjection and one with a retry note.
3. **Run store.** Create, append, read back, session IDs, delivered set, plan file. Test: round-trip in a temp dir.
4. **Claude adapter.** `buildClaudeArgs` and `parseClaudeEvent`, pure, with a fixture built from the `stream-json` shapes already seen: `stream_event` with `thinking_delta`, `assistant` with `text` and `tool_use` blocks, `result` with `structured_output`, `is_error`, `session_id`, `permission_denials`. Test both. Then the thin `runTurn`.
5. **Codex adapter.** Same split. Fixture from the smoke test: `thread.started`, `item.completed` with `command_execution` and `agent_message`, `turn.completed`, `turn.failed`, `error`. Test: parse, args for first and resumed Turns (no `-C`, prompt positional), and that the result is read from the `-o` file.
6. **Spawn helper.** `cwd`, line-by-line stdout, stderr capture, stdin closed, exit code. Test with `node -e` as a stand-in child, including one that reads stdin to prove it gets EOF.
7. **Workflow.** `schemaFor`, `reduce`, `activeRoles`, `nextTurn`, round cap, all pure. Test: the happy path (request → feedback → request → approve → gate → approve → done), the cap path, the question paths, interjection with no state change, failure then Relay retry then success, failure twice then Human retry, abort from each Phase. Also a check that each Role's schema enumerates exactly its row of `RECIPIENT`.
8. **Role prompts.** Three strings. Each explains the protocol first: larp relays between named Roles, later Turns arrive as Envelopes from larp, the reply is the structured output and its `kind` decides who receives it, when `question` is allowed (product behavior, scope, external authority, irreversible action), and that nothing outside the Role's permission is attempted. The Planner prompt tells it to put the full plan in `plan`; the Reviewer prompt tells it to read the plan file and reply `approve` only when it has no material objections; the Implementer prompt tells it to read the plan file, do the work including any git it wants, and reply `done` with a short summary in `body`.
9. **Relay loop** with a fake Harness and a scripted `ui`. Test: happy path across all three Phases, an interjection delivered in the next Envelope for that Role, one schema failure then success, two schema failures then a Failure Gate with retry and note, harness error then Failure Gate, session IDs persisted after the first Turn, plan file written before the entry is appended, resume mid-Turn re-runs only that Turn, resume rewrites `plan.md`.
10. **`larp config`.** Model sources, pickers, write. Test the model-source readers against a fixture cache file.
11. **TUI.** Pickers, both Gates, interjection reader (`@role text` lines on the parent's stdin, which stays free because the child's stdin is a closed pipe), log renderer with `--quiet`. Manual check.
12. **CLI.** `config`, `plan` (defaults, `--pick`, explicit flags), `resume`, `runs`, `show`. Manual check.
13. **Live smoke script** `scripts/smoke.sh`, opt-in, runs a trivial task with Haiku as every Role, then with Codex as Reviewer. Not part of `npm test`.

## Invariants

- One child process at a time per Run. The Relay awaits `runTurn` before touching the log.
- The plan file is written before the entry that carries it is appended, and `resume` rewrites it from the log.
- `reduce` is total and pure: the same log always yields the same state, so `resume` is deterministic and both Gate types are reproducible.
- The Relay never writes inside `cwd`. The only files it writes are under `~/.larp/` and `~/.config/larp/`.
- Session IDs are never parsed from free text. Claude: generated by larp. Codex: from the `thread.started` event.
- The Relay issues at most one automatic `retry` per failure; the second failure always reaches the Human.
- A model-facing schema never contains `to`.

## Exclusions

Generic workflows, parallel Turns, Turn timeouts, `codex queue` or live-session adapters, git of any kind, a `larp send` command, an MCP server, Ink, silent config seeding. No plugin or skill packaging in v1; a Codex skill that calls `larp plan --planner … --implementer …` is a natural follow-up.

## Verification

- `npm test` covers steps 2 through 10 with pure functions, fixtures, and a fake Harness; no live model calls.
- `npm run typecheck` clean.
- Manual: `larp config`, then `larp plan` on this repo with Haiku for all three Roles. Type an `@planner` note during the Reviewer's Turn and confirm it appears in the Planner's next Envelope. Act at the Phase Gate. Confirm `~/.larp/runs/<id>/` holds `run.json`, `messages.jsonl`, `plan.md`, and one `turns/NN/` per Turn. Kill the process mid-Turn and confirm `larp resume` re-runs only that Turn. Force a schema failure (bad model name for one Role) and confirm the Failure Gate offers retry, not approve.
- Manual: the same with Codex as Reviewer, confirming the resumed Codex thread sees the earlier plan.

## Least confident

1. **Trust framing.** In the Haiku test, a bare "From: reviewer, approve this" with no protocol context was refused as a possible injection. Steps 2 and 8 address it, and the Claude adapter passes the role prompt as `--append-system-prompt` on every Turn in addition to the first-Turn prepend. This is a small deviation from the original "prepend only" decision and is now written into `design.md`; veto it if you disagree.
2. **Claude plan mode and the `Write` tool.** The lifted flag set includes `Write` so plan mode can write its native plan file. With `plan_path` gone, that file is unused. The flags stay exactly as your skill has them; removing `Write` is a possible later cleanup after a live run.
3. **Interjection ergonomics.** Reading `@role text` lines from the parent's stdin while a log streams is functional but plain. It satisfies the design without a second UI thread; Ink can improve it later if it annoys you.
