# Pi Prewalk

Pi Prewalk is an extension-only Sol-to-Luna implementation of Oh My Pi's
Prewalk flow. Pi keeps `openai-codex/gpt-5.6-sol` selected and saved. Sol plans,
opens the todo gate, and makes the first successful mutation. The extension
then routes primary Agent-loop requests through
`openai-codex/gpt-5.6-luna` at low reasoning for the rest of that live session.
A new or reopened session starts on Sol.

This package uses stock Pi 0.82.1 public extension and provider APIs. It does not
patch Pi, import private Pi modules, call `setModel()` for the handoff, create a
router model, or modify Pi settings.

## Requirements

- `@earendil-works/pi-coding-agent` 0.82.1
- `@howaboua/pi-codex-conversion` 3.0.3, loaded before Prewalk
- Configured OpenAI Codex authorization
- Both `openai-codex/gpt-5.6-sol` and
  `openai-codex/gpt-5.6-luna` in Pi's public model registry
- No other extension owning the `todo` tool name

Phase one deliberately fixes this model pair. Provider-agnostic pairs such as
Opus-to-Sonnet are follow-up work.

## Install

```sh
npm install
pi install @howaboua/pi-codex-conversion
pi install .
```

The extension load order matters because Prewalk wraps the public
`openai-codex` stream registered by the conversion package.

Create `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/prewalk.json`:

```json
{
  "enabled": true
}
```

The schema is strict. Model IDs, provider, and Luna reasoning are fixed in this
release.

## Behavior

Automatic mode lets Sol finish its first assistant turn, then sends OMP's exact
hidden planning prompt. The bundled `todo` tool must succeed while active. The
first successful `edit`, `write`, direct `apply_patch`, shell `apply_patch`, or
Code Mode patch after that gate becomes the handoff mutation. Failed, partial,
cancelled, still-running, quoted, printed, and dynamically constructed patch
attempts do not trigger.

The extension decides after the complete assistant turn, so parallel tool
results cannot race the handoff. Before Luna's first request, stale planning
guidance is removed from effective context and OMP's executor checklist is
retained. Hidden Prewalk messages are also excluded from compaction summaries.
Luna-authored transcript messages keep Luna's real provider, model, usage, and
stop reason.

The compact status is based on `prewalk: 5.6 Sol / Luna`:

- `prewalk: [5.6 Sol] / Luna` while Sol is armed
- `prewalk: [5.6 Sol] / Luna (ready)` after the todo gate
- `prewalk: 5.6 Sol / [Luna]` after the handoff
- Route-specific `(cancelled)` and `(failed)` states

Pi's native selector continues to show Sol. Use `/prewalk status` for the run,
gate, trigger, selected model, and stable failure reason.

Commands:

- `/prewalk status`
- `/prewalk run`
- `/prewalk cancel`
- `/todos`

An explicit Pi model selection cancels the route without changing the user's
selection. `/reload` restores the current extension-owned run state. New,
resumed, and forked sessions create a fresh Sol epoch when Sol is selected.

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

### Release benchmark

Release requires a frozen, independently validated corpus of at least 20 tasks
and five repetitions for each arm: Sol-only, Luna-only, and Prewalk. This is at
least 300 provider runs and requires separate explicit cost consent.

Prewalk must stay within 5 percentage points of Sol's pass rate, improve median
cost or elapsed time by at least 15 percent, exceed Luna's pass rate by at least
10 percentage points, keep the other cost/time metric within 5 percent, and
avoid increasing solution-source lookup attempts. See
[`benchmark/README.md`](./benchmark/README.md). No release claim is permitted
until every gate passes. The trusted controller, remote tool boundary,
disposable worker contract, isolated evaluator, blinded metric lock, and final
unblinding gate are implemented. The current corpus is intentionally unfrozen
and empty, so no provider benchmark has run and the package is not ready for
release yet.

## Attribution

The planning, continuation, and executor-checklist prompts are copied
byte-for-byte from Oh My Pi revision
`8db0228f4d38ff5d41b30038b6d227b01ea0fc8a` under the MIT license. See
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
