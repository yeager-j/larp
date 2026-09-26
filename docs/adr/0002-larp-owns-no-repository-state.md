---
status: accepted
---

# LARP owns no repository state

LARP never runs git, creates branches or worktrees, writes into the repository, or inspects the working tree. The Implementer Role does all of that inside its own harness, which already knows how. Run files live under `~/.larp/runs/` so `git status` stays clean. We chose this over "create a `larp/<run-id>` branch for safety" because every feature the Relay owns is a feature that can fail; the one that does not exist gives the least trouble.

ADR 0008 adds one explicit export exception: `larp swarm start --out <new-directory>` may write generated reports to a caller-selected directory, including inside the repository. LARP still owns no source or git state. It checks chunk path syntax and output ownership, but repository discovery stays with the read-only Participants.
