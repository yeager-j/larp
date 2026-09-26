---
status: accepted
---

# Two models discuss until the Critic agrees

`larp discuss` lets a Caller ask two models one question and get back an answer that both accept, or a clear report that they did not agree. It is not a Workflow: it has no Phases, no Gates, and no Human, so a coding agent can run it in the background like `larp agent start`.

## Decisions

- **One side owns the answer.** The Author writes the Proposal, and every Author reply contains the full text. The Critic only gives Verdicts. If both sides could edit, the text would drift and it would be unclear who agreed to what.
- **The Relay numbers Proposals.** Each Proposal gets a version in log order, and each Verdict records the version that was in its Envelope. Turns alternate, so a Verdict always answers exactly one version, and only a Verdict on the latest version ends the Discussion. Following ADR 0001, the model never sets the version.
- **The Critic always names its strongest objection.** `objection` is required and must not be empty, even with `agree`. This guards against agreement on the first Turn without thought. The prompt defines a material problem, and asks the Critic not to add new minor points in later rounds, to guard against a Discussion that never ends.
- **Blind mode.** With `--blind`, the Critic answers the task before it sees the first Proposal, so its opinion is not anchored to the Author's. It then gives a Verdict on v1 in the same session, and the Author sees the Critic's own answer with that first Verdict. The blind answer is not a Proposal and does not count as a Round. The two blind Turns stay sequential, because only one Turn is active at a time.
- **Rounds, not Turns.** `--max-rounds` (default 5, at most 10) counts Verdicts. In blind mode the number of Turns per round is not constant, so rounds are the clear unit. Envelopes do not say how many rounds remain, so that neither model changes its behavior near the cap.
- **The cap is a result, not an error.** At the cap, larp prints the last Proposal with the Critic's open objections and exits 2. Exit 0 means agreement and exit 1 means a failed Turn.
- **State comes from the log.** `nextStep` derives the next Turn or the outcome from `messages.jsonl` alone. `resume` runs the same loop, and on a finished Discussion it prints the same result without starting a Turn. An invalid reply is retried once in the same process with a note, then the Discussion stops for `resume`.
- **Follow-ups reopen a finished Discussion.** `larp discuss continue` appends a Caller follow-up to the log, and `nextStep` then gives the Author the next Turn. The Author sees the follow-up first, with the Critic's last verdict, because the Author owns the answer; the Critic sees it on its next Verdict. Proposal versions and the round count in the result continue, but the round cap counts only Verdicts after the latest follow-up, so a follow-up to a capped Discussion can still run. A follow-up is refused until the Discussion has finished, so it never mixes with a Turn that is waiting for `resume`.
- **Read-only.** Every Turn requests read-only access, whatever the Role's `permission` says. Role harness args still pass through, as they do in `larp plan`: Role files come only from the user's config directory (ADR 0004), so larp trusts them and keeps no list of blocked flags.
- **Separate storage.** Discussions live in `~/.larp/discussions/<id>/`, apart from Runs and Agents, for the same reasons as in ADR 0004. Log, lock, and atomic-write code is shared.

## Considered options

- **Both sides edit a shared text.** Symmetric, but it drifts and makes agreement hard to define. Rejected.
- **A reconcile Turn in blind mode**, where the Author merges both independent answers before the first Verdict. It costs one more Turn, and the Critic's Verdict on v1, with its own answer in context, gives the same pressure. Rejected.
- **Rebuilding `larp plan` on the Discussion loop.** Possible later. The plan Workflow has Gates, a Human, and a handoff that a Discussion does not need. ADR 0007 replaces this option: plan, discuss, and agent now share one relay kernel.
