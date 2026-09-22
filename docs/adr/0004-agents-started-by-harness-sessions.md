---
status: accepted
---

# Harness sessions start Agents through the CLI

A Claude Code or Codex session can start a standalone Agent with `larp agent start --role <name> --message <text>` and continue it with `larp agent message <id> --message <text>`. The Caller names a Role; it does not need to know which Harness or model the Role uses.

ADR 0001 rejected a `larp send` command called by a Participant during its Turn, because a read-only sandbox cannot write the Run log. That reason does not apply here. The Caller is not a larp Participant, and it runs with its normal permissions. The earlier `claude-plan` Codex skill used the same shape (a Codex managed process that starts `claude -p` and resumes it by session ID) without problems.

## Decisions

- **Role files.** A Role is a Markdown file in `~/.config/larp/roles/<name>.md`. Frontmatter holds `description`, `harness`, `model`, `effort`, `permission`, an optional `schema` path, and per-harness args. The body holds the Role's instructions. The plan Workflow uses `planner.md` and `reviewer.md`, and always runs them read-only with its own schemas. Only `larp config` writes these files, and it migrates the older `defaults` and `roles` entries in `config.json`.
- **Blocking command.** `larp agent start` and `larp agent message` block until the reply is ready and print it on stdout. The Caller's harness decides whether to run them in the background. larp has no daemon.
- **Queue, not steer.** When a Turn is running, `larp agent message` appends the Message and exits. The process that holds the Agent lock delivers it in a new Turn after the current Turn ends, and prints that reply as well. After it releases the lock, the holder checks the log again, so a Message queued at the last moment is not lost. Delivering a Message into a running Turn needs live-session adapters, which stay out of scope. The command name does not change if steering is added later.
- **Separate storage.** Agents live in `~/.larp/agents/<id>/`, apart from Runs, because they have no Phases or Gates. `larp plan resume` never sees an Agent. Log, lock, and atomic-write code is shared.
- **No project Role files.** Roles are read only from the user's config directory. A cloned repository could otherwise set `permission: write` or add harness arguments.
- **Recursion guard.** Every harness process that larp starts gets `LARP_TURN=1`. `larp plan`, `larp plan resume`, `larp agent start`, and `larp agent message` refuse to run when it is set. This relies on the Harness shell passing the variable on. Claude Code does, and Codex does with its default `shell_environment_policy`; a policy of `inherit = "none"` would disable the guard.

## Consequences

- A failed Turn leaves its Message undelivered. The next `larp agent message` carries it again, so no retry command is needed.
- Agent stdout carries only replies and a short footer with the Agent ID. Harness progress stays in `turns/NN/`.
- The plan commands move under `larp plan` (`resume`, `list`, `show`) so the two namespaces do not collide.
