# Prewalk domain language

## Pi session

A Pi session is one Pi conversation identified by one session ID.

## Task tree

A task tree is a Pi session together with the delegated descendant sessions
attributable to it.

Task-tree attribution is an analytics and reporting relationship. It does not
merge the sessions' Prewalk runs, todo state, mutation evidence, or executor
routes.

## Child Prewalk trajectory

A child Prewalk trajectory is the independent run owned by a delegated child
session after that child is explicitly opted in. A mutation-capable child gets
its own `prewalk_todo` gate. Its checklist and first-edit evidence cannot arm
the parent, and the parent's checklist and evidence cannot arm the child.

The child launcher still owns the child definition, tools, permissions,
scheduling, and filesystem isolation. A per-child executor override selects a
model route only; it does not grant mutation capability. Separate trajectories
also do not lock a shared checkout, so concurrent writers require launcher
worktree isolation or explicit coordination.

## Current-session snapshot

A current-session snapshot is the observed data for the exact current Pi session
at the time the snapshot is requested. It does not include descendant sessions.

## Terminal run

A terminal run is a Prewalk run that has a completed receipt.

## Active run

An active run is a Prewalk run that has started but does not yet have a terminal
receipt.

## Observed spend

Observed spend is cost attributed by Pi to recorded usage. It is distinct from
a counterfactual estimate.

## Host run identity

A host run identity is the immutable pair of a Prewalk run ID and its epoch.
Both fields must match before an observation is exact for the current run.

## Host observation

A host observation is the neutral form of a public Pi agent, message, tool, or
compaction event presented to the host-event correlation seam.

## Unowned host observation

An unowned host observation was captured when there was no current Prewalk run.
It may apply only while no run is current.

At an idle manual-run boundary, only unowned lifecycle observations from an
aborted agent are discarded. Exact old-run observations remain stale.

## Unknown host observation

An unknown host observation has no retained ownership fact. Only ordinary
message queries, ordinary tool queries, and an eligible unsuppressed unpaired
terminal compaction may return `apply/unknown`. Unknown `agent-end` is
ignored. Under valid input, `message-start`, `tool-claim`, `agent-start`, and
`agent-settled` do not produce ordinary unknown. `apply/unknown` proves neither
run ownership nor mutation and still has to pass the existing semantic checks.

## Module boundaries

The Pi package entrypoint is `extensions/prewalk.ts`. It calls the adapter
composition at `src/pi/create-prewalk-extension.ts`; lifecycle, turn proof,
routing, recovery, analytics, configuration, and status policy live under
`src/`. The active analytics journal and receipt lifecycle are owned by
`src/analytics/run-accounting.ts`, not by the Pi adapter.
