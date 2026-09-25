# LARP (LLM Agent Relay Protocol)

A relay that lets sessions on different coding harnesses (Claude Code, Codex) exchange messages and take turns on a shared task, without either harness knowing the other's API. LARP is not a harness: it moves Messages and starts Turns, nothing more. It runs Workflows, lets a harness session start a standalone Agent, and runs Discussions between two models.

## Language

**Harness**:
A coding agent product that owns a session, its tools, and its permissions. Today: Claude Code and Codex.
_Avoid_: CLI, tool

**Role**:
A named definition of a job, stored as a Role file in `~/.config/larp/roles/`: its instructions, Harness, model, effort, and permission. A Workflow uses Roles by name, such as Planner and Reviewer, and may limit their permission. An Agent uses one Role directly. Implementation happens in a separate Codex desktop task.
_Avoid_: persona, profile

**Participant**:
One Role, or one model with default settings, bound to one Harness session for the life of a Run or a Discussion. The Planner in a given Run and the Critic in a given Discussion are Participants. For a single session started by a Caller, see Agent.
_Avoid_: worker, bot

**Run**:
One execution of a Workflow, from the task being given to the Workflow reaching a terminal state.
_Avoid_: Session, job

**Workflow**:
A fixed arrangement of Roles and the rules for how Messages move between them. `larp plan` is the first Workflow.
_Avoid_: Pipeline, graph, flow

**Agent**:
One Role started by a Caller with `larp agent start`, outside any Workflow. It owns one Harness session and a Message log, and the Caller continues it with `larp agent message`.
_Avoid_: subagent, session, Participant

**Caller**:
The person or Harness session that runs `larp agent` or `larp discuss`. It receives each Agent reply, or the Discussion result, on stdout. A Caller is never a Participant or an Agent: commands that start Turns refuse to run inside a Turn.
_Avoid_: parent, user

**Turn**:
One Participant or Agent working once: it starts when the Relay delivers a Message to it and ends when its Harness process exits. Exactly one Turn is active in a Run, a Discussion, or an Agent at a time. A Participant may use its Harness's own subagents inside a Turn; that is invisible to LARP.
_Avoid_: Step, invocation, call

**Message**:
A unit of communication from one Participant (or the Human) to another, or between a Caller and its Agent, carried by the Relay. It has a sender, a recipient, a Kind, and a body.
_Avoid_: Prompt, event, request

**Kind**:
The category of a Message that the Workflow uses to decide what happens next. Some Kinds are terminal for a phase (for example, an approval).
_Avoid_: Type, intent, verb

**Relay**:
The LARP process that owns the Message queue for a Run, a Discussion, or an Agent, delivers the next Message by starting a Turn, and waits for that Turn to end before delivering another.
_Avoid_: Daemon, orchestrator, harness, coordinator

**Discussion**:
Two Participants, the Author and the Critic, answering one Caller message until the Critic agrees with a Proposal or the round cap is reached. The Caller can reopen a finished Discussion with a follow-up, which goes to the Author first. A Discussion is not a Run: it has no Phases, Gates, or Human, and it is stored apart from Runs and Agents.
_Avoid_: debate, conversation, Run

**Author**:
The Participant in a Discussion that owns the Proposal. Every Author reply contains the full Proposal.
_Avoid_: proposer, m1

**Critic**:
The Participant in a Discussion that gives a Verdict on each Proposal. In blind mode it first answers the task on its own.
_Avoid_: reviewer (a Role name), m2

**Proposal**:
The Author's full answer in a Discussion. The Relay numbers each one (v1, v2, …); the model never sets the number.
_Avoid_: draft (the Critic's blind answer), Plan

**Verdict**:
The Critic's reply to one Proposal version: `agree` or `revise`, with its strongest objection. Only a Verdict on the latest Proposal can end a Discussion.
_Avoid_: approval, review

**Round**:
One Proposal and the Verdict on it. The Critic's blind answer is not part of a Round.
_Avoid_: iteration, Turn

**Human**:
The person who started the Run. The Human can send Messages like any Participant and must approve phase gates.
_Avoid_: User, operator

**Plan**:
The artifact the Planner produces and the Reviewer critiques. It lives as a file that Messages refer to rather than travelling inside Message bodies.
_Avoid_: Spec, proposal

**Envelope**:
The text the Relay puts in front of a Message body when it delivers it: who sent it, its Kind, where the Plan lives, and a reminder of the reply schema.
_Avoid_: Header, wrapper, prompt

**Phase**:
A stage of a Workflow with its own set of active Roles and its own terminal Kinds. `larp plan` moves through planning, a Human gate, and desktop handoff. A successful handoff ends the Run; implementation is outside larp.
_Avoid_: Stage, step, state

**Gate**:
A point between Phases where the Run pauses until the Human acts.
_Avoid_: Checkpoint, approval step
