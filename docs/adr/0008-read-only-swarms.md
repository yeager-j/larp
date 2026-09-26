---
status: accepted
---

# Swarms split, review, and execute independent chunks

`larp swarm init` uses the dedicated `swarm-planner` Role to produce an editable, versioned chunk document. `larp config` creates this built-in Role when missing, including on existing installations. Its instructions own the chunking guidance; the workflow owns the structured-output protocol and uses the selected Role’s file permissions. An optional Role supplies the intended execution criteria as context. The Caller reviews that file, then `start --chunks <path> --role <name>` starts execution in the same swarm directory. Copied and hand-written documents create new swarms. There is no interactive Gate or implicit execution after splitting.

## Decisions

- A generated `~/.larp/swarms/<id>/chunks.json` keeps its draft identity at `start`, so results stay beside the input. Under the swarm lock, start reserves output and atomically replaces draft metadata with execution metadata, preserving the log and Turn directories. A stale draft handle must reopen before running. Repeated starts are refused with a resume instruction; a copy outside the swarm directory can start a new swarm. Each `start` snapshots the reviewed document, working directory, resolved Role settings, output location, and concurrency limit. Resume does not reload Role or input files.
- Built-in setup Roles are independent of the plan workflow's Participant list. Adding `swarm-planner` does not add another Participant to plan runs. Existing drafts retain their saved Participant when resumed.
- One log per identity owns all outcomes. The existing relay kernel runs at most one Turn per Chunk and defaults to three simultaneous Turns, with a v1 limit of eight. No standalone Agent records or second scheduler are involved.
- Turns use their snapshotted Role permission through the existing Harness profiles. The planner uses `swarm-planner`; workers use the Role selected at start. Missing permission in older saved Participants defaults to read-only. Resume does not reload Role files or grant new permissions. This supersedes the initial read-only override, allowing write-enabled Roles to maintain temporary rubrics and findings. A workflow's JSON/Markdown output contract overrides standalone-Agent Role schemas. Custom Harness arguments retain the existing trusted-input limitation; they must not bypass permission or session settings.
- Paths define reporting scope and may refer to files or directories. They are literal relative paths, not globs. LARP checks syntax; Participants inspect the repository and may read outside their reporting scope for context.
- Each unfinished Chunk gets one attempt per invocation. Ordinary failures are logged without stopping other Chunks. Resume skips successful replies and retries unfinished Chunks in fresh Harness sessions. Repository files are not snapshotted.
- Replies commit to the log before exporting Markdown. Export failure stops scheduling but does not erase the reply. Resume can rebuild its file without another model call. Existing editable draft files are preserved.
- Default reports stay inside the execution artifact. Explicit `--out` reserves a new directory with an ownership marker and may export inside a repository. Existing directories, symlink outputs, and foreign ownership are refused. This is a narrow exception to ADR 0002, not ownership of source or git state.
- One stderr renderer owns the live progress line and Chunk rows, updated in place with `log-update`. The renderer receives workflow notifications and does not decide execution state. Redirected output uses ordinary lines and a 30-second idle heartbeat. Final summaries go to stdout; raw Harness streams stay in Turn artifacts.
- `LARP_TURN` prevents init/start/resume from being nested inside another LARP Turn. Existing process locks and surviving-Harness checks apply to the whole Swarm.

## Deferred

Coordination of concurrent file edits, worktrees, dependent Chunks, per-Chunk Roles, synthesis, deduplication, selective reruns, follow-up messages, repository snapshots, and automatic retry/backoff are outside v1. A copy of a revised document outside its swarm directory can start a new execution.
