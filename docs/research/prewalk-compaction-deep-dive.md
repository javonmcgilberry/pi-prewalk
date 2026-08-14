# Prewalk compaction deep dive

This note records the investigation into intermittent executor compaction
failures. It describes the stock Pi 0.84.1 runtime, the installed Codex
Conversion 3.0.10 extension, and the Oh My Pi implementation used by the
parity work. It is a design record, not a promise that private Pi internals
will remain stable.

## What was happening

There were two different failure reports.

The older report was a false failure. A Prewalk compaction entry had already
been persisted and the context had dropped, but an observer exception afterward
made the run report `executor-compaction-failed`. Commit `a956d6f` already
handles that case by treating a committed compaction as successful and warning
about the later observer error.

The remaining failure was a real sizing mismatch. Prewalk used the stock
16,384-token reserve at both executor request checks. Pi itself uses the
effective `compaction.reserveTokens` value after global and project settings
are merged. On the affected setup that value was 32,768, with a local override
intending 65,536. A Luna request with a 272,000-token window could therefore
reach the watchdog around 256,000 tokens instead of around 239,000 or 206,000,
depending on the active settings. The executor was being protected too late.

Codex Conversion's 272,000-token Luna limit is a guard in the conversion
extension. It explains the visible ceiling, but it does not explain the
reserve mismatch. Conversion still matters because it can
replace the registered `openai-codex` stream and can provide native Responses
compaction configuration.

## Ownership and event order

The relevant pieces have separate owners:

1. `SettingsManager` owns effective global-plus-project compaction policy.
2. `AgentSession` uses that policy for Pi's native compaction check and emits
   `session_before_compact` and `session_compact` when it persists a result.
3. `src/executor/provider-overlay.ts` owns the request-time planner and executor
   guards. It can stop an oversized Prewalk request before transport and report
   pressure to the run.
4. `src/pi/register-events.ts` owns the run state, the public `ctx.compact()`
   call, and the planner continuation or executor checklist retry.
5. Codex Conversion owns its provider registration and its transport wrapper;
   Prewalk must not assume that it is the only registered stream.

For an ordinary turn, extension `turn_end` handlers run before Pi has finished
its own post-turn compaction decision. Calling `ctx.compact()` from `turn_end`
can race that native decision. The extension now records pressure at
`turn_end`, waits for `agent_settled`, and requests public compaction there.
If Pi persisted a compaction between those events, `session_compact` marks the
pressure as host-satisfied. The settled handler then clears the marker without
starting another compaction. A pending extension compaction remains separate:
its completion callback owns the one checklist retry, and its persisted entry
is reconciled before an observer error can change the outcome.

The flow is:

```text
active Prewalk request
  ├─ planner or executor preflight pressure ──> wait for turn_end/agent_settled
  │                                              ├─ Pi session_compact ──> host satisfied
  │                                              └─ no host compaction ──> ctx.compact()
  └─ executor provider overflow ──> same pressure path
```

The retry counter is scoped to a run, route, and pressure sequence. Planning
may continue once after compaction; an executor request may replay the hidden
checklist once. A completed over-window response can compact without replaying
its answer. If the retried request is still oversized, Prewalk fails instead
of looping. One request that fits clears the route's retry counter, so a later
pressure sequence can compact normally.

## Policy correction

`src/executor/context.ts` keeps 16,384 as a compatibility fallback, and the
shared threshold helpers accept the effective reserve. The extension reads
`SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() }).getCompactionSettings()`
and passes the reserve through all request checks:

- the provider overlay's planner and executor preflight checks; and
- the post-turn executor watchdog.

The policy is refreshed at session start, before a handoff, and before each
turn. If automatic compaction is disabled, an oversized request is not sent.
Prewalk fails closed with `planner-compaction-failed` or
`executor-compaction-failed` instead of calling the public compactor when Pi's
setting says not to.

The setting lookup stays in the extension. The public extension context
exposes `cwd`, `getAgentDir()` is the same runtime directory used by Pi, and
`SettingsManager` applies Pi's normal precedence and trust rules:
`SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() })`.
There is no second settings parser in Prewalk.

## Codex Conversion composition

The composition test loads the real installed Conversion extension and Prewalk
in both registration orders. It checks that:

- Conversion still owns the base `openai-codex-responses` stream;
- Prewalk installs a wrapper rather than replacing Conversion's transport;
- the public stream produces a deterministic assistant response; and
- the selected planner and session history are unchanged.

The test does not treat either order as inherently authoritative. Extension
registration order changes which wrapper sees the provider first, so both
orders need to remain valid. Native Responses compaction is still refused by
Prewalk because the extension cannot safely coordinate that private/provider
policy with its own executor route. The refusal recognizes both the current
nested `compaction.responsesCompaction` setting and the conversion package's
legacy top-level `responsesCompaction` setting. A restored active run is
checked again before its overlay is rebuilt, so changing that setting while Pi
was closed cannot bypass the refusal.

## OMP parity and intentional divergence

Oh My Pi can switch the session model temporarily, so its compaction and
overflow paths naturally size themselves against the executor. A stock Pi
extension cannot use the public `setModel()` for that purpose: it changes the
user's saved model. Prewalk therefore keeps the planner selected and overlays
the registered provider stream. The planner/executor guards, effective reserve
lookup, settled scheduling, and host-compaction reconciliation are Prewalk
safeguards built on Pi's public API. They do not patch Pi or claim the same
integration as a private session-model switch.

The following behavior remains intentionally different:

- Pi's native compaction is still sized for the selected planner. During an
  active run, Prewalk adds request guards for its planner and executor rather
  than replacing Pi's compaction policy. An inactive session is not wrapped.
- Prewalk waits for `agent_settled` before invoking public compaction so it does
  not compete with Pi's post-turn work.
- The selected planner remains visible to Pi and the user while executor
  requests carry the executor identity.
- Provider-native overflow recovery can still depend on Pi's selected-model
  checks and provider error classification. The preflight guard covers the
  known request-size case, not every provider-specific overflow.

The parity matrix at
`docs/research/2026-08-07-omp-behavior-matrix.md` remains the scenario-level
record. This note explains why these differences exist and which ones were
needed to keep the extension safe.

## Temporary model-abstraction design

The first abstraction proposal was intentionally challenged before coding. A
large `TemporaryModelRuntime` that also owned Prewalk phases, audit records,
checklist replay, model resolution, and compaction would be a god module, not a
deep module. `src/executor-chain.ts` remains the one source of truth for
executor selection, and the extension remains the owner of durable run
semantics.

The implemented seam is narrower: `src/executor/temporary-runtime.ts` exposes a
run-scoped `TemporaryModelRuntime` with `mount()` and a
`TemporaryModelLease.restore()`/`ownsRoute()` contract. Its stock-Pi
adapter hides provider registration, exact planning-prompt removal,
request-time executor/auth resolution, executor stream evidence, planner and
executor context preflight, and provider ownership. Semantic callbacks report
only observed executor start/success/failure, route-specific context pressure,
and provider drift. A lease
captures its run identity and invalidates callbacks before restoring the
provider, so a delayed stream or stale overlay from run N cannot fail run N+1.

Compaction scheduling deliberately stays outside this seam. It coordinates
Pi's session events (`turn_end`, `agent_settled`, `session_compact`) and the
Prewalk checklist, so it is session/run policy rather than temporary model
transport. Keeping it in the extension prevents the runtime from becoming a
second coordinator and preserves the existing retry/deduplication tests.

This is a replaceable seam, not a claim that a native backend exists today. If
Pi exposes a trustworthy nonpersistent session-local model switch, a future
adapter can implement the same mount/lease contract. It must prove target
execution rather than treating a successful setter as executor activation,
preserve the planner and saved settings, reject stale ownership changes, and
pass the same routing/restore contract tests. No `runtime.kind` branch or
speculative native implementation belongs in Prewalk before that host seam is
real.

## Verification map

Tests cover the public boundaries separately:

- `test/executor/model-runtime.test.ts` checks the run-scoped lease contract,
  exact provider restoration, and stale callback isolation.
- `test/executor/executor-context.test.ts` checks the default and custom reserve math.
- `test/executor/provider-overlay.test.ts` checks that the effective reserve
  reaches planner and executor preflight.
- `test/integration/extension.test.ts` checks configured reserves, disabled
  compaction, settled scheduling, native-compaction deduplication, retry limits,
  inactive tool slates, and observer-error reconciliation.
- `test/integration/codex-conversion.test.ts` composes the installed Conversion
  stream in both registration orders.
- `scripts/teeth/cross-provider.teeth.json` keeps the pressure and lifecycle
  regressions mutation-tested.

Known limits are explicit: a tokenizer estimate can be conservative or wrong,
provider overflow signals vary, and a future Pi event-order change must be
rechecked against the settled scheduling assumption.
