# Autoresearch: Prewalk optimization campaign

## Objective

Run three bounded, offline research tracks for Pi Prewalk and keep only
changes that improve a frozen score without weakening correctness or safety:

1. Calibrate the request-token estimate used by the context watchdog.
2. Improve automatic admission's substantial-work classifier.
3. Characterize the boundary between Prewalk and an extension that behaves like
   Autoresearch, especially extension-sourced messages and continuation ownership.

The campaign has a hard cumulative ceiling of 20 logged experiments. The
allocation is 8 context experiments, 6 admission experiments, and 6
composition experiments, including each segment's baseline.

## Metrics

### Context segment

- **Primary**: `weighted_error_ppm` (lower is better), using an asymmetric loss
  that penalizes underestimation eight times more than overestimation.
- **Secondary**: underestimation rate, p95 under/over tokens, and reserve-sized
  threshold mistakes.
- **Holdout**: `.auto/score-context.mjs --split=holdout` is never used to
  choose a candidate during the segment.

The accepted context candidate must have zero holdout threshold false negatives
and no more than three threshold false positives at the stock 200k-window
threshold. A tiny primary-metric win cannot buy an unsafe early or late
compaction decision.

The corpus contains only structural request features and provider-reported
token counts. It contains no prompt text, paths, credentials, or session IDs.

### Admission segment

- **Primary**: `weighted_error` (lower is better), with false negatives weighted
  five times more heavily than false positives.
- **Secondary**: false negatives, false positives, and exact accuracy.
- **Holdout**: score separately after the segment's candidate is selected.

The frozen policy admits only clearly substantial implementation work and
bypasses research, operations, configuration, negation, quoted examples, and
small isolated edits.

### Composition segment

- **Primary**: `lifecycle_violations` (lower is better; zero is required).
- **Secondary**: duplicate admission, duplicate continuation, stale recovery,
  and unfinished-run observations.

This segment must not move scheduler or campaign policy into
`src/host-event-correlation.ts`. The extension-source guard remains fail-closed
unless a reproduced integration test justifies a narrow replacement.

## How to Run

Set `AR_SEGMENT` to `context`, `admission`, or `composition`, then run:

```sh
./.auto/measure.sh
```

The context scorer needs Node's built-in TypeScript stripping:
`node --experimental-strip-types .auto/score-context.mjs`.

## Files in Scope

- `src/executor/context.ts` — context estimate and compaction threshold.
- `src/executor/context-pressure.ts` — only if evidence shows the pressure
  transaction, rather than the estimate, is defective.
- `src/orchestration/admission.ts` — automatic substantial-work classifier.
- `src/pi/register-events.ts` — only for a reproduced composition lifecycle
  defect; preserve existing run, mutation, todo, runtime, and post-await gates.
- `test/executor/executor-context.test.ts`,
  `test/orchestration/admission.test.ts`, and
  `test/integration/autoresearch-composition.test.ts` — characterization and
  regression tests.

## Off Limits

- Paid providers, authenticated canaries, and the frozen efficacy benchmark.
- `benchmark/corpus.json`, prompt digests, benchmark protocol, and evaluator
  logic.
- Credentials, session content, session HTML, `.pi-subagents/`, and live setup.
- `src/host-event-correlation.ts` for policy, scheduling, or campaign state.
- Weakening tests, changing the scorer to make a result pass, or broad regex
  expansion without a labeled safety case.

## Checks

`.auto/checks.sh` runs the focused suite and typecheck for the active segment.
The final repository validation is separate and includes the full test suite,
lint, link checking, RPC smoke tests, and pack dry-run.

## What's Been Tried

- Baseline context scoring shows a measurable but small positive residual in
  the content-free historical sample. Candidate safety margins must be judged
  on the frozen holdout and threshold mistakes, not training loss alone.
- Baseline admission scoring exposes a hyphenated `multiple-concerns` case and
  a direct `without changing` negation edge case. These are characterization
  evidence, not permission to generalize the classifier beyond the policy.
- Composition is currently a characterization track. Do not assume that
  Autoresearch's `agent_end` resume and Prewalk's `agent_settled` continuation
  can both remain active without an explicit integration contract.
