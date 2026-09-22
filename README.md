# larp

A local relay between Claude Code and Codex. A Planner writes a plan, a Reviewer checks it, and a Human approves it before an Implementer starts work.

Requires Node.js 24 or later and authenticated `claude` and/or `codex` executables on PATH.

```sh
npm install
npm run build
npm link
larp config
larp plan "Describe the change you want"
```

`larp config` reads the local Codex model cache, shows its fetch time, and lets you select a default model for each Role. Claude includes built-in choices and custom names. Only this command writes `~/.config/larp/config.json`. Per-role effort and harness arguments can be edited in that file.

```sh
larp plan "Add a feature" --pick
larp plan "Add a feature" --planner codex:gpt-5.6-sol --reviewer claude:claude-fable-5-1 --implementer codex:gpt-5.6-sol
larp runs
larp show <run-id>
larp resume <run-id>
```

Use `--quiet` to hide harness progress while retaining Messages and Gates. During a Turn, type `@planner your message` (or another active Role) and press Enter. It is delivered on that Role's next Turn.

The Phase Gate offers approval, a message to the Planner, or abort. A Planner question before any plan exists offers a message or abort. The Failure Gate offers retry, retry with a note, or abort. Gates require a terminal; a non-interactive launch stops there with the Run saved for `larp resume`.

Planner and Reviewer use the design's read-only permission profiles. Implementer uses Claude's permission bypass or Codex's workspace-write sandbox. The Relay itself writes only configuration and Run artifacts, never repository files or git state.

Runs live in `~/.larp/runs/<run-id>/`: metadata, append-only messages, `plan.md`, and raw output for each Turn. Resume uses the original working directory and saved Participants. It restores the plan from the latest committed Planner request. You can edit the plan at a Gate before approving it in the same process. Interrupting a Turn leaves it pending for resume.

Completed replies also record acknowledged Message IDs and the harness session ID in the log. This repairs a stale `run.json` after a crash. An incomplete trailing log line is discarded before the next append. A per-Run process lock prevents concurrent Relays.

Model replies never choose their recipient. Planner replies use `plan: null` for feedback or questions and a nonempty string for requests; this keeps the schema compatible with strict structured output. Implementation questions remain in the implementation phase when the Human answers a Planner escalation.

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

This requires an existing configuration and a terminal for both approval Gates. Set `LARP_CODEX_MODEL` to override the smoke test's Codex model. While a Reviewer runs, try an `@planner` message. For recovery testing, interrupt a Turn and use the printed Run ID with `larp resume`.
