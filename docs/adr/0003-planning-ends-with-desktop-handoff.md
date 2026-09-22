---
status: accepted
---

# Planning ends with a Codex desktop handoff

larp owns planning and review. Implementation runs in a normal Codex desktop task so it can use managed commands, `run-and-queue`, and Human follow-up without conflicting with larp's Turn lifecycle.

Only Planner and Reviewer are Participants. New Runs allow up to five review rounds before a Human Gate. The limit is saved per Run; Runs created before this change retain their three-round limit on replay.

Approval records the full current plan text in the log, including Human edits. The Relay opens `codex://threads/new?mode=codex&path=…&prompt=…` with the working directory and a short prompt pointing to an absolute `handoff.md` path. Before opening the link, the Relay atomically writes this separate Markdown snapshot with the original task, approved plan, and planning context. Large plans stay out of the URL and composer. The reference is a local file path, not an uploaded attachment. It then records a `handoff` entry and exits with phase `handed-off`. The user presses Send in the desktop composer. The desktop model setting controls implementation; there is no Implementer picker or flag in larp.

The link format was verified against the installed desktop app's route parser and handler. It is not a documented stable public API. The adapter is isolated in `src/handoff.ts` and currently uses macOS `open`. Successful dispatch does not prove that a task was created or implementation started.

If opening fails, the approved Run stays in `handoff`. `larp plan resume` retries with the saved approved snapshot and does not repeat planning. A recorded successful handoff is terminal. A crash after opening but before recording success can open the composer again on resume; the deep link never auto-submits work.

Old configuration files are accepted; obsolete Implementer settings are ignored. Completed legacy implementation Runs remain complete. Resuming an unfinished legacy Run after approval hands its plan to the desktop rather than starting another Implementer Turn.
