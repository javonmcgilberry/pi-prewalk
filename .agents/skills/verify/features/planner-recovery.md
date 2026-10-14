# Planner recovery

If the planner's stream is aborted, a planner tool call is rejected as stale, or
a turn settles without a checklist, Prewalk queues a hidden recovery turn on the
same run with the saved planning trace. It retries up to
`plannerRecovery.maxRetries` (default 5), then pauses instead of discarding the
run.

## Sub-features

- `recover-abort` queues a recovery turn after an aborted planner stream.
- `recover-no-checklist` retries a settled turn that produced no checklist.
- `recover-pause` pauses at the retry limit and resumes on the next user message.
- `recover-restore` restores an unfinished planner run when the session resumes or reloads.

## How to get to it (user POV)

- Press Escape during a planning turn, then let Pi continue.
- Resume a session (`pi -c` or `/resume`) that was planning when it closed, or run `/reload`.

## Driving it with vitest on stock Pi

Preconditions:

- Doctor exits 0.

- **Abort and recover.** Command: `npx vitest run test/integration/agent-loop.test.ts -t "self-recovers an aborted planner"`. It drives a real `createAgentSession` with a scripted provider and asserts the recovery turn and single route through shutdown.
- **Restore.** Command: `npx vitest run test/integration/session-restore.test.ts`. It reopens real sessions and asserts the restored planner run.
- **RPC journey.** Not scripted. With the driver setup, send the task prompt, send RPC `{"type":"abort"}` while the planner request is in flight, and assert a `prewalk-recover` or `prewalk-continue` custom message plus an audit `planning-retry`.

## Gotchas

- The fixture provider answers instantly, so an RPC abort needs a planner reply that waits (for example a delayed stream) or it lands after the turn.
- Since Pi 1.2.0 an abort requested while a run is starting aborts that run once it starts, so expect `agent_start` followed by an aborted `agent_end`, not a missing start.
