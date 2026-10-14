# /prewalk commands

`/prewalk` is the user's control surface: it starts and arms runs, reports the
planner, executor, gate, and route, cancels or releases a run, and shows the
checklist, usage estimates, and configuration.

## Sub-features

- `cmd-run` starts a manual run only while Pi is idle.
- `cmd-status` reports mode, phase, planner, executor, selected model, todo gate, and trigger.
- `cmd-cancel` cancels the run, disarms automatic mode, and removes `prewalk_todo`.
- `cmd-release` restores the planner after handoff.
- `cmd-todos` shows the current checklist.
- `cmd-stats` shows local cost and model-switch estimates.
- `cmd-configure` and `cmd-children` edit `prewalk.json` through interactive UI.

## How to get to it (user POV)

- Type `/prewalk <subcommand>` in the Pi editor; `/prewalk help` lists them.
- In RPC or print mode, send the same text as a prompt.

## Driving it with drive.mjs

Preconditions:

- Doctor exits 0.

- **Run then cancel.** Command: `node .agents/skills/verify/scripts/drive.mjs --journey cancel`. `/prewalk run` and `/prewalk cancel` are `handled`; audit records `armed` and ends with `cancelled`; `provider-trace.jsonl` is absent because no request was made.
- **Status.** Both journeys send `/prewalk status`; `summary.json.notices` holds its full text.
- **Release.** The handoff journey covers `/prewalk release`; see [handoff](./handoff.md).
- **Todos and stats.** Not scripted. Reuse the driver setup, send `/prewalk todos` after the planner's `prewalk_todo init`, and assert the notice lists `Write the verification file`. For stats, send `/prewalk stats` after a handoff and assert a notice appears.
- **Configure and children.** Not scripted. These open interactive selectors (`extension_ui_request` with `method: "select"`/`"input"`), so an RPC client must answer each request with `extension_ui_response`. Confirm the scratch `prewalk.json` changes only after **Save changes**.

## Gotchas

- `/prewalk run` refuses while a turn is active and notifies instead; since Pi 1.2.0 the session also counts as busy while a run is starting, including during `before_agent_start`.
- `cancel` leaves the selected model on the planner; asserting only the notice text misses a route leak, so also check `get_state`.
- The footer text (`Planning`, `Executing`, role names) is a `setStatus` event in RPC (`extension_ui_request`, `method: "setStatus"`); check it there rather than parsing the status notice.
