# Host-event correlation

## Context

Prewalk builds one planner-to-executor trajectory inside a stock Pi session.
Its coordinator gives each run a run ID and an epoch, but Pi's public agent,
message, tool, and compaction events do not carry that identity. A delayed
terminal event can therefore arrive after a run has failed, been cancelled, or
been replaced.

Using only the current coordinator run is unsafe. It can misread an event from
run A as evidence for replacement run B. The opposite mistake is also possible:
an event captured while no run existed can be treated as if it belonged to a
later run.

The extension needs run attribution based on recorded facts, but that layer
cannot decide handoff, mutation, analytics, compaction policy, or scheduling.

## Decision

`src/host-event-correlation.ts` is the sole owner of host-event correlation
facts. The extension translates public Pi events into a closed
`HostObservation` union and passes the current `HostRunIdentity`, if any, to
`PiHostEventCorrelation.observe()`.

A host run identity is the pair `{ runId, epoch }`. Both fields must match. The
module returns a `HostCorrelation` result that describes what it knows at that
moment:

- `decision: "apply" | "ignore"` for production control flow;
- factual attribution for tests and diagnostics.

Production callers inspect only `decision`. Attribution kinds and evidence
labels do not own policy.

The class exposes three methods:

```ts
resetSession(): void
discardPendingForRun(run: HostRunIdentity): PendingRunDiscard
observe(
  observation: HostObservation,
  currentRun: HostRunIdentity | undefined,
): HostCorrelation
```

The module imports only the public `AgentMessage` type. It does not import the
Prewalk coordinator or any other semantic owner.

## Responsibilities

The correlation seam owns:

- exact identity comparison using run ID and epoch;
- message facts by object identity and a role/timestamp compatibility key;
- tool-call ownership that does not rebind while its ID fact remains in the
  bounded map;
- FIFO facts for pending agents, agent ends, settlement, and compaction;
- the active agent marker;
- bounded insertion-order retention for keyed message and tool facts;
- exact pending discard for a failed or cancelled run;
- factual suppression of a compaction terminal after its marker was discarded;
- session reset of non-weak state;
- classification as exact, stale, explicitly unowned, unknown, or suppressed.

It does not own:

- arming, handoff, continuation, failure, cancellation, release, or recovery;
- mutation classification or todo correctness;
- analytics outcomes or child accounting;
- executor selection, provider routing, credentials, or runtime leases;
- compaction scheduling, retry, checklist replay, or outcome policy;
- child eligibility, child launch arguments, or descendant inheritance;
- goals, GoalSequence, task queues, work queues, or scheduling;
- commands, UI, audit persistence, or session receipts.

The extension and the existing source modules still make those decisions.

## Factual model

A retained marker is either an exact `HostRunIdentity` or `null`. `null` means
the event was explicitly captured while no Prewalk run was current. Missing
evidence is `undefined` and means unknown. The distinction matters:

- exact current identity applies;
- an exact identity for another run is stale and ignored;
- explicit unowned evidence applies only while no run is current;
- unknown agent end is ignored;
- genuinely unknown message and tool queries, and an unsuppressed unpaired
  terminal compaction, return `apply/unknown` and continue through the unchanged
  semantic prerequisites;
- a suppressed compaction terminal is ignored.

`apply/unknown` deliberately lets compatibility checks continue. It proves
neither ownership nor mutation. Mutation evidence, todo state, lifecycle phase,
runtime ownership, analytics generation, and post-`await` run checks still
decide whether the observation can change anything.

## Event adaptation

| Public Pi event | Observation | Factual transition |
| --- | --- | --- |
| `session_start` | none | `resetSession()` clears non-weak state |
| `before_agent_start` | `before-agent` | append current exact identity or `null` to pending FIFO |
| `agent_start` | `agent-start` | consume pending or capture current; append agent-end FIFO; set active |
| `agent_end` | `agent-end` | prefer known message, otherwise agent-end FIFO; append settlement before classification |
| `agent_settled` | `agent-settled` | consume settlement, then active, then current; clear matching active; discard matching compaction markers |
| `message_start` | `message-start` | select object, key, active, settlement, then current; store object and key facts |
| `message_end`, `turn_end` | `message` | query object, key, active, then settlement without storing |
| `tool_call`, `tool_execution_start` | `tool-claim` | select existing ID, active, settlement, then current; always store the ID |
| `tool_execution_update`, `tool_result` | `tool` | query ID, active, then settlement without storing |
| `session_before_compact` | `before-compaction` | clear cycle suppression and queue current exact identity only |
| `session_compact` | `compaction` | consume queued exact marker, otherwise suppression, otherwise unknown |

The two tool-claim adapters are intentionally identical and synchronous. A
semantic `await` may happen only after the claim has captured the host fact.
Callers keep their captured run identity and recheck it after each relevant
`await`.

## Ordering, retention, reset, and discard

Message facts prefer object identity. The compatibility key is
`${role}:${String(timestamp)}` so messages with different roles do not collide
at the same timestamp. A start always writes the selected marker to both the
object and key facts. A query does not write.

A later claim cannot rebind a tool-call ID while that ID's fact is retained.
The tool-ID map keeps the newest 512 distinct entries in insertion order, and
the 513th distinct ID evicts the oldest. After eviction, a later claim for that
ID may establish a new fact, while a later query may be genuinely unknown. A
query before a claim does not create a fact.

The message-key and tool-ID maps retain the newest 512 distinct insertion-order
entries. Updating an existing key does not promote it. The four ordered host
buffers are uncapped FIFO because dropping or reordering them changes
attribution.

`resetSession()` clears keyed message facts, tool facts, every FIFO, the active
marker, and compaction suppression. The message object `WeakMap` remains on the
same correlation instance, so a still-live message object keeps its fact across
reset. A new extension instance has no such fact.

`discardPendingForRun()` removes every matching exact marker from the pending
agent and compaction FIFOs. It leaves message, tool, agent-end, settlement,
active, null, and other-run facts alone. Removing a compaction marker arms
suppression for the rest of that cycle. Failure and cancellation call discard
with the exact identity before mutating the coordinator.

A settlement also removes matching compaction markers and arms suppression. A
queued exact terminal is consumed before suppression. Suppression stays armed
across repeated orphan terminals until `session_before_compact` starts a new
cycle or the session resets.

When message evidence gives `agent-end` a known non-null run identity, it
removes one agent-end marker for that same identity. This includes an identity
that is stale for the current run. Null or unowned message evidence removes
none; a later empty agent-end consumes the queued `null`. These details preserve
public event ordering when Pi supplies direct messages and empty terminal
events in different orders.

## Caller contract

The extension follows five rules:

1. Record a neutral observation before doing semantic work.
2. The `before-agent`, `message-start`, and `before-compaction` adapters
   establish facts and ignore the returned decision. Their handlers may still
   continue unrelated work they already own.
3. For event-specific semantic work governed by correlation, return immediately
   only when `decision === "ignore"`.
4. Continue through the existing checks on `apply`, including `apply/unknown`.
5. Preserve runtime leases and exact post-`await` identity checks. The result
   describes one moment; it does not lock the run.

No caller branches on attribution kind, evidence, discard counts, or suppression
details. Tests may inspect those fields to prove the factual implementation.

## Stock Pi and the OMP principle

Prewalk keeps Oh My Pi's basic rule: one trajectory with an exact
planner-to-executor handoff. This implementation uses stock Pi's public
extension events instead of private agent-loop state. When the layer still
retains a known exact, stale, unowned, or suppressed fact, it keeps that delayed
event from crossing run or epoch boundaries.

Stock Pi events still have no intrinsic Prewalk identity. Genuinely unknown
message and tool queries, and an unsuppressed unpaired terminal compaction where
applicable, still return `apply/unknown`. They prove neither ownership nor
mutation and continue through the unchanged semantic prerequisites. The
existing code still has to prove mutation, todo completion, lifecycle state,
analytics ownership, and runtime route ownership.

## Alternatives rejected

### Attribute every event to the current run

This looks simpler, but a stale event from run A could affect replacement run
B. It would also lose explicit unowned capture.

### Keep correlation state in the extension

Separate message, tool, agent, and compaction helpers in the composition root
create dual ownership and make ordering rules hard to test directly.

### Expose one public method per Pi event

That interface couples the fact layer to Pi's event catalog. A neutral
observation union keeps the public seam small and makes adapter coverage easy to
check.

### Return a run handle or lock

A synchronous result cannot protect work after an `await`. Existing run
identity and `TemporaryModelRuntime` lease checks remain the correct guards.

### Move lifecycle or compaction policy into correlation

That would merge facts with semantic decisions. Correlation records that a
marker was discarded; the extension still decides whether, when, and how to
compact, retry, fail, or recover.

### Add a scheduler or GoalSequence here

Host-event attribution does not own work. Scheduling belongs above Prewalk and
is outside this module.

## Residual limits

- Public Pi events still have no universal Prewalk correlation ID.
- Role/timestamp compatibility keys can collide; object identity takes
  precedence.
- Same-instance reset keeps live WeakMap message facts.
- Ordered host buffers are uncapped.
- Correlation snapshots do not replace post-`await` guards or runtime leases.
- Truly concurrent public agent loops may introduce host orderings not covered
  by today's serialized event assumptions.
- Unknown provider serialization and compaction shapes remain outside this
  factual seam.
- There is no dedicated async integration test for an unknown `tool_result`
  captured with no current run and completed after a replacement starts.
  Current confidence comes from static adapter and helper proof, direct tests,
  existing unchanged integration evidence, and the retained post-`await`
  identity and semantic guards.
  The initial unknown result remains permissive `apply/unknown`.

## Replacement and deletion criteria

A future Pi-native run-scoped event identity can replace this module only when
all supported events carry stable identity through message, tool, settlement,
and compaction terminals. The replacement must still preserve explicit unowned
and unknown behavior or intentionally migrate it with new characterization.

Deleting the module without replacement is safe only if the extension no longer
needs to distinguish exact, stale, unowned, unknown, and suppressed
observations. Removing it today would let the characterization suite fail and
would reopen cross-run event leakage.

## Verification

Start with the focused factual and integration suites:

```sh
npm test -- test/host-event-correlation.test.ts test/extension.test.ts
```

Then run the secret-free repository checks:

```sh
npm run typecheck
npm run lint
npm run check:links
npm test
npm pack --dry-run
```

The direct suite is the contract for identity, classification, transition
order, retention, reset, discard, suppression, and public surface. The extension
suite checks the public-Pi adapters and proves correlation remains subordinate
to lifecycle, mutation, todo, analytics, child, compaction, and runtime guards.
