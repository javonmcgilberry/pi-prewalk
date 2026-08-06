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

The dashboard order is:

1. Current session
2. This week
3. This month
4. All time
5. Recent sessions

Use the arrow keys to select a session, Enter for details, `?` for the cost
explanation, `R` to refresh, and Escape to close. The dashboard refreshes while
it is open and shows the snapshot time.

## What the numbers mean

`/prewalk stats` starts with a snapshot of the exact current Pi session. It
shows active and finished Prewalk runs recorded in that session. Delegated child
sessions are excluded from this section; `/prewalk stats task` reports the whole
task tree.

An active run can report actual spend, but its planner-alone price comparison is
not final. Historical comparisons use finished runs only.

Actual spend is provider-reported cost for planner, executor, helper, and
compaction calls. The planner is the model selected in Pi before handoff. The
executor is the model that continues after handoff.

A planner-alone price comparison keeps the recorded token counts but prices the
executor's tokens at the planner's rates:

```text
planner-alone estimate
  = actual planner cost
  + executor token usage repriced at planner rates

difference
  = planner-alone estimate
  - actual planner + executor call cost
```

Positive values mean planner + executor calls cost less than the planner-alone
estimate. Negative values mean they cost more. Helper and compaction calls are
included in actual spend but not in this comparison. This is not a separate
planner-only run or a measured benchmark.

The labels matter:

- `actual spend` comes from Pi-reported usage.
- `price comparison` uses pricing attached to the active model.
- `catalog price comparison` uses the optional dated catalog fallback.
- `cannot compare` names the missing input, such as executor usage or model pricing.
- `no executor handoff` means planning finished without executor work, so there is no cost difference to estimate.
- `active` means the run has no finished receipt yet.
- `verified` is reserved for an accepted benchmark report.

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

## Benchmark imports

Verified benchmark summaries are fingerprinted and stored separately from
personal receipts. They never enter lifetime, monthly, weekly, or session
totals. A benchmark result is `verified` only after the report contract accepts
it; installing Prewalk or running routine tests cannot create one.
