---
status: accepted
---

# A Participant sends its Message by ending its Turn

Both harnesses can enforce a JSON schema on a session's final answer (`claude -p --json-schema`, `codex exec --output-schema`), and both can run a Turn fully read-only. A `larp send` command run from inside a read-only Codex sandbox cannot write to disk, so it cannot enqueue anything. We therefore make the Turn's structured final answer the Message itself: the role prompt tells the Participant to reply with `{to, kind, body, ...}`, the Relay reads that object when the process exits, enqueues it, and starts the next Turn. There is no send command and no mid-Turn messaging.

## Considered options

- **`larp send` CLI called from inside the Turn.** Familiar shape, but needs a writable path or socket from inside every harness's sandbox, and needs each harness to be taught a tool. Rejected.
- **Live sessions fed by `codex queue` and Claude's stream-json stdin.** Keeps context warm, but larp would have to run and babysit both harnesses' long-lived processes and speak their protocols. That is the harness-shaped coupling this project exists to avoid. Rejected for v1.

## Consequences

- Exactly one Message per Turn. A Participant that needs to say two things says them in one body.
- Invalid moves are prevented by the schema, not rejected by the Relay after the fact, so each Role gets its own schema.
- "Ending the turn" is not a courtesy in the protocol; it is the delivery mechanism.
