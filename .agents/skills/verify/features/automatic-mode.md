# Automatic mode

Automatic mode arms exactly one Prewalk run without `/prewalk run`. It stays
armed through questions, research, and extension follow-ups, then hands off on
the same checklist-and-mutation gate, and does not re-arm after a terminal
outcome.

## Sub-features

- `auto-command` arms one run in the current session with `/prewalk auto`.
- `auto-startup` arms one run in a fresh top-level TUI session when `prewalk.json` has `enabled: true`.
- `auto-one-shot` does not re-arm after handoff, release, cancellation, or completion.
- `auto-resume-manual` keeps resumed sessions manual.

## How to get to it (user POV)

- Run `/prewalk auto` while Pi is idle.
- Set `"enabled": true` in `prewalk.json` and start a new TUI session (`pi`, `/new`, or a fork).

## Driving it with an RPC script

Preconditions:

- Doctor exits 0.
- A copy of `drive.mjs` setup with a new journey; this feature is not scripted yet.

- **Command arm.** Send `/prewalk auto`. The prompt is `handled`, audit records `armed`, and `/prewalk status` reports `mode=automatic`.
- **Gate.** Send the handoff task prompt. Expect the same provider trace and audit sequence as [handoff](./handoff.md).
- **One shot.** After `/prewalk release`, send another plain prompt. The trace shows only `fixture/planner`, and no new `armed` audit event appears.

## Gotchas

- Startup arming checks `ctx.mode === "tui"`, so RPC and print mode never prove `auto-startup`. Prove it in a TUI under tmux with a scratch `PI_CODING_AGENT_DIR`, and report it unverified otherwise.
- Prompt wording does not decide anything; a test that sends "please implement" and expects arming is testing nothing.
