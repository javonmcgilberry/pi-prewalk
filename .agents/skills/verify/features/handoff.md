# Planner-to-executor handoff

After `/prewalk run`, the selected planner investigates, creates the
`prewalk_todo` checklist, and makes the first code change that counts. Prewalk
then routes the next turn in the same session to the configured executor, keeps
later turns there, and returns to the planner on `/prewalk release`. The saved
default model never changes.

## Sub-features

- `handoff-gate` switches only after a successful checklist and a counted code mutation.
- `handoff-route` serves the next turn from the executor at its configured reasoning level, exactly once per trigger.
- `handoff-sticky` keeps the executor selected for follow-ups after the first executor response.
- `handoff-release` restores the planner and closes the run.
- `handoff-ignore` skips the switch for mutations matching `handoff.ignoreExtensions` (Markdown by default).

## How to get to it (user POV)

- Put the task in the conversation, wait for Pi to be idle, run `/prewalk run`, then send the task prompt.
- Arm with `/prewalk auto` (or `enabled: true` in a fresh TUI session) and send the task prompt; the gate is the same.
- Run `/prewalk release` when the task is done.

## Driving it with drive.mjs

Preconditions:

- Doctor exits 0.
- The scratch `prewalk.json` uses the default `handoff` settings.

- **Arm.** Send `/prewalk run`. Command: `node .agents/skills/verify/scripts/drive.mjs --journey handoff`. The prompt is `handled`, and audit records `armed` and `plan-injected`.
- **Plan and mutate.** Send `Write the verification file.` The fixture planner returns `prewalk_todo init`, then `write` plus `prewalk_todo done`. `prewalk-verify.txt` in the scratch workspace contains `written by the planner`.
- **Switch.** Prewalk triggers the checklist turn. `provider-trace.jsonl` shows two `fixture/planner` requests at `high`, then exactly one `fixture/executor` request at `low`. Audit records `handoff-triggered`, `executor-active`, and `handoff-completed` once each.
- **Status.** Send `/prewalk status`. The notice contains `phase=completed`, `selected=fixture/executor`, and `trigger=write`; `get_state` reports `fixture/executor`.
- **Release.** Send `/prewalk release`. `get_state` reports `fixture/planner`, and the last audit event is `manual-release`.
- **Proof.** `summary.json` has `"ok": true`; keep the whole evidence directory.

## Gotchas

- The executor turn is a custom-message run started with `triggerTurn`. Since Pi 1.2.0 it goes through `before_agent_start` with `messageType: "custom"`; a regression there shows up as a missing executor request, not as an error.
- Writing a `.md` file does not trigger the switch by default. Setting `handoff.ignoreExtensions` to `[".txt"]` makes every switch check fail, which is the negative control for this journey.
- `completed` in status means the executor answered once, not that the task is finished.
- The driver waits up to 60 seconds for the executor request; a slow failure is a missing handoff, not a flaky timeout.
