# Local analytics

Prewalk keeps one local receipt for each finished run. Receipts live under the
Pi agent directory at `prewalk/analytics` and contain only allowlisted metadata.
Stats read optional titles from Pi session logs and private backfill metadata
under `session-metadata/summaries`. Recent, receipt, and task-tree views show a
title when one is available while retaining stable session and run IDs.
Prewalk does not copy titles or summaries into analytics receipts.

## The stats dashboard

In TUI mode, `/prewalk stats` opens an interactive dashboard. It answers the
current question first: which session is this, is a run active, what has it
spent, and is an estimate available? Session titles are the primary labels;
stable IDs appear in the details view.

The dashboard puts the cost numbers in a fixed order. `Total paid` is the
provider-reported total. `Estimate based on` is the part of finished spending
with enough evidence for a comparison. `Estimated cost change` says whether
switching models may have cost less or more. The details screen puts the
estimated cost without switching beside the comparable amount actually paid,
so the relationship is visible without opening Help.

The dashboard order is:

1. Current session
2. This week
3. This month
4. All time
5. Recent sessions
6. `See N more sessions`, when older logged sessions exist

Use the arrow keys to select a row and Enter to open it. The full history shows
eight sessions at a time; Page Up and Page Down move through longer lists. `?`
explains the numbers, `R` refreshes, and Escape moves back one level before it
closes the dashboard. Selection stays on a visible session when refreshed.
The dashboard refreshes while it is open and shows the snapshot time.

## What the numbers mean

`/prewalk stats` starts with a snapshot of the exact current Pi session. It
shows active and finished Prewalk runs recorded in that session. Delegated child
sessions are excluded from this section; `/prewalk stats task` reports the whole
task tree.

An active run can show total paid, but its estimated cost change can change
until the run finishes. Historical comparisons use finished runs only.

Total paid is provider-reported cost captured for planner, executor,
helper, and compaction calls. The planner is the model selected in Pi before
handoff. The executor is the model that continues after handoff.

The estimated difference keeps the recorded primary token counts and prices the
executor's tokens at the planner's rates:

```text
planner-alone estimate
  = recorded planner primary-call cost
  + executor token usage repriced at planner rates

estimated difference
  = planner-alone estimate
  - recorded planner + executor primary-call cost
```

Positive values mean planner + executor calls cost less than the planner-alone
estimate. Negative values mean they cost more. Helper and compaction calls are
included in total paid but not in this comparison. This is not a separate
planner-only run or a measured benchmark.

Read the cost change as an estimate. `Up to` is the most the recorded token mix
suggests switching might have saved, not a measured amount. The calculation
prices the tokens the executor actually used, assuming the planner would have
used the same ones. A cheaper executor often needs more turns to reach the same
result, and every extra turn is then repriced at planner rates, so the estimate
leans high. The gap widens as the price ratio widens. Only an accepted
benchmark report, labelled `verified`, measures the difference instead of
estimating it.

Total paid and the estimated cost change cover different runs, so they are not
two halves of one ratio. Total paid counts every run in the period,
including runs that never handed off and runs with no usable pricing. The
difference only covers runs that could be compared. Each comparison therefore
states `Estimate based on $X of $Y`, and that $X figure is the one to read the
difference against. A small difference beside a large total usually
means narrow coverage rather than a poor result.

A call counts as planner work only while the run is still planning. Once the
executor takes over, later planner-model turns are recorded as helper spend
rather than planning, so selecting the planner again after a handoff does not
inflate the planner-alone baseline.

The dashboard labels mean:

- `Total paid` comes from Pi-reported usage and may include helper or
  compaction calls.
- `Estimate based on` is the finished spending with usable switching and price
  evidence.
- `Estimated cost without switching` reprices the comparable recorded work at
  the first model's rates; it is not a second run.
- `Estimated cost change` subtracts comparable actual cost from that estimate.
- `catalog estimate` uses the optional dated catalog fallback.
- `cannot compare` names the missing input, such as executor usage or model pricing.
- `finished before handoff` means planning ended without executor work, so
  there is no cost difference to estimate.
- `active` means the run has no finished receipt yet.
- `verified` is reserved for an accepted benchmark report.

Comparability follows the recorded evidence rather than how the run ended. A
run that was released, ended with its session, or was interrupted is still
compared when it recorded executor usage and pricing. Cancelled and failed runs
are not compared.

Receipts record the rates their estimate used. When a later Prewalk widens what
counts as comparable, those receipts are repriced from their own stored rates
instead of staying uncomparable. Receipts written before Prewalk stored rates
cannot be repriced and stay unavailable with `pricing-missing`.

A negative difference means planner + executor calls cost more than pricing the
recorded work at planner rates. The dashboard shows that directly.

## Commands

```text
/prewalk stats
/prewalk stats --successful
/prewalk stats receipt <run-id>
/prewalk stats task
/prewalk stats export <path>
/prewalk stats reset
/prewalk stats cleanup
/prewalk stats benchmark <summary.json>
```

`stats task` reports the root Pi session plus observed direct and nested child
cost across the task tree.
Direct child results can include input, output, cache-read, cache-write, and
cost. Nested summaries may contain exact cost without every token category, so
cost coverage can be complete while token coverage is not.

Public child receipts take precedence over parent summaries. Repeated finished
results are deduplicated. Missing asynchronous child evidence stays pending or
incomplete.

## Export and reset

Export creates a new JSONL file and refuses to overwrite an existing path.

Reset asks for confirmation, rotates to a new empty generation, and excludes an
active old-generation run from the new totals. If retired files cannot be
removed, `/prewalk stats cleanup` retries that deletion without rotating the
new ledger again.

Disabling analytics stops new collection but keeps existing receipts. It does
not change model routing.

## Recovering abandoned runs

A session that exits without shutting down cleanly leaves its run journal
unfinished. Prewalk finalizes its own session's leftover journals at startup.
A journal belonging to another session is only claimed after it has gone
untouched for twenty-four hours; concurrent sessions never finalize each
other's working runs. That wait is a heuristic, not a liveness check. If a
session is idle past it and then returns, the owning session reclaims the run
when it finalizes, because a recovered receipt is only replaced by one holding
strictly more evidence. Recovery can add a receipt that would otherwise be
lost; it cannot discard a fuller one.

A recovered run keeps the outcome its journal recorded and is otherwise
recorded as `interrupted`. Its estimate is priced from the model registry as it
stands at recovery, so `capturedAt` reflects the recovery rather than the run.

## Benchmark imports

Verified benchmark summaries are fingerprinted and stored separately from
personal receipts. They never enter lifetime, monthly, weekly, or session
totals. A benchmark result is `verified` only after the report contract accepts
it; installing Prewalk or running routine tests cannot create one.
