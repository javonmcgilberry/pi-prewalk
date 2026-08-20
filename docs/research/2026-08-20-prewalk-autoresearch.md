# Prewalk Autoresearch campaign

Date: 2026-08-20

This was a bounded offline optimization campaign for three Prewalk seams:
context estimation, automatic admission, and composition with an extension that
behaves like Autoresearch. The campaign allowed at most 20 experiments. It
used 9: five context candidates, two admission candidates, and two composition
checks. The remaining budget was intentionally unused after the useful paths
converged.

The interactive `pi-autoresearch` tools were not exposed in this API session.
The work therefore used the same `.auto/` prompt, measurement, checks, config,
and JSONL result format, with manual keep/discard decisions and no automatic
commit or revert. The log records the experiments and their evidence. No paid
provider request was made.

## Context estimation

The corpus was extracted from 270 local session JSONL files. The extractor
found 40,267 candidate assistant-to-assistant request pairs and retained 4,096
content-free structural rows. The committed corpus contains API/provider/model
labels, message counts and estimated trailing sizes, prior usage totals, and the
next request's provider-reported input token count. It does not contain prompt
text, paths, credentials, session IDs, or raw responses.

Corpus digest:

```text
8e291ab75282e657e289d2e51307120b929f98768993fc39fde46eaebab002ad
```

The frozen file's SHA-256 is
`4d870f2d54e3c077ead58996f5ce3a26b43beb5814b5ace9d4baf1a347fc2a77`.

The primary score is an asymmetric normalized error in parts per million. An
underestimate costs eight times an overestimate because a missed pressure event
is more dangerous than a modest early compaction. The holdout was not used to
choose a candidate during the loop. Threshold counts use the stock 200k model
window minus Pi's 16,384-token reserve, or 183,616 tokens.

| Added margin | Optimization error | Holdout error | Holdout threshold false negatives | Optimization threshold false positives |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 13,612 | 19,523 | 1 | 1 |
| 128 | 10,498 | 16,207 | 0 | 1 |
| 256 | 9,559 | 14,836 | 0 | 3 |
| **384** | **9,286** | 14,356 | **0** | **3** |
| 512 | 9,404 | **14,294** | **0** | 5 |

The selected 384-token margin is a compromise, not a claim about every
provider tokenizer. It had the best optimization score among candidates within
the safety cap, zero threshold misses on both splits, and fewer threshold
false positives than the 512-token candidate. The 512-token holdout difference
was only 60 ppm and its optimization score was worse.

Changed code:

- `src/executor/context.ts` adds `CONTEXT_ESTIMATE_SAFETY_MARGIN = 384` to
  request estimates before the provider-side pressure check.
- `test/executor/executor-context.test.ts` pins the selected margin while
  retaining the existing context and threshold cases.

## Automatic admission

The admission corpus contains 48 synthetic, policy-labeled requests: 24 train,
12 validation, and 12 holdout. Its policy is narrow: admit clearly substantial
implementation work, and bypass research, setup, operations, configuration,
negation, quoted examples, and small isolated edits.

| Candidate | Optimization weighted error | Holdout weighted error | Result |
| --- | ---: | ---: | --- |
| Existing classifier | 5 | 1 | One hyphenated substantial-work miss and one direct negation false positive |
| Lexical edge-case fix | 0 | 0 | Kept |

The kept change is intentionally small:

- `multiple-concerns` now matches the existing `multiple concerns` substantial
  marker.
- Negated forms such as `without changing`, `without modifying`, and
  `without writing` now remain fail-closed like the existing `without change`
  cases.

The focused admission suite grew from 14 to 16 cases. It passes the frozen
corpus on both optimization and holdout splits.

## Prewalk and Autoresearch composition

The composition track did not change production scheduling or host-event
correlation. It added a real stock-Pi agent-loop test with a fixture extension
that sends an Autoresearch-shaped follow-up using `sendUserMessage(...,
{ deliverAs: "followUp" })` while Prewalk automatic mode is enabled.

The existing extension-source guard produced one provider turn, no
`prewalk_assess` entry, and zero lifecycle violations. A deliberately invalid
candidate removed that guard. The test then persisted `prewalk_assess` for the
extension message and failed, so the candidate was rolled back.

This is characterization evidence, not proof that unattended Autoresearch and
Prewalk can share all continuation and compaction responsibilities. A future
bridge still needs explicit ownership for `agent_end`, `agent_settled`,
compaction recovery, `maxIterations`, cancellation, and keep/discard
operations. No policy was added to `src/host-event-correlation.ts`.

## Files and reproducibility

The experiment assets are under `.auto/`:

- `prompt.md` defines scope, metrics, safety gates, and off-limits files.
- `measure.sh` runs the active segment scorer.
- `checks.sh` runs the focused tests and typecheck.
- `context-calibration.json` and `admission-corpus.json` are the frozen
  content-free inputs.
- `log.jsonl` records all 9 experiments.

The final repository checks remain separate from this campaign. The local
analytics estimates in the README are not part of these measurements, and the
paid directional benchmark in `benchmark/README.md` remains unrun and
approval-gated.
