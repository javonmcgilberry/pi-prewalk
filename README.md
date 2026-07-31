# Pi Prewalk

Pi Prewalk is an extension-only implementation of Oh My Pi's Prewalk flow. The
Pi-selected planner stays selected and saved while it plans, opens the todo
gate, and makes the first successful mutation. The extension snapshots that
model and reasoning when the epoch starts, then routes primary Agent-loop
requests through a configured same-provider executor for the rest of that live
session. Prewalk is manual by default. `/prewalk auto` enables automatic mode
only for the current Pi session, and a new, resumed, forked, or shut-down
session starts manual again.

This package uses stock Pi 0.82.1 public extension and provider APIs. It does not
patch Pi, import private Pi modules, call `setModel()` for the handoff, create a
router model, or modify Pi settings.

## Requirements

- `@earendil-works/pi-coding-agent` 0.82.1
- Configured authorization for the chosen provider
- Two available models on the same provider and Pi API
- No other extension owning the `todo` tool name

The default pair is Sol-to-Luna. Built-in same-provider pairs such as
Opus-to-Sonnet use Pi's public provider stream.

## Install

```sh
npm install
pi install .
```

Create `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/prewalk.json`:

```json
{
  "executor": {
    "provider": "openai-codex",
    "model": "gpt-5.6-luna",
    "reasoning": "low"
  }
}
```

The schema is strict. Run `/prewalk configure` to choose an executor compatible
with Pi's currently selected planner and independent executor reasoning through
Pi's native UI. Long model catalogs are shown eight at a time. A newly selected
executor defaults to `low`; an existing executor keeps its saved level at the
top of the picker. Prewalk never stores or changes the planner model.

## Behavior

`/prewalk run` starts a manual Prewalk run. `/prewalk auto` records automatic
mode in the active session only and does not validate models, install a provider
overlay, open analytics, or inject a planning prompt. `/prewalk configure`
writes executor and analytics settings only, and does not start Prewalk work.

The bundled `todo` tool must succeed while active. The first successful `edit`,
`write`, direct `apply_patch`, shell `apply_patch`, or Code Mode patch after
that gate becomes the handoff mutation. Failed, partial, cancelled,
still-running, quoted, printed, and dynamically constructed patch attempts do
not trigger.

The extension decides after the complete assistant turn, so parallel tool
results cannot race the handoff. Before Luna's first request, stale planning
guidance is removed from effective context and OMP's executor checklist is
retained. Hidden Prewalk messages are also excluded from compaction summaries.
Luna-authored transcript messages keep Luna's real provider, model, usage, and
stop reason.

The compact status shows both roles and reasoning levels:

- `prewalk: [5.6 Sol · low] / Luna · low` while Sol is armed
- `prewalk: [5.6 Sol · low] / Luna · low (waiting for first code change)` after the todo gate
- `prewalk: [5.6 Sol · low] / Luna · low (switching after this turn)` after the handoff mutation
- `prewalk: 5.6 Sol · low / [Luna · low]` after the handoff
- Route-specific `(cancelled)` and `(failed)` states

Pi's native selector continues to show Sol. Use `/prewalk status` for the run,
gate, trigger, selected model, and stable failure reason.

Prewalk does not require `pi-subagents`. When it is installed, every child Pi
launch receives the active epoch's executor profile through pi-subagents'
versioned public policy event. The accepted profile is enforced before spawn
and forwarded to async, resumed, and nested descendants, so no child can regain
the planner model and reasoning tuple. Without active Prewalk, pi-subagents
keeps its normal model behavior. Without pi-subagents, Prewalk keeps its normal
standalone lifecycle.

A child that independently starts Prewalk and has the `todo` tool follows the
full todo gate. A strict child allowlist that omits `todo` treats the gate as
inactive and hands off after its first successful mutation. A child mutation
never switches the parent.

To give pi-subagents' built-in writer the full gate, preserve its normal tools
and append `todo` to `subagents.agentOverrides.worker.tools`. Read-only agents do
not need it.

Shift+Tab follows the active Prewalk role. Before handoff it remains Pi's native
Sol reasoning control. After handoff Prewalk consumes it and cycles Luna's live
reasoning without changing Luna's saved baseline. Use `/prewalk configure` to
change that baseline.

Commands:

- `/prewalk status`
- `/prewalk run`
- `/prewalk auto`
- `/prewalk cancel`
- `/prewalk configure`
- `/prewalk help` or `/prewalk --help`
- `/todos`

An explicit Pi model selection cancels the route without changing the user's
selection. `/reload` restores automatic readiness only for the same session.
New, resumed, and forked sessions do not inherit automatic mode.

Typing exactly `stop` or `cancel` closes only the current Prewalk task and keeps
automatic mode ready for the next task. `/prewalk cancel` is the session control
that also disables automatic mode.

## Personal savings analytics

Analytics are enabled by default and remain local to the Pi agent directory at
`prewalk/analytics`. Only allowlisted run metadata, token counts, Pi-reported
costs, model pricing evidence, outcomes, and timestamps are stored. Prompts,
responses, code, tool inputs/outputs, credentials, provider payloads, raw
errors, and filesystem paths are never persisted or exported.

Actual spend is the sum of Pi-reported attributable usage. Savings are a
planner-only counterfactual: executor-priced cost for planner usage minus the
planner's reported actual cost. Missing or incomplete rates produce
`unavailable`; optional dated catalog fallback is labeled `catalog-estimated`.
Negative savings are shown as estimated extra cost. Evidence labels distinguish
`actual`, `estimated`, `catalog-estimated`, `unavailable`, `unfinished`, and
`verified` benchmark values.

Use `/prewalk stats` for lifetime, month, week, session, and recent receipts;
`/prewalk stats task` for the root task tree and descendant coverage;
`/prewalk stats --successful` for successful runs; `receipt <run-id>` for
calculation detail; `export <path>` for JSONL; and `reset` after confirmation to
rotate to an empty generation. Export uses exclusive creation: an existing
filename is never changed and the command tells you to choose a new filename.
A reset during a run excludes that prior-generation run; collection resumes on
the next run. `/prewalk configure` controls collection and catalog fallback.

Catalog fallback is opt-in and honest: stock Pi exposes the active model's
public `Model.cost`, but does not expose independent catalog provenance or an
effective date. Prewalk therefore does not invent catalog evidence; when that
metadata is unavailable, the estimate remains `unavailable`.

Verified benchmark reports are imported as a separate, fingerprinted evidence
summary and never enter personal totals. Delegation task trees consume only the
optional versioned, content-free `pi-subagents` projection. Child receipts take
precedence over matching fallback usage, while pending, partial, and unresolved
overlap are labeled separately. Stock Pi works without `pi-codex-conversion`,
`pi-subagents`, or any provider extension.

## Verification

Routine checks do not make provider requests:

```sh
npm run lint
npm run typecheck
npm test
npm run test:agent-loop
npm run smoke:rpc
npm pack --dry-run
```

The unit and mocked-extension suites cover prompts, the OMP coordinator, todo,
mutation proof, status, audit records, and provider ownership. The Agent-loop
suite uses stock Pi's exported session factory and the installed conversion
package. The RPC smoke loads conversion first, arms, reports status, cancels,
reloads, and proves settings and selected Sol remain unchanged without calling
a provider.

### Authenticated canary

The canary makes real Sol and Luna requests and is never part of routine tests.
It copies only the `openai-codex` credential into an owner-only temporary agent
directory, limits mutations to one temporary fixture, records redacted model,
usage, status, trigger, and settings-digest evidence, then removes the temporary
credentials and workspace.

```sh
npm run canary:provider -- \
  --confirm-provider-cost I_UNDERSTAND_PROVIDER_REQUESTS \
  --auth-file "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json" \
  --pi "$(command -v pi)" \
  --evidence-dir ./canary-evidence
```

### Why benchmark Prewalk

The expected saving comes from preserving one useful trajectory. A read-only
planning handoff makes the expensive planner explore the repository, then makes
the executor repeat much of that exploration from a summary. Prewalk keeps the
same conversation, todo state, and first successful mutation, so Luna starts
from work Sol already grounded in the code.

[Stencil's published experiment](https://stencil.so/blog/prewalk) reported that
Sol-to-Luna Prewalk retained 97 percent of Sol's pass rate at 61 percent of its
cost. Those numbers are useful comparison targets, not promises. The article
does not publish its task IDs, sample size, repetitions, raw traces, or complete
harness configuration. OpenAI has also
[reported that roughly 30 percent of SWE-Bench Pro is broken](https://openai.com/index/separating-signal-from-noise-coding-evaluations/),
so this project audits prompt and test alignment instead of accepting tasks
because they belong to that dataset.

### Directional benchmark

The first paid study compares Sol-only, Luna-only, and Prewalk once across at
least 20 frozen, independently validated tasks. This is 60 provider runs. It is
designed to catch a large regression or a useful cost, time, and quality signal
without pretending that one attempt measures run-to-run reliability.

The report includes pass rate, median provider cost, median elapsed time, every
failed or invalid run, and prohibited lookup attempts. Lookup attempts are a
local offline-sandbox diagnostic, not a reproduction of Stencil's web-search
metric. The report shows whether the prior comparison targets were met, but it
is always marked directional and never emits a release verdict.

Run three attempts per task and arm when the first result is close or noisy,
when more than one run is invalid or times out, or before publishing any numeric
performance or savings claim. Use five attempts only if three remain
inconclusive. The shipped runner deliberately accepts only the one-attempt
initial study; a repeated follow-up must be separately reviewed and frozen
before provider work. See [`benchmark/README.md`](./benchmark/README.md).

The extension may be shared as experimental before this study. Until provider
runs exist, describe the package as a faithful OMP behavior reproduction and do
not claim measured savings for this implementation.

## Attribution

The planning, continuation, and executor-checklist prompts are copied
byte-for-byte from Oh My Pi revision
`8db0228f4d38ff5d41b30038b6d227b01ea0fc8a` under the MIT license. See
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
