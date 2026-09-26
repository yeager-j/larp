# Read-only swarms: implementation plan

Status: approved and implemented. This document records the agreed contract; see README.md for usage.

## Outcome

Add a workflow that splits a repository task into editable chunks, then runs one independent Participant per chunk. The first use case is a code style sweep. Both the splitter and chunk Participants use the existing read-only Harness permission profiles. LARP saves each final chunk reply as Markdown.

The Caller reviews the chunk file between `init` and `start`. There is no interactive approval prompt, background service, or automatic execution after chunking.

## Command contract

```sh
larp swarm init --message "Code style sweep of the whole repository" \
  --role style-reviewer

# Review and edit the printed chunks.json file.
larp swarm start --chunks <path>/chunks.json --role style-reviewer \
  --parallel 3 --out <new-directory>

larp swarm resume <swarm-id>
larp swarm list
larp swarm show <swarm-id>
```

- `init` requires a nonempty `--message`. Its optional `--role` supplies the intended chunk Role's name, description, and instructions as context for splitting. The dedicated `swarm-planner` Role supplies the splitter's Harness, model, effort, web setting, and chunking guidance. The workflow owns the read-only rules and chunk schema. `larp config` creates this Role when missing, including for existing installations, using the existing model picker and preserving customized Role content. Built-in setup Roles remain separate from the plan workflow's Participant list.
- `start` requires `--chunks` and `--role`. It can consume a hand-written file, so `init` is optional. It always creates a new execution identity; it never infers a draft identity from the file path. Reusing a chunk file deliberately starts a fresh execution.
- `--parallel` defaults to 3 and accepts integers from 1 through 8 for v1. This bounds direct Harness processes, not any subagents a Harness creates internally. The upper bound keeps the first release's process and signal handling modest.
- `--out` applies only to `start`. It is resolved against the command's working directory and must name a directory that does not yet exist. LARP creates it exclusively before starting any chunk. This prevents two swarms from sharing output files. Without it, use the execution's `results/` directory.
- All chunk paths are relative to the working directory of `start`, regardless of where the chunk file is stored. Print that absolute working directory at startup. Run `init` and `start` from the same directory when using a generated file for that repository.
- `resume` uses saved inputs, including the working directory, Role settings, output directory, and parallel limit. It takes no replacement input flags. Resuming a draft can finish chunking, but never starts chunk execution.
- `list` shows ID, draft/execution kind, creation time, task, and progress derived from the log. `show` prints the persisted metadata and log, including errors and output location, without invoking a Harness.
- Commands that start Turns (`init`, `start`, `resume`) use the existing `LARP_TURN` guard. They block until that invocation ends and need no terminal input.
- `init` prints only the absolute chunk-file path on stdout. Startup, progress, and the draft ID go to stderr. `start` and `resume` print a compact final summary with ID, counts, output path, and a resume command when needed. Chunk bodies are written to files, not interleaved on the terminal. Raw Harness output stays in Turn artifacts.
- Exit 0 means chunking succeeded or every chunk completed and its result was written. Exit 1 means validation, a Turn, interruption, locking, or persistence failed. Finding style issues is a successful review, not a command failure.

The Role passed to `init` is advisory context. `start --role` is authoritative and can select another Role. The caller-owned chunk file contains no Role or machine-specific working directory.

## Live terminal display

Use a fixed header and one live block on stderr. Update the progress line and chunk rows in place, without appending start/completion lines in an interactive terminal:

```text
[larp] swarm abc123 · style-reviewer · 8 chunks · parallel 3
[larp] Repository: /work/my-project
[larp] Results: /home/me/.larp/swarms/abc123/results/
[progress] 2m elapsed · 3 running · 2 waiting · 3 complete · 0 failed

• [harness] Running (2m 10s)
• [config] Complete (53s)
• [storage] Queued
```

The rows above illustrate the format; the real display lists all chunks when they fit. Keep rows in manifest order so IDs do not jump as their status changes. States are Queued, Running, Complete, Failed, and Interrupted. Running durations update once per second, with immediate redraws on state changes. Completed/failed durations stop at the end of that attempt. The aggregate elapsed timer measures the current command invocation; on resume, already completed chunks retain their saved duration. A chunk is shown Complete only after its committed reply has been exported successfully; export errors are reported separately and do not cause another model call.

Use [`log-update`](https://github.com/sindresorhus/log-update) to redraw the multiline block through `createLogUpdate(process.stderr)`. It provides multiline replacement, stderr support, and final-frame persistence. Keep Clack for existing prompts; its [spinner/task-log APIs](https://bomb.sh/docs/clack/packages/prompts/) serve loading indicators and grouped logs, while this display needs replacement of a complete status frame. Use `string-width` to account for wrapped header lines, including wide characters, when reserving space for the live block. Neither library schedules tasks.

Enable redraw only when stderr is a terminal and `TERM` is not `dumb`. Render a frame from status data in `src/swarm/output.ts`; one renderer owns all writes during the live display. Do not print Harness events or use an independent spinner for each chunk. Sanitize terminal control characters in displayed paths and errors, respect `NO_COLOR`, and keep explicit status text so color is optional.

On terminal resize, redraw within the available width and height. Truncate long single-line labels and error summaries. If all chunks do not fit, prioritize running and failed chunks, keep manifest order within the displayed selection, and show an omitted-row count; the aggregate counts always cover the full swarm. Very small terminals may use only the aggregate line. Do not add scrolling or keyboard interaction in v1.

On completion, failure, or interruption, stop the timer, remove resize listeners, restore the cursor, and leave one final frame before printing the command summary. Cleanup belongs in `finally`. The renderer must not swallow signals or delay Harness shutdown.

When stderr is redirected or unsuitable for redraw, fall back to plain start/done/failure lines plus a progress heartbeat after 30 seconds without a status change. Emit no cursor-control sequences. Keep stdout reserved for the command result in both modes.

Record attempt duration with committed reply/failure entries for display on resume. Running times and queued counts remain derived runtime/display data, not a second persisted state machine. Initialize the display from the saved execution and log, then feed it Turn-start and committed-outcome notifications. During draft chunking, use the same lifecycle with one `splitter` row.

## Chunk format and scope

Keep the proposed public format:

```json
{
  "version": 1,
  "task": "Code style sweep of the whole repository",
  "chunks": [
    {
      "id": "harness",
      "paths": ["src/harness/"],
      "focus": "Review Harness adapters and process handling against repository style guidance."
    }
  ]
}
```

Provide a strict JSON Schema to the splitter and parse both model output and user-edited files through the same local parser. Reject unsupported versions, unknown fields, empty tasks/focus, empty chunk/path arrays, duplicate IDs, and invalid types. Errors name the field or chunk involved before execution begins.

IDs match `[a-z0-9][a-z0-9-]{0,63}` and are unique. Paths are literal relative file or directory paths using `/`, with `.` allowed for the whole working directory. Reject absolute paths, parent traversal segments, backslashes, glob syntax, and control characters. Treat trailing `/` as directory notation. Validation is syntactic: LARP does not enumerate repository files or run git. The Participant reports missing paths or incomplete access in its result.

`paths` defines the scope of findings, not a filesystem access boundary. A Participant may read related code and governing instructions outside its chunk for context. Findings belong to the assigned paths. Cross-boundary concerns should be tied to an in-scope location and identify the related dependency.

The default `swarm-planner` Role guidance and workflow protocol direct the splitter to:

1. Inspect repository structure and applicable instructions before dividing the task.
2. Use the task and supplied Role guidance to estimate work. Packages are a starting point, not a required boundary.
3. Split large areas, group small related areas, and aim for one useful review per chunk.
4. Cover relevant root configuration, shared code, scripts, and tests. Exclude generated/vendor/build content unless the task requires it.
5. Prefer non-overlapping reporting scopes. Use explicit file groups where nesting would create duplicate coverage.
6. Make each focus instruction self-contained. Do not perform the complete review while splitting, create dependent chunks, or start other LARP commands.
7. Return the required JSON only. LARP preserves the Caller's task text as the authoritative `task` when saving the generated file.

Overlap and complete coverage remain review judgments in v1. Do not add repository indexing or a coverage engine.

## Saved state and authority

Use the existing artifact helpers with a new `SwarmStore`:

```text
~/.larp/swarms/<id>/
  swarm.json       immutable identity and inputs; kind: draft | execution
  messages.jsonl   append-only outcomes; progress is derived from this log
  chunks.json      editable splitter output, for a draft only
  results/        generated <chunk-id>.md files, unless --out is supplied
  turns/          raw Harness streams, final output, schemas, process records
```

Each `init` creates a draft ID. Each `start` creates a separate execution ID. This allows repeat reviews from the same file without special rules for files under LARP's storage directory.

- Draft metadata saves the task, absolute working directory, resolved planner Participant, and optional Role context. A valid split reply and its session ID are appended to the draft log before materializing `chunks.json`.
- Execution metadata saves a parsed copy of the complete chunk document, the resolved chunk Participant and Role name, absolute working directory, selected parallel limit, and output location. The source chunk file and Role files are not read again on resume.
- Resolve the default result path from the artifact directory; store an absolute custom path only when provided. Avoid a second metadata write merely to discover the new ID.
- Store reply bodies and completion session IDs in the log. Each failure entry identifies the splitter or chunk and its error. Link entries to their Turn directory for diagnosis. Do not persist a second mutable status table.
- Use a single process lock and one log per draft or execution. Reuse `tryAcquireTurns` to refuse concurrent invocations and surviving Harness processes after a crash.
- Chunk execution completion is authoritative only after a valid reply is appended. Markdown is a generated view of that reply. Append first, then write the result atomically. If export fails or the process crashes between these steps, resume rebuilds the output without calling the model again.
- Resume reconciles completed chunk results from the log before scheduling remaining work. Result files are generated artifacts; manual edits can be replaced. Refuse unexpected file types or symlink targets rather than writing through them.
- The draft file is intentionally editable. Once present, resume must not replace it with the original model reply. If it is absent but a valid split reply exists, recreate it without another Turn. Edits are validated at `start`.
- Repository content is not snapshotted. Resume reads the current files in the saved working directory. State this in help; do not add git state or worktree management.

## Execution and recovery

Implement swarm policy on `drive()` and `Workflow`, using one Turn key per chunk. Do not launch `larp agent start` subprocesses or create an `AgentStore` per chunk. Swarm Participants belong to the swarm log and do not appear in `larp agent list`.

The splitter runs one Turn with the strict chunk schema. Each chunk runs an independent Turn with its Role instructions, the overall task, chunk ID, paths, focus, read-only rule, and Markdown reply requirement. It does not receive other chunks' findings. The workflow owns the output contract: as with other workflows, a Role's optional standalone-Agent `schema` does not override it. Worker replies are nonempty text; an explicit statement that no issues were found is valid.

`next(entries, { resumedAt })` returns unfinished chunks in manifest order. A chunk is eligible when it has no successful reply and has not failed during the current invocation. `drive({ parallel })` fills available slots and prevents concurrent Turns for the same key. This gives one attempt per unfinished chunk per invocation and no automatic retry loop.

On a normal Harness error or invalid/empty reply, append a chunk failure and continue the other chunks. Do not throw from `commit` for these failures. After all eligible chunks settle, return counts and failed IDs; the CLI exits 1 when any remain unfinished.

On resume, retry failed and uncommitted chunks once each. Start a fresh Harness session for each retry: the request is self-contained and v1 has no chunk conversation to preserve. Never rerun a chunk with a committed successful reply, including after an export failure. A fully completed resume repairs outputs if needed and returns the same summary with no model calls.

Persistence failures and interruption stop scheduling through the existing kernel error path. Allow in-flight Turns to settle before releasing the lock. Existing signal forwarding reaches the running Harness processes. An interrupted Turn commits no reply. Keep orphan-process checks and test interruption with several real fake-child processes, not only an in-memory Harness.

Force `permission: "read-only"` on every Turn even if a selected Role says `write`. Retain Role web settings and the existing trusted extra-argument behavior used by plan/discuss. Document the same limitation: user-supplied Harness arguments must not bypass permissions or session recording. This feature does not introduce a stronger security sandbox than the existing workflows.

## Module and API sketch

```ts
interface Chunk {
  id: string;
  paths: string[];
  focus: string;
}

interface ChunkDocument {
  version: 1;
  task: string;
  chunks: Chunk[];
}

// Throws a field-specific error; used for model replies and edited files.
parseChunkDocument(value: unknown): ChunkDocument;

// Persist immutable inputs; execution creation reserves its output directory.
SwarmStore.createDraft(input: DraftInput): SwarmStore;
SwarmStore.createExecution(input: ExecutionInput): SwarmStore;
SwarmStore.open(id: string): SwarmStore;

// Dispatches draft/execution policy over the same driver and persistence interface.
runSwarm(store: SwarmStore, harnesses: Harnesses, ui?: SwarmUI): Promise<SwarmOutcome>;
```

Use a discriminated metadata union so draft-only planner data and execution-only chunk data cannot be mixed. `SwarmOutcome` distinguishes a ready draft from an execution summary; infrastructure failures remain errors with a resume instruction. The CLI owns argument parsing and stdout/stderr presentation. The swarm module owns prompts, validation, scheduling policy, and output recovery.

| File | Responsibility |
| --- | --- |
| `src/swarm/chunks.ts` | Chunk types, strict model schema, shared parser. |
| `src/swarm/store.ts` | Draft/execution identity, entries, locking, output ownership and artifact materialization. Reuse `src/store.ts` primitives. |
| `src/swarm/prompt.ts` | Splitter system guidance, Role context, and self-contained chunk envelopes. |
| `src/swarm/run.ts` | Driver integration, pure scheduling decisions, commits, recovery, and outcomes. Keep these together until size warrants a separate workflow file. |
| `src/roles.ts`, `src/tui.ts` | Dedicated `swarm-planner` Role defaults and setup for fresh/existing installations, independent of plan Participants. |
| `src/swarm/output.ts` | Pure frame formatting, live stderr redraw, plain-output fallback, elapsed timers, resize handling, and cleanup. |
| `src/cli.ts` | Swarm command dispatch, valid flag combinations, Role resolution, limits, nesting guard, output and exit status. |
| `package.json` and lockfile | Add `log-update` for the multiline status display and `string-width` for header sizing. |
| Adjacent tests and `src/cli.test.ts` | Contract tests using temporary storage and fake Harnesses. |
| `src/harness/adapters.test.ts` | Verify several spawned children receive interruption and release signal listeners/process records. Change runtime code only if this exposes a defect. |
| `README.md`, `CONTEXT.md`, new ADR | Commands, storage, Swarm/Chunk vocabulary, concurrent Turn definitions, and design decisions. |

No scheduler or Harness API change is expected. Keep refactoring of existing commands out of scope.

## Ordered implementation

1. **Chunk contract.** Add schema and parser tests, including round-trip preservation of a valid user-edited file and useful failures for invalid scope/IDs.
2. **Persistence.** Add the store, immutable draft/execution metadata, output-directory reservation, log entries, and recovery/materialization tests. Use the existing single-writer append helpers under the swarm lock.
3. **Chunking.** Add splitter prompt composition and the draft workflow. Prove the intended Role reaches the splitter as context and that the workflow schema governs its reply. Save editable output and handle failed/interrupted init via resume.
4. **Parallel execution.** Add chunk prompts and scheduling on the kernel. Prove bounded concurrency, failure isolation, one attempt per invocation, read-only requests, and resume without repeating completed work.
5. **CLI and terminal display.** Wire all commands and flags, Role snapshots, file loading, the live chunk list, plain-output fallback, nesting guard, and exit codes. Add `log-update`, persist attempt durations, and keep display timing separate from workflow state. Exercise init, edit, start, failure, and resume through the real CLI with fake Harness executables.
6. **Documentation and checks.** Document the chosen contracts and add a Swarm ADR. Update ADR 0007's statement that no shipped command uses parallel Turns. Amend ADR 0002 narrowly: explicit `--out` may export generated reports inside a repository; LARP still owns no source or git state. Explain syntactic chunk validation without repository discovery. Update the historical design note to point to the new ADR.

## Acceptance checks

- `init --role style-reviewer` supplies that Role's guidance to the configured `swarm-planner`, requests structured chunks, and returns an editable file path. Missing splitter configuration points the user to `larp config`, without falling back to the plan's planner.
- The original requested task remains authoritative in generated JSON; a user can subsequently edit the task as well as the chunks before `start`.
- `start` accepts generated and hand-written files, rejects malformed input before a Harness launch, and uses the command's working directory for all chunk requests.
- Editing the chunk file or Role files after startup does not change an execution or its resume.
- With more chunks than slots, at most `parallel` Turns run at once; a free slot starts another chunk without waiting for the whole batch. Each completed chunk gets exactly one result file, regardless of completion order.
- One failed chunk does not suppress the remaining chunks. Resume retries only failed/uncommitted chunks and reports whether all now succeeded.
- Both Harness request types receive read-only permissions, even from a Role with write permission. Role schema settings cannot change the workflow's chunk or Markdown contracts.
- A committed reply whose export failed is materialized on resume without another model call. A draft's existing user edits survive resume.
- A second process cannot run the same swarm, reuse a custom output directory, or bypass the existing live-Harness process guard. Symlink output targets are refused.
- Interrupting several running fake Harness children forwards the signal, stops new scheduling, preserves committed results, and leaves remaining work resumable.
- Empty replies fail their chunk; a nonempty report with no findings succeeds. Final summaries and exit codes distinguish command failure from review findings.
- Draft IDs cannot accidentally execute chunks on resume. `list` and `show` never launch models. All Turn-starting swarm commands refuse nested invocation under `LARP_TURN`.
- Terminal frames preserve chunk order, update durations and aggregate counts, and show failures without stopping other rows. Use a controlled clock and captured renderer writes to test state changes, frozen completion durations, resume, truncation, and omitted-row counts.
- Redirected stderr uses plain lines and the 30-second idle heartbeat, with no cursor-control escapes. Display timers/listeners are cleaned up on success, failure, and interruption. Manually verify inline redraw and resizing in a real terminal with fake Harnesses, including more chunks than fit on screen.

Verification commands:

```sh
node --test --import tsx src/swarm/*.test.ts src/cli.test.ts src/harness/adapters.test.ts
npm test
npm run typecheck
npm run build
npm run format:check
```

Tests use fake Harnesses and temporary directories; they do not make paid model calls. If a check is expected to take minutes, run it through the repository's run-and-queue workflow. A live style sweep on a small repository is an optional manual check after automated verification.

## Scope and review decisions

V1 excludes source edits, worktrees, dependency graphs, per-chunk Roles, model-generated summaries, deduplication, follow-up messaging, selective reruns, repository snapshots, and automatic retry/backoff. The Caller can edit a copy of the chunk file and start a new execution for a different scope.

The defaults are: separate draft/execution IDs, splitting through the dedicated `swarm-planner` Role, optional Role context at init, required Role at start, parallelism 3 with a maximum of 8, a new output directory per execution, one attempt per chunk per invocation, and fresh sessions on retries. Keep them consistent across help, tests, and the new ADR.
