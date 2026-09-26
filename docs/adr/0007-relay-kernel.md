---
status: accepted
---

# One relay kernel runs every Workflow

`larp plan`, `larp discuss`, and `larp agent` each had their own loop: read the log, decide the next step, build an Envelope, run a Turn, check the reply, and commit it. A fourth loop would repeat the same work, and a planned fan-out Workflow (a swarm, with one Turn for each chunk of a repository) needs several Turns at the same time. So one driver, `drive()` in `src/kernel/drive.ts`, now runs every Workflow, and each Workflow gives it a small object.

## Decisions

- **One log per Workflow run.** The log stays the only source of state. A Turn belongs to a Participant key: `planner` and `reviewer`, `author` and `critic`, `agent`, or later one key for each chunk.
- **A pure step function.** `next(entries, { resumedAt })` returns the Turns to run, one action (a Gate or the handoff), or the outcome. It builds each Turn in full: the Envelope, the session to resume, and the IDs of the entries the Turn answers.
- **Effects stay in the Workflow.** `begin` runs once under the lock (plan restores `plan.md`; discuss appends a follow-up). `commit` appends a Turn's reply or failure and is synchronous. `act` performs Gates and the handoff. `alongsideTurns` reads Human interjections while Turns run.
- **Retries are decided from the log.** `resumedAt` is the log length when this process started its loop. A Workflow compares failures after it to decide a retry, so the driver never retries. For example, a Discussion retries an invalid reply once in each process.
- **Delivery is fixed at Turn start.** `commit` records as delivered exactly the entries in the Turn's Envelope. A message that arrives during the Turn goes in the next Envelope.
- **Parallel Turns across Participants.** The driver runs at most one Turn per key and up to `parallel` Turns in total. It performs an action or returns an outcome only when no Turn is in flight. A step that was decided while a Turn was in flight is decided again after that Turn commits. After an error, it starts no new Turn, lets the Turns in flight commit, and then throws the first error.
- **Every Turn directory is checked.** Before a Turn, the lock refuses while any `turns/*/harness.pid` names a live process, because parallel Turns can leave more than one.

`larp swarm` now runs Chunk Turns in parallel (ADR 0008); plan, discuss, and agent still run one Turn at a time. The swarm uses this driver without another scheduler. This supersedes the historical "parallel Turns" exclusion in `docs/design.md`, and CONTEXT.md defines the per-Participant concurrency rule.

## Considered options

- **A child directory for each parallel session.** Each chunk would have its own log. Rejected: the Workflow state would then live in more than one place.
- **Retries in the driver.** Rejected: plan sends a failure to a Human Gate, discuss retries once with a note, and a swarm would continue the other chunks. The rule belongs to each Workflow.
- **One common entry format for all Workflows.** Rejected: saved logs would need a migration, and each Workflow's entries carry different facts. The driver never reads entries; only the Workflow does.
