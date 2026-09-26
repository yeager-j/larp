---
status: accepted
---

# Read-only swarms split, review, and execute independent chunks

`larp swarm init` uses the planner Role with a splitting protocol to produce an editable, versioned chunk document. An optional Role supplies the intended execution criteria as context. The Caller reviews that file, then `start --chunks <path> --role <name>` creates a separate execution. Hand-written documents work too. There is no interactive Gate or implicit execution after splitting.

## Decisions

- Drafts and executions have distinct identities under `~/.larp/swarms/`. Each `start` snapshots the reviewed document, working directory, resolved Role settings, output location, and concurrency limit. Resume does not reload Role or input files.
- One log per identity owns all outcomes. The existing relay kernel runs at most one Turn per Chunk and defaults to three simultaneous Turns, with a v1 limit of eight. No standalone Agent records or second scheduler are involved.
- All Turns use the existing read-only permission profile. A workflow's JSON/Markdown output contract overrides standalone-Agent Role schemas. Custom Harness arguments retain the existing trusted-input limitation; they must not bypass permission or session settings.
- Paths define reporting scope and may refer to files or directories. They are literal relative paths, not globs. LARP checks syntax; Participants inspect the repository and may read outside their reporting scope for context.
- Each unfinished Chunk gets one attempt per invocation. Ordinary failures are logged without stopping other Chunks. Resume skips successful replies and retries unfinished Chunks in fresh Harness sessions. Repository files are not snapshotted.
- Replies commit to the log before exporting Markdown. Export failure stops scheduling but does not erase the reply. Resume can rebuild its file without another model call. Existing editable draft files are preserved.
- Default reports stay inside the execution artifact. Explicit `--out` reserves a new directory with an ownership marker and may export inside a repository. Existing directories, symlink outputs, and foreign ownership are refused. This is a narrow exception to ADR 0002, not ownership of source or git state.
- One stderr renderer owns the live progress line and Chunk rows, updated in place with `log-update`. The renderer receives workflow notifications and does not decide execution state. Redirected output uses ordinary lines and a 30-second idle heartbeat. Final summaries go to stdout; raw Harness streams stay in Turn artifacts.
- `LARP_TURN` prevents init/start/resume from being nested inside another LARP Turn. Existing process locks and surviving-Harness checks apply to the whole Swarm.

## Deferred

Source edits, worktrees, dependent Chunks, per-Chunk Roles, synthesis, deduplication, selective reruns, follow-up messages, repository snapshots, and automatic retry/backoff are outside v1. A revised document can start a new execution.
