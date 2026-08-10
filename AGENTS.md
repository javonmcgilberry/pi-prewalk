# Contributor contract

Use this contract when changing Prewalk's host-event correlation code. Read
`README.md`, `CONTEXT.md`, and
`docs/architecture/host-event-correlation.md` before changing that seam.

## Ownership

`src/host-event-correlation.ts` owns neutral facts about stock-Pi host events:
run identity, attribution, insertion-order retention, FIFO host ordering,
session reset, exact pending discard, and factual suppression after a discarded
compaction marker.

It does not own handoff or lifecycle phases, mutation correctness, todo gates,
analytics outcomes, executor/provider selection, compaction scheduling or
retry, child eligibility, goals, task queues, work queues, or scheduling. Do not add GoalSequence or scheduler state to this seam.

Keep dependencies one-way:

- `extensions/prewalk.ts` converts `PrewalkRun` into `HostRunIdentity` and sends
  neutral `HostObservation` values.
- `src/host-event-correlation.ts` may depend on host message types, but it must
  not import `src/orchestration/coordinator.ts` or semantic owners.
- The public class surface stays narrow: `resetSession()`,
  `discardPendingForRun()`, and `observe()`.

Production callers branch only on `HostCorrelation.decision`. Attribution kind,
evidence labels, and discard counts are for factual observability and tests.
They must not become alternate policy inputs. In particular, `apply/unknown`
proves neither current-run ownership nor a code mutation.

## Event adaptation and ordering

Keep the stock-Pi adapters coherent:

- `session_start` resets non-weak correlation state.
- `before_agent_start`, `agent_start`, `agent_end`, and `agent_settled` map to
  their matching agent observations.
- `message_start` claims the message. `message_end` and `turn_end` query it.
- `tool_call` and `tool_execution_start` make the same synchronous tool claim.
  Existing tool-ID ownership does not rebind while its fact remains in the
  bounded map. Insertion-order eviction may leave a later
  `tool_execution_update` or `tool_result` genuinely unknown.
- `session_before_compact` records the cycle before semantic filtering.
  `session_compact` consumes the terminal observation.
- Failure and cancellation call `discardPendingForRun()` with the exact ID and
  epoch before coordinator mutation.

Do not add a second map, queue, active marker, suppression flag, or fallback
helper in the extension. When replacing the implementation, characterize the
behavior first. Then switch every caller and delete the old authority in the
same production change.

Record claims before any semantic `await`. Keep the captured run and the
post-`await` identity checks. A correlation result only describes what was
known at that moment; it does not reserve the run. `TemporaryModelRuntime` and
its run-scoped route lease remain the runtime ownership boundary.

## Tests and verification

Write the characterization before changing behavior. Run the focused suites
first:

```sh
npm test -- test/host-event-correlation.test.ts test/integration/extension.test.ts
npm run typecheck
npm run lint
npm run check:links
npm test
npm pack --dry-run
```

The direct suite should cover both identity fields, exact/stale/unowned/unknown
results, object and compatibility-key message facts, tool ownership that does
not rebind while retained, 512/513 insertion-order eviction, FIFO order, reset,
exact discard, compaction suppression, and out-of-order observations. Integration tests should prove that correlation
cannot bypass mutation, todo, lifecycle, analytics, child, runtime, or
post-`await` guards.

Never weaken a semantic test to fit the adapter. A failed characterization is a
contract question, not permission to move policy into correlation.

## Session, child, and runtime boundaries

One Prewalk run is one trajectory in one Pi session. Each loaded child extension
has its own local correlation state. This module does not rewrite child models,
reasoning, fallbacks, scheduled launches, or descendants, and it does not
schedule work.

Keep `TemporaryModelRuntime` replaceable. The correlation seam may reject stale
host observations, but it cannot select a provider, own credentials, route a
request, or replace the runtime lease.

Code changes require a Pi restart. Documentation-only changes do not alter a
running process. Paid provider checks, authenticated canaries, publication,
and live application remain separate approval boundaries.
