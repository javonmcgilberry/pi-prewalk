# Prewalk verification map

This directory is the maintained source for verifying Prewalk's user-facing
behavior. Read this index, then use the matching feature file as the recipe.
`../SKILL.md` explains launch, doctor, evidence, and cleanup.

## Baseline preconditions

- `node .agents/skills/verify/scripts/doctor.mjs` exits 0.
- Every drive uses its own scratch `PI_CODING_AGENT_DIR`, workspace, and session file created by `scripts/drive.mjs` (or by a script that reuses its setup). Never drive the user's live Pi session or `~/.pi/agent`.
- The scratch `prewalk.json` names `fixture/executor` at `low` reasoning, and Pi starts on `fixture/planner` at `high`.
- No paid provider, canary, or benchmark runs without explicit approval.

## Driving conventions

- Send what a user types: RPC `prompt` messages such as `/prewalk run` or a plain task sentence. Do not call coordinator methods or emit host events by hand.
- Treat `data.disposition === "handled"` as a finished command; otherwise wait for `agent_settled`.
- Read command output from `extension_ui_request` events with `method: "notify"`, and the selected model from `get_state`.
- Read lifecycle facts from `prewalk-audit` entries in the session file.

## Proof and skip reporting

- Pair each action with its resulting state: the provider trace for routing, the workspace file for mutations, the audit trail for lifecycle, and `get_state` for the selected model.
- A pass also needs no actionable stderr and a byte-identical scratch `settings.json`.
- Record the journey and entry point with each evidence directory.
- When a recipe is marked "not scripted", report it as unverified with the missing step; do not substitute another entry point.

## Feature entry contract

Each feature file has an H1, a one-paragraph description, and four H2 sections
in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with
<harness>` (starting with `Preconditions:`), and `Gotchas`.

## Features

- [Planner-to-executor handoff](./handoff.md): checklist plus first real code change, then the executor takes the next turn; release restores the planner. Scripted: `--journey handoff`.
- [`/prewalk` commands](./commands.md): run, status, cancel, release, todos, stats, configure, children. Scripted: `--journey cancel` and the handoff journey's status and release.
- [Automatic mode](./automatic-mode.md): `/prewalk auto` and `enabled: true` arm one run. Not scripted.
- [Planner recovery](./planner-recovery.md): an interrupted planner gets a hidden recovery turn on the same run. Covered by a stock-Pi integration test, not the driver.
- [Child agents](./child-agents.md): opted-in pi-subagents children run their own handoff. Integration test exists but is skipped by default.
