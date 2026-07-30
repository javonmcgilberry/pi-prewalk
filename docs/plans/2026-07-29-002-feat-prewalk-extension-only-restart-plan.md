# Standalone Prewalk: Extension-Only Restart Handoff

## Decision

Ship Prewalk as a Pi package using only public extension and CLI APIs. The
planner process stops after the first qualifying mutation, then the user exits
and resumes the exact session with Pi's supported `--session`, `--model`, and
`--thinking` startup flags.

This deliberately accepts one manual restart. It does not call Pi's
persistence-coupled `setModel` or `setThinkingLevel`, patch Pi, import private
runtime state, proxy a provider, or save and restore global settings.

Research: [`../research/prewalk-extension-only-feasibility.md`](../research/prewalk-extension-only-feasibility.md)

## Product Contract

- A Pi package can be installed, updated, and removed independently.
- Configuration lives at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/prewalk.json`.
- Automatic mode arms on trusted `startup` and `new` sessions only.
- `resume`, `fork`, `reload`, tree navigation, and compaction fail closed.
- The first automatic assistant turn receives no hidden planning projection.
- Manual `/prewalk` projects the planning instruction immediately.
- The full hidden planning instruction is projected only through the `context`
  event and is never intentionally written to session JSONL.
- The accepted 5-9 item checkpoint is intentionally stored as the visible
  handoff artifact. It is not confidential data.
- Only Pi's typed built-in `edit` and `write` tools qualify as mutations.
- A current-run `prewalk_checkpoint` result must be delivered successfully
  before exactly one mutation call is reserved.
- The first successful reserved mutation aborts the planner after its result is
  recorded. The handoff command is shown only after `agent_settled`.
- The user must exit the planner before running the handoff command.
- `--prewalk-handoff <run-id>` is consumed once on initial startup after the
  resumed branch proves the matching checkpoint and later successful mutation.
- The target continues the exact session file. Global settings remain
  byte-for-byte unchanged.

## Implementation Units

### P1. Package and pure coordinator

Create `pi-prework/prewalk/` with Pi package metadata, strict config parsing,
POSIX shell quoting, handoff proof inspection, and an explicit state machine:

`idle -> armed -> planning -> checkpointed -> mutation-pending -> handoff-pending`

Unit tests cover malformed config, checkpoint bounds, shell quoting, lifecycle
resets, mutation reservation, failed mutations, stale run IDs, and continuation
bounds.

### P2. Public-API extension adapter

Register:

- `/prewalk`, `/prewalk status`, `/prewalk cancel`, `/prewalk configure`,
  `/prewalk enable`, `/prewalk disable`, and `/prewalk handoff`;
- `--prewalk-handoff <run-id>`;
- `prewalk_checkpoint` with sequential execution;
- `context`, `tool_call`, `tool_result`, `agent_settled`, and session lifecycle
  handlers.

Refuse to arm without a saved session, configured authentication, the
checkpoint tool, project trust, or exact cross-provider acknowledgement.

### P3. Distribution and migration

Document local trial, install, update, remove, and optional config cleanup.
After verification, remove the legacy loose extension and install the package
so only one `/prewalk` command is registered.

### P4. Verification

1. Typecheck and offline unit tests.
2. Fake-host event-order tests for projection, checkpoint, mutation reservation,
   abort, settlement, and lifecycle cleanup.
3. RPC smoke test with a fixture session and copied agent profile:
   - exact session file is resumed;
   - runtime model/thinking match requested values;
   - `settings.json` is byte-for-byte unchanged;
   - handoff flag suppresses only the initial startup arm.
4. Inspect session JSONL to prove the hidden planning instruction is absent and
   the checkpoint plus successful mutation remain.

## Stop Conditions

- If startup overrides modify global settings, stop and reopen the fallback
  decision.
- If `ctx.abort()` loses the successful mutation result, stop and reopen the
  fallback decision.
- Do not build a wrapper or patch tool unless the supported restart design is
  explicitly rejected or fails a stop condition.
