# Repository structure

Prewalk has one Pi entrypoint and one product tree. The entrypoint translates
Pi's public API; the modules under `src/` own policy and durable state.

```text
extensions/prewalk.ts
└── src/pi/create-prewalk-extension.ts
    └── src/pi/register-events.ts
        ├── src/orchestration/   one-run lifecycle and admission
        ├── src/turn/             todo and mutation proof
        ├── src/executor/         model selection, leases, and compaction
        ├── src/session/          audit, metadata, and reload recovery
        ├── src/analytics/        journals, receipts, accounting, reports, UI
        ├── src/config/           parsing, atomic writes, and configuration UI
        └── src/ui/               status formatting
```

`src/host-event-correlation.ts` remains a separate facts-only seam. It knows
about stock-Pi host observations, not Prewalk lifecycle policy. The Pi adapter
records claims before asynchronous work and applies the result only after the
existing run, mutation, todo, runtime, and post-`await` checks.

## Dependency direction

The public direction is:

```text
Pi ExtensionAPI → src/pi → orchestration → turn / executor / session / analytics
```

The adapter may use the product interfaces and host types. Product modules do
not import `extensions/prewalk.ts` or reach into the adapter's closure state.
Analytics owns active journals, pricing snapshots, queued writes, receipt
promotion, interrupted recovery, and child evidence behind
`PrewalkAnalytics`. Commands and tools receive those domain operations rather
than opening files or changing run phases themselves.

The package still declares exactly one extension. Child sessions load their own
adapter instance and therefore keep their own run, correlation, todo, runtime,
and analytics state. Prewalk does not schedule descendants or own a task queue.

Tests follow the same broad domains where moving them is mechanical:
`test/analytics`, `test/orchestration`, `test/turn`, `test/executor`,
`test/session`, `test/pi`, and `test/integration`. Benchmark and host-event
characterization suites remain at the test root where their existing harnesses
make that locality clearer.
