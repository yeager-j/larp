# LARP (LLM Agent Relay Protocol)

A relay that lets sessions on different coding harnesses (Claude Code, Codex) exchange messages and take turns on a shared task, without either harness knowing the other's API. LARP is not a harness: it moves Messages and starts Turns, nothing more.

## Language

**Harness**:
A coding agent product that owns a session, its tools, and its permissions. Today: Claude Code and Codex.
_Avoid_: Agent, CLI, tool

**Role**:
A named job inside a Workflow, such as Planner or Reviewer. Implementation happens in a separate Codex desktop task. A Role says what a Participant is for and what it may touch.
_Avoid_: Agent, persona

**Participant**:
One Role bound to one model on one Harness session for the life of a Run. The Planner in a given Run is a Participant.
_Avoid_: Agent, worker, bot

**Run**:
One execution of a Workflow, from the task being given to the Workflow reaching a terminal state.
_Avoid_: Session, job

**Workflow**:
A fixed arrangement of Roles and the rules for how Messages move between them. `larp plan` is the first Workflow.
_Avoid_: Pipeline, graph, flow

**Turn**:
One Participant working once: it starts when the Relay delivers a Message to it and ends when its Harness process exits. Exactly one Turn is active in a Run at a time. A Participant may use its Harness's own subagents inside a Turn; that is invisible to LARP.
_Avoid_: Step, invocation, call

**Message**:
A unit of communication from one Participant (or the Human) to another, carried by the Relay. It has a sender, a recipient, a Kind, and a body.
_Avoid_: Prompt, event, request

**Kind**:
The category of a Message that the Workflow uses to decide what happens next. Some Kinds are terminal for a phase (for example, an approval).
_Avoid_: Type, intent, verb

**Relay**:
The LARP process that owns the Message queue for a Run, delivers the next Message by starting a Turn, and waits for that Turn to end before delivering another.
_Avoid_: Daemon, orchestrator, harness, coordinator

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
