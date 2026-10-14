# Child agents

When `prewalk.json` opts a pi-subagents child agent in under `children.agents`,
that child session runs its own Prewalk handoff to its configured executor.
Children not opted in, read-only children, and children already on the target
model stay on their resolved model, and `/prewalk status` in the child says why.

## Sub-features

- `child-opt-in` arms a run in an opted-in child from its user-prompt task.
- `child-skip` leaves disabled, unlisted, read-only, or equal-target children unarmed with a diagnostic.
- `child-delegation-guard` blocks planner delegation before handoff when `blockPlannerDelegation` is set.

## How to get to it (user POV)

- Configure `children.agents` with `/prewalk children` or in `prewalk.json`, then launch a child with the `subagent` tool.

## Driving it with vitest and installed pi-subagents

Preconditions:

- pi-subagents is installed under `~/.pi/agent/npm/node_modules/pi-subagents`.
- `PI_SUBAGENTS_ENTRY` points at its entry file.

- **End to end.** Command: `PI_SUBAGENTS_ENTRY="$HOME/.pi/agent/npm/node_modules/pi-subagents/index.js" npx vitest run test/integration/agent-loop.test.ts -t "opted-in child"`. Expect `worker.txt` to read `worker` and `nested.txt` to read `nested`.
- **Unit coverage.** Command: `npx vitest run test/integration/extension.test.ts -t child`. Covers diagnostics, the delegation guard, and arming only from user-prompt runs.

## Gotchas

- The end-to-end test is skipped by default because pi-subagents now ships `index.js`, not the `index.ts` the test looks for.
- With `PI_SUBAGENTS_ENTRY` set it currently fails: pi-subagents cannot resolve `@earendil-works/pi-coding-agent` when imported outside a Pi process, so the child never launches. Report this feature as unverified end to end until that is fixed.
- Child tasks arrive as user prompts. A `before_agent_start` with `messageType: "custom"` must not arm a child; the extension test above guards this.
