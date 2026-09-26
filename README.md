# LARP: LLM Agent Relay Protocol

> LARP as a software engineer!

A local relay between Claude Code and Codex. A Planner writes a plan, a Reviewer checks it, and a Human approves it. larp then opens the approved plan in a new Codex desktop composer and exits. Press Send in Codex to start implementation.

A Claude Code or Codex session can also start a standalone Agent from a named Role, such as `larp agent start --role reviewer --message "Review my plan"`, without knowing which harness or model the Role uses. `larp discuss` lets two models discuss a question until they agree.

`larp swarm` splits a repository task into editable chunks, then runs a read-only Participant for each chunk in parallel and saves Markdown reports.

Requires Node.js 24 or later and authenticated `claude` and/or `codex` executables on PATH. Desktop handoff currently requires macOS with the Codex desktop app installed.

```sh
npm install
npm run build
npm link
larp config
larp plan "Describe the change you want"
```

`larp config` reads the local Codex model cache, shows its fetch time, and lets you select a model for each Role. Claude includes built-in choices and custom names. The command writes `~/.config/larp/config.json` and the Role files in `~/.config/larp/roles/`. Setup creates any missing built-in Role files: `planner.md`, `reviewer.md`, and `swarm-planner.md`. It also moves legacy Planner/Reviewer model, effort, and arguments from an older `config.json` into their Role files. Running setup again adds newly introduced Roles while preserving your existing Role instructions and settings when you select a model.

## Roles

A Role is a Markdown file in `~/.config/larp/roles/<name>.md`. The file name is the Role name. The frontmatter has one `key: value` pair per line, and the body holds the Role's instructions:

```md
---
description: Critiques plans and changes for correctness risks
harness: codex
model: gpt-5.6-sol
effort: high
permission: read-only
web: true
claude-args: []
codex-args: []
---
You are a reviewer. Read what you are pointed to, inspect repository evidence, and report material problems first with file references.
```

`description`, `harness`, and `model` are required. `effort` defaults to `high` and `permission` to `read-only`; `write` lets an Agent edit the working tree. `web` defaults to `true` and lets the model search and fetch the web (Claude `WebSearch` and `WebFetch`, Codex live `web_search`); set it to `false` for a Role that should use only local files and its own knowledge. The args are JSON arrays passed to the matching harness. `schema` is an optional JSON Schema path, relative to the roles directory, that an Agent's reply must match. You can create Role files by hand; `larp config` offers a model picker for each one. Roles are read only from this directory, never from a repository.

The plan Workflow uses `planner` and `reviewer`. It adds its own protocol and reply schema before the Role's instructions and always runs both Roles read-only.

## Planning

```sh
larp plan "Add a feature" --pick
larp plan "Add a feature" --planner codex:gpt-5.6-sol --reviewer claude:claude-fable-5-1
larp plan list
larp plan show <run-id>
larp plan resume <run-id>
```

Use `--quiet` to hide harness progress while retaining Messages and Gates. During a Turn, type `@planner your message` (or another active Role) and press Enter. It is delivered on that Role's next Turn.

Output is grouped by Turn, with short tool summaries and a single formatted Message for each reply. Colors are disabled when output is redirected or `NO_COLOR` is set. Raw tool arguments, structured-output events, and session IDs are hidden by default. Add `"verbose": true` at the top level of `~/.config/larp/config.json` to show these diagnostic details for new and resumed Runs. `--quiet` still hides all harness progress, including session events.

New Runs allow up to five review rounds before the Phase Gate. The Phase Gate offers approval and desktop handoff, a message to the Planner, or abort. A Planner question before any plan exists offers a message or abort. The Failure Gate offers retry, retry with a note, or abort. Gates require a terminal; a non-interactive launch stops there with the Run saved for `larp plan resume`.

Planner and Reviewer use the design's read-only permission profiles. Implementation uses the Codex desktop task's model and permission settings, with normal support for long-running commands and `run-and-queue`. There is no Implementer model setting or `--implementer` flag; old config entries for it are ignored. Read-only Codex Turns pass `--skip-git-repo-check`, so larp also works outside a git repository. The Relay itself writes only configuration and Run artifacts, never repository files or git state.

Runs live in `~/.larp/runs/<run-id>/`: metadata, append-only messages, `plan.md`, `handoff.md` after approval, and raw output for each Turn. Resume uses the original working directory and saved Participants. It restores the plan from the approved snapshot, or the latest Planner request before approval. You can edit the plan at a Gate before approving it in the same process. Interrupting a Turn leaves it pending for resume.

Completed replies record acknowledged Message IDs and the harness session ID in the log, and the Relay reads both from the log alone; `run.json` holds only the Run's identity, task, Participants, and review limit. An incomplete trailing log line is discarded before the next append. A per-Run process lock prevents concurrent Relays.

Each running Turn records its harness process ID in its `turns/NN/` directory. If larp is killed or crashes during a Turn, the harness process can keep running. Until it exits, `larp plan resume`, `larp agent message`, `larp discuss resume`, and `larp swarm resume` refuse to start another Turn and name the process.

Model replies never choose their recipient. Planner replies use `plan: null` for feedback or questions and a nonempty string for requests; this keeps the schema compatible with strict structured output. Implementation questions are handled in the separate Codex task.

Approval saves the full plan text, including Human edits. A separate `handoff.md` snapshot contains it along with the original task and planning context. The desktop composer contains only a short instruction to read this file at its absolute path. This is a local file reference, not an uploaded attachment. Changes to `plan.md` after approval do not change the handoff; retries regenerate it from the saved approved snapshot. If opening Codex fails, use `larp plan resume <run-id>` to retry the handoff. A successful handoff ends the Run as `handed-off`; this does not mean implementation has finished. The deep-link format is based on the installed app and is not a documented stable API.

## Agents

```sh
larp agent roles
larp agent start --role reviewer --message "Review the plan in docs/plan.md"
larp agent message <agent-id> --message "Also check the migration"
larp agent list
larp agent show <agent-id>
```

`larp agent start` creates an Agent from a Role in the current directory and runs one Turn. It blocks until the Turn ends, then prints the reply and a footer with the Agent ID. Harness progress is not printed; it is saved in `~/.larp/agents/<agent-id>/turns/`. The start line with the Agent ID goes to stderr. Run the command as a background task from Claude Code or Codex so that the calling session is told when it exits.

`larp agent message` continues the same harness session. If the Agent is idle, it runs a Turn and prints the reply. If a Turn is running, it queues the message and exits at once; the running larp process delivers it in the next Turn and prints that reply too. When one process prints several replies, a `[larp] Reply to:` line before each one quotes the message it answers. Messages cannot be added to a Turn that is already running. When a Turn fails, its message stays queued and the next `larp agent message` sends it again.

Every harness process that larp starts gets `LARP_TURN=1`. Commands that start Turns, including swarm init/start/resume, refuse to run when it is set, so an Agent or Participant cannot start more Agents. This depends on the harness shell passing the variable on; a Codex `shell_environment_policy` with `inherit = "none"` disables the guard.

To teach a coding agent to use this, add something like the following to `CLAUDE.md` or `AGENTS.md`:

```md
Run `larp agent roles` to see the available larp Roles. To ask one for help, run
`larp agent start --role <name> --message "<request>"` as a background command and read
its output when it finishes. Continue with `larp agent message <id> --message "<text>"`.
To have two models agree on an answer, run
`larp discuss --author <role> --critic <role> --message "<question>"` in the background.
Exit 2 means they did not agree; the output lists the open objections.
```

## Discussions

```sh
larp discuss --author codex:gpt-5.6-sol --critic claude:claude-opus-5-5 --message "Evaluate this idea"
larp discuss --author planner --critic reviewer --message "..." --blind --max-rounds 3
larp discuss resume <discussion-id>
larp discuss continue <discussion-id> --message "..."
larp discuss list
larp discuss show <discussion-id>
```

A Discussion has two sides. The Author owns the proposal, and every Author reply contains the full proposal. The Critic replies to each proposal with a verdict, `agree` or `revise`, and always names the strongest objection it can make, even when it agrees. larp numbers each proposal and records which version each verdict answers, so an agreement always applies to one exact proposal. A round is one proposal and one verdict.

`--author` and `--critic` each take `harness:model` (effort `high`, web access on, no extra args) or a Role name, whose instructions are added after the Discussion protocol. The same model may take both sides. `--max-rounds` defaults to 5 and accepts 1 to 10. With `--blind`, the Critic writes its own answer to the task before it sees the first proposal. The Author then sees that answer with the Critic's first verdict.

The command blocks and prints the final proposal on stdout, then a footer:

- Exit 0: the Critic agreed. The footer gives the Critic's remaining objection.
- Exit 2: the round cap was reached. The footer gives the Critic's open objections to the last proposal.
- Exit 1: a Turn failed or was interrupted. stderr gives the cause and the `larp discuss resume` command. An invalid reply is retried once with a note before the Discussion stops.

stderr shows a live transcript: a start line with the Discussion ID, then each Turn's tool calls and progress, followed by what the Turn committed (the Author's note on each proposal, or the Critic's verdict, strongest objection, and requested changes). stdout gets only the final result. The raw harness output is also saved in `~/.larp/discussions/<id>/turns/`. `resume` continues from the log; on a finished Discussion it prints the same result without starting a Turn.

`continue` reopens a finished Discussion with a follow-up, such as a new direction or a question. The Author gets the follow-up and the Critic's last verdict, and writes the next proposal version; the Critic then judges it against the task and the follow-up. Both sides keep their sessions, so each keeps its context. The round cap starts again after each follow-up, and the command prints and exits as above. A Discussion that has not finished must be resumed first. There are no Gates, so a coding agent can run the command in the background.

Every Turn is read-only, whatever the Role's `permission` says. Role `claude-args` and `codex-args` still pass through unchanged, as in `larp plan` and `larp agent`. Args that bypass the sandbox or stop session persistence (such as Codex `--ephemeral`) break that guarantee or `resume`.

## Swarms

```sh
larp swarm init --message "Code style sweep of the whole repository" --role style-reviewer
# Review and edit the printed chunks.json file.
larp swarm start --chunks <path>/chunks.json --role style-reviewer --parallel 3
larp swarm resume <swarm-id>
larp swarm list
larp swarm show <swarm-id>
```

Create the named execution Role in `~/.config/larp/roles/` first; `style-reviewer` is an example, not a built-in Role. `init` uses the dedicated `swarm-planner` Role for its model, effort, Harness settings, and chunking guidance. Run `larp config` to create it on an existing installation, then edit `~/.config/larp/roles/swarm-planner.md` to customize its instructions. The workflow enforces read-only access and the chunk JSON format. The optional `--role` gives the splitter the intended execution criteria as context; it does not select the splitter. Its only stdout output is an absolute path to the editable chunk file:

```json
{
  "version": 1,
  "task": "Code style sweep of the whole repository",
  "chunks": [
    { "id": "harness", "paths": ["src/harness/"], "focus": "Review adapter and process code against repository style guidance." }
  ]
}
```

`start` also accepts a hand-written file. Run it from the directory the paths describe, usually the same directory as `init`. Paths are literal relative file/directory names, not globs; `.` means the whole directory. IDs use lowercase letters, digits, and hyphens and must be unique. Invalid input fails before a Harness starts. Paths define where findings belong; Participants may read related files for context. LARP validates path syntax but does not inspect repository contents or guarantee complete coverage.

Each `init` creates a draft in `~/.larp/swarms/<id>/`. Starting its generated `chunks.json` keeps that ID and directory, saving fixed copies of the reviewed chunks, Role settings, working directory, and concurrency limit. The default output is `~/.larp/swarms/<id>/results/<chunk-id>.md`, beside `chunks.json`. After starting, use `resume <id>` to continue; another `start` on that file is refused. To run a fresh review, copy the chunk file outside its swarm directory. Copied and hand-written files create new swarm IDs. Supply `--out <new-directory>` to export elsewhere, including within the repository. That directory must not already exist. It contains an ownership marker and generated reports; resume can replace edits to those reports. Before `start`, resuming a draft preserves an existing editable chunk file and never executes its chunks.

`--parallel` defaults to 3 and accepts 1 through 8 simultaneous direct Harness processes. In an interactive terminal, stderr shows a header, a progress count, and a row per chunk, updated in place:

```text
[larp] swarm abc123 · style-reviewer · 3 chunks · parallel 3
[larp] Repository: /work/my-project
[larp] Results: /home/me/.larp/swarms/abc123/results/
[progress] 2m 10s elapsed · 1 running · 1 waiting · 1 complete · 0 failed

⠋ [harness] Running (2m 10s)
✓ [config] Complete (53s)
○ [storage] Queued
```

Agent IDs receive randomly assigned colors that stay fixed during the command. The palette cycles after six agents. Running rows show cyan spinners; successful rows show green checkmarks, failures show red crosses, queued rows show gray circles, and interrupted rows show yellow exclamation marks. Set `NO_COLOR` to disable colors while keeping symbols and animation. Spinners update every 80 milliseconds; elapsed times show whole seconds. Completed durations are frozen. Small terminals prioritize running/failed chunks and show an omitted-row count. Redirected stderr receives plain start/done/failure lines and a heartbeat after 30 seconds without a status change. stdout receives the final summary; reports and raw Harness output are saved to files. No terminal input is required, so a calling coding agent can run the command in the background.

A failed chunk does not stop other chunks. `resume` retries only unfinished chunks, once per invocation, in fresh Harness sessions. Committed replies are not regenerated: if writing a report failed, resume recreates it from the log. An interrupt stops new scheduling and preserves completed results. Resume uses the saved directory but reads its current files; repository content is not snapshotted. `list` shows committed progress, and `show` includes saved inputs, outcomes, errors, and artifact paths.

Exit 0 means a draft is ready, or all chunk replies were saved and exported. Exit 1 means validation, a chunk, an interrupt, or an infrastructure operation failed. Reports containing findings still count as successful results. Every Turn uses the existing read-only permission profile even when the Role specifies `write`. Workflow output contracts override a Role's standalone-Agent schema: chunking returns JSON and execution returns Markdown. As with plan/discuss, trusted custom Harness args must not bypass permissions or session recording. There is no automatic report synthesis or source editing.

## Development

```sh
npm test
npm run typecheck
npm run build
npm run format
npm run format:check
```

Prettier settings, import sorting, and the pre-commit hook follow `pdx-sdk`. No ESLint is configured. Tests use fixtures, temporary directories, and fake harnesses; they do not call models. Swarm rendering uses `log-update`; scheduling remains in the shared relay kernel.

Live smoke tests can be run independently:

```sh
LARP_LIVE_SMOKE=1 npm run smoke:plan:claude
LARP_LIVE_SMOKE=1 npm run smoke:plan:codex
LARP_LIVE_SMOKE=1 npm run smoke:agent
LARP_LIVE_SMOKE=1 npm run smoke:swarm
```

The planning tests use Haiku as Planner and either Haiku or Codex as Reviewer. They require existing LARP configuration, Harness authentication, Codex desktop, and a terminal for approval Gates. Each opens a desktop composer without submitting the implementation prompt. Set `LARP_CODEX_MODEL` to override the planning test's Codex Reviewer model. While a Reviewer runs, try an `@planner` message. For recovery testing, interrupt a Turn and use the printed Run ID with `larp plan resume`.

The Agent test starts and continues the configured `reviewer` Role to check free-text replies and session continuity; it needs no desktop handoff. `LARP_LIVE_SMOKE=1 npm run smoke` (or `scripts/smoke.sh`) remains a combined shortcut for the two planning tests followed by the Agent test. It does not run the swarm test.

For a live swarm smoke test that explains LARP's own source modules:

```sh
LARP_LIVE_SMOKE=1 npm run smoke:swarm
```

This uses real Codex agents with `gpt-6-luna` at `medium` effort for both the splitter and all chunk Participants. It requires an authenticated `codex` executable and model access. It uses fixed Participant settings through the swarm API, so it does not read or change your configured Roles. No desktop app or interactive input is required.

The test inventories non-test TypeScript modules under `src/`, asks the splitter for 3–6 chunks, then runs up to three chunks at once. It checks that every module is assigned exactly once, each report names all its assigned modules, and resuming the completed execution starts no further agents. These checks validate workflow and report coverage; the explanations themselves can be reviewed in the saved Markdown reports. Drafts, execution state, raw Harness output, and reports stay under `~/.larp/swarms/`; their paths are printed. The regular `npm test` command still makes no model calls.
