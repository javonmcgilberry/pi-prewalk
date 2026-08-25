---
title: Stabilize Prewalk Compaction Authority - Plan
type: fix
date: 2026-08-25
topic: prewalk-compaction-authority
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

# Stabilize Prewalk Compaction Authority - Plan

## Goal Capsule

- **Objective:** Stop Prewalk from falsely treating provider-visible context as oversized because extension-only metadata was serialized into the estimate, and ensure a successful executor stream ends the current retry sequence.
- **Product authority:** Pi 0.84.3 remains the host behavior being adapted. This stabilization keeps Prewalk's current pressure controller until a released Pi contract proves proactive admission and overflow recovery can move into Pi.
- **Open blockers:** None for the scoped Prewalk fix. Pi source changes, controller removal, and live application are deferred.

## Product Contract

### Summary

Prewalk may protect planner and executor requests before transport while Pi 0.84.3 remains the runtime. Its estimate must follow provider-visible message content rather than arbitrary extension metadata, and one successful exact executor stream must clear only that run's completed retry state. Stale, unmatched, cancelled, and failed observations must retain their existing protections.

### Problem Frame

Pi's context event exposes host `AgentMessage` values that can carry extension details such as Code Mode traces. Prewalk's old fallback estimated `JSON.stringify(messages)`, so non-provider metadata could cross the pressure threshold and request compaction for a request the provider would accept. Separately, the pressure controller retained its one-retry marker after a successful executor stream, causing a later independent pressure sequence in the same run to fail as if it were the retry.

### Key Decisions

- **Provider-shaped accounting:** Convert host messages through Pi's `convertToLlm` path and reuse Prewalk's `estimateRequestTokens`; details metadata is not request context, while visible text and tool content remain counted.
- **Exact stream lifecycle:** Record every attributed current-run executor assistant stream at `message_start`; clear the matching retry state only at its successful `message_end`. Errors clear the in-flight marker and preserve failure handling.
- **Existing authority remains:** `ContextPressureController` still owns Prewalk's pressure, compaction, retry, cancellation, stale-run, and observer-error behavior for this release.
- **No broad rewrite:** Preserve planner filtering, host correlation, model restoration, analytics, strict `>` thresholds, the 384-token margin, and one-retry/no-loop behavior outside the reported regression.
- **Staged migration:** Characterize real released-Pi behavior first. A later plan may move proactive admission and overflow retry into Pi only after the host contract is released and tested.

### Requirements

**Request estimation**

- R1. The context-event estimator must count the provider-shaped message content that Pi will send, not serialized extension `details` or other host-only fields.
- R2. The estimator must reuse the existing request-estimation margin and visible-content rules rather than introduce a second token heuristic.
- R3. Visible oversized content must still trigger the existing pressure path, with the existing strict threshold and reserve policy.

**Executor lifecycle**

- R4. Every attributed assistant stream from the configured executor in the current run must be tracked from `message_start` through terminal `message_end`.
- R5. A successful matching executor stream must clear that run's completed executor retry marker so a later pressure event starts a new bounded sequence.
- R6. Failed, aborted, stale, unmatched, or model-mismatched events must not clear unrelated retry or failure state, activate the executor, complete handoff, or bypass correlation guards.

**Compaction safety**

- R7. Existing planner and executor compaction success, failure, cancellation, observer-error, stale-terminal, model-restoration, and one-retry behavior must remain unchanged except for the corrected retry reset.
- R8. A metadata-only false positive must not request compaction or emit `executor-compaction-failed`.
- R9. A real pressure event must retain exactly one compaction/retry consequence and must not loop.

**Verification and boundaries**

- R10. Regression tests must cover metadata-only and visible-content pressure, plus a later executor pressure cycle after a successful retry.
- R11. The full affected integration module must pass, alongside focused pressure/correlation tests, typecheck, lint, link checks, the full suite, packaging, and edited-file diagnostics.
- R12. This change must not patch `~/Developer/pi`, remove `ContextPressureController`, depend on unpublished Pi behavior, or alter unrelated existing work in the dirty checkout.

### Key Flows

1. **Metadata-only request:** Pi emits a context event containing a tool result with a large `details` trace but small visible content; Prewalk estimates the converted message, delegates normally, and records no compaction.
2. **Visible pressure:** Pi emits a context event whose visible user/tool content crosses the executor threshold; Prewalk keeps its existing pressure and compaction sequence.
3. **Successful retry:** The executor compacts and retries; the successful executor stream is observed and clears the sequence; a later oversized request may request one new compaction.
4. **Stale or failed event:** An old, mismatched, aborted, or failed event cannot clear state or complete handoff, and existing failure/correlation handling remains authoritative.

### Acceptance Examples

- AE1. A Code Mode trace in `toolResult.details` does not cause executor compaction when visible content is small.
- AE2. A large visible user message still causes one executor compaction and the existing retry behavior.
- AE3. After a successful active executor retry, a second independent pressure event requests a second compaction instead of emitting `executor-compaction-failed` immediately.
- AE4. A second oversized retry in the same pressure sequence still fails closed after the existing one-retry limit.
- AE5. The full integration module passes without changing unrelated status, analytics, routing, todo, or restoration contracts.

### Scope Boundaries

**In scope**

- `src/pi/register-events.ts` context estimation and exact executor stream lifecycle.
- Regression fixtures and the test harness's matching provider-shaped estimate.
- Focused and repository-required validation.

**Deferred**

- Pi core changes, native proactive admission, and native overflow retry.
- Removal or redesign of `ContextPressureController`.
- Authenticated provider canaries, publication, live setup application, and checkout consolidation.

**Outside this fix**

- Unrelated status/footer, package, configuration, or anti-slop changes already present in the working tree.
- Changes to host-event correlation policy, planner prompting, model selection, analytics semantics, or child execution profiles.

### Dependencies and Assumptions

- Pi 0.84.3 exposes `convertToLlm` and context/message lifecycle events through the installed public packages.
- `estimateRequestTokens` remains the single Prewalk request-estimation implementation and retains its 384-token safety margin.
- Host correlation continues to provide exact run/epoch attribution; the extension does not add a second correlation map.
- A successful stream is defined by a non-error, non-aborted matching assistant terminal message.

### Sources

- `src/pi/register-events.ts`
- `src/executor/context.ts`
- `src/executor/context-pressure.ts`
- `test/integration/extension.test.ts`
- `test/executor/executor-context.test.ts`
- `test/host-event-correlation.test.ts`
- `docs/architecture/host-event-correlation.md`
