# LARP: LLM Agent Relay Protocol

> LARP as a software engineer!

A local relay between Claude Code and Codex. A Planner writes a plan, a Reviewer checks it, and a Human approves it. larp then opens the approved plan in a new Codex desktop composer and exits. Press Send in Codex to start implementation.

A Claude Code or Codex session can also start a standalone Agent from a named Role, such as `larp agent start --role reviewer --message "Review my plan"`, without knowing which harness or model the Role uses.

Requires Node.js 24 or later and authenticated `claude` and/or `codex` executables on PATH. Desktop handoff currently requires macOS with the Codex desktop app installed.

```sh
npm install
npm run build
npm link
larp config
larp plan "Describe the change you want"
```

`larp config` reads the local Codex model cache, shows its fetch time, and lets you select a model for each Role. Claude includes built-in choices and custom names. The command writes `~/.config/larp/config.json` and the Role files in `~/.config/larp/roles/`. The first run creates `planner.md` and `reviewer.md`, and moves the model, effort, and arguments from an older `config.json` into them.

## Roles

A Role is a Markdown file in `~/.config/larp/roles/<name>.md`. The file name is the Role name. The frontmatter has one `key: value` pair per line, and the body holds the Role's instructions:

```md
---
description: Critiques plans and changes for correctness risks
harness: codex
model: gpt-5.6-sol
effort: high
permission: read-only
claude-args: []
codex-args: []
---
You are a reviewer. Read what you are pointed to, inspect repository evidence, and report material problems first with file references.
```

`description`, `harness`, and `model` are required. `effort` defaults to `high` and `permission` to `read-only`; `write` lets an Agent edit the working tree. The args are JSON arrays passed to the matching harness. `schema` is an optional JSON Schema path, relative to the roles directory, that an Agent's reply must match. You can create Role files by hand; `larp config` offers a model picker for each one. Roles are read only from this directory, never from a repository.

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

Planner and Reviewer use the design's read-only permission profiles. Implementation uses the Codex desktop task's model and permission settings, with normal support for long-running commands and `run-and-queue`. There is no Implementer model setting or `--implementer` flag; old config entries for it are ignored. The Relay itself writes only configuration and Run artifacts, never repository files or git state.

Runs live in `~/.larp/runs/<run-id>/`: metadata, append-only messages, `plan.md`, `handoff.md` after approval, and raw output for each Turn. Resume uses the original working directory and saved Participants. It restores the plan from the approved snapshot, or the latest Planner request before approval. You can edit the plan at a Gate before approving it in the same process. Interrupting a Turn leaves it pending for resume.

Completed replies also record acknowledged Message IDs and the harness session ID in the log. This repairs a stale `run.json` after a crash. An incomplete trailing log line is discarded before the next append. A per-Run process lock prevents concurrent Relays.

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

Every harness process that larp starts gets `LARP_TURN=1`. `larp plan`, `larp plan resume`, `larp agent start`, and `larp agent message` refuse to run when it is set, so an Agent or Participant cannot start more Agents. This depends on the harness shell passing the variable on; a Codex `shell_environment_policy` with `inherit = "none"` disables the guard.

To teach a coding agent to use this, add something like the following to `CLAUDE.md` or `AGENTS.md`:

```md
Run `larp agent roles` to see the available larp Roles. To ask one for help, run
`larp agent start --role <name> --message "<request>"` as a background command and read
its output when it finishes. Continue with `larp agent message <id> --message "<text>"`.
```

## Development

```sh
npm test
npm run typecheck
npm run build
npm run format
npm run format:check
```

Prettier settings, import sorting, and the pre-commit hook follow `pdx-sdk`. No ESLint is configured. Tests use fixtures, temporary directories, and fake harnesses; they do not call models.

For an opt-in live smoke test with Haiku and then Codex as Reviewer:

```sh
LARP_LIVE_SMOKE=1 scripts/smoke.sh
```

This requires an existing configuration, Codex desktop, and a terminal for both approval Gates. It ends by starting and continuing a `reviewer` Agent, which checks a free-text reply from that Role's harness. Each test opens a desktop composer; neither submits the implementation prompt. Set `LARP_CODEX_MODEL` to override the smoke test's Codex model. While a Reviewer runs, try an `@planner` message. For recovery testing, interrupt a Turn and use the printed Run ID with `larp plan resume`.
