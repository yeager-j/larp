---
status: accepted
---

# Roles may use the web, and read-only Codex Turns skip the git check

## Web access

A Role file has a `web` setting, `true` by default. It flows into each Participant and each Turn request, and each adapter sets it explicitly on every Turn:

- **Claude, read-only:** `WebSearch` and `WebFetch` are added to `--tools` and `--allowedTools`.
- **Claude, write:** `--dangerously-skip-permissions` already allows every tool, so `web: false` adds `--disallowedTools WebSearch,WebFetch`.
- **Codex:** `-c web_search="live"` or `-c web_search="disabled"`. Codex 0.156 also accepts `cached` and `indexed`. If larp did not set a value, the user's Codex config would decide, and Claude and Codex could behave differently for the same Role.

It is on by default because most Roles, such as researchers, reviewers, and Discussion Participants, give better answers when they can check facts. The risk is prompt injection from fetched pages. A read-only Turn cannot act on it by editing files, but it can still be misled. A Role that should use only local files and its own knowledge sets `web: false`.

Runs, Agents, and Discussions created before this change saved Participants with no `web` field. They run without web access on resume, as they did before. A `harness:model` spec in `larp plan` or `larp discuss` uses the Role default, `true`.

## Git check

`codex exec` refuses to run outside a trusted directory or a git repository unless it gets `--skip-git-repo-check`. General questions, such as a `larp discuss` about a non-code topic, often run outside a repository. The check protects a folder from unexpected writes, and a read-only Turn cannot write, so read-only Codex Turns always pass the flag. Write Turns keep the check.
