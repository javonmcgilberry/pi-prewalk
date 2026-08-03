# Local analytics

Prewalk keeps one local receipt for each terminal run. Receipts live under the
Pi agent directory at `prewalk/analytics` and contain only allowlisted metadata.

## What the numbers mean

Actual spend is the sum of usage and cost attributed by Pi. Estimated savings
compare the planner's reported actual cost with the counterfactual cost of
running that planner usage at the executor's rate.

The labels matter:

- `actual` comes from Pi-reported usage.
- `estimated` uses pricing attached to the active model.
- `catalog-estimated` uses the optional dated catalog fallback.
- `unavailable` means the evidence was not good enough to calculate a value.
- `unfinished` means the run has no terminal receipt.
- `verified` is reserved for an accepted benchmark report.

A negative estimate means the executor would have cost more. Prewalk shows that
as estimated extra cost instead of hiding it.

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

`stats task` reports the root run plus observed direct and nested child cost.
Direct child results can include input, output, cache-read, cache-write, and
cost. Nested summaries may contain exact cost without every token category, so
cost coverage can be complete while token coverage is not.

Public child receipts take precedence over parent summaries. Repeated terminal
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
