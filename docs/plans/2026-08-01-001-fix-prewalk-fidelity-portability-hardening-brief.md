---
title: Prewalk Fidelity and Portability Hardening - Brief
type: fix
date: 2026-08-01
topic: prewalk-fidelity-portability-hardening
artifact_contract: lock-in-brief/v1
artifact_readiness: draft
execution: code
---

# Prewalk Fidelity and Portability Hardening - Brief

## Outcome

Prewalk provides the closest practical behavioral representation of Oh My Pi's Prewalk flow on stock Pi public APIs. It works without `pi-codex-conversion`, context-mode, or another extension, while optional mutation adapters preserve the same successful-mutation handoff contract across other tool ecosystems.

The planner remains Pi's selected model. After the todo gate and first positively proven successful code mutation, the same live run routes to a configured same-provider/API executor. Planning guidance is removed, executor guidance is retained, and failure, cancellation, reload, and retry paths cannot leave stale provider ownership behind.

## Current behavior

- The provider composition is sound in the current load order: Conversion registers `openai-codex`, then Prewalk wraps its public `streamSimple` and delegates to it (`src/provider-overlay.ts`).
- Stock tools, direct `apply_patch`, shell patches, `exec_command`, and Code Mode `exec`/`wait` traces are normalized by `src/mutation.ts`.
- context-mode registers direct `ctx_*` tools and is optional; Conversion preserves non-owned active tools.
- Automatic assessment currently returns `prewalk-assess` without a run identifier, while `shouldExposePrompt()` removes every Prewalk prompt without one. The model can therefore lose the assessment instruction (`extensions/prewalk.ts`).
- A failed executor run can retain a stale overlay object. A later `/prewalk run` can reuse it instead of installing a fresh wrapper (`extensions/prewalk.ts`, `src/provider-overlay.ts`).
- Repository tests pin Pi `0.82.1` and Conversion `3.0.3`; the active installation is Pi `0.83.0` and Conversion `3.0.6`. The current Conversion test proves wrapper registration, not an executor request through the wrapper. The RPC smoke explicitly does not load Conversion.
- Conversion native Responses compaction is disabled in the active configuration. If enabled, its earlier compaction handler can serialize hidden Prewalk guidance and use the selected planner identity rather than the effective executor identity.
- Upstream OMP main at commit `80627462b4e91f46795ba87f3678174bd3c0b907` uses a host-owned temporary model switch and literal `edit`/`write` triggers. Stock Pi does not expose an equivalent ephemeral switch, and Conversion may remove those literal tools.

## Decisions

1. **Behavioral fidelity is authoritative.** Match OMP's observable ordering and lifecycle wherever stock Pi public APIs permit: planning guidance, todo gate, first successful mutation, complete-turn decision, one-way handoff for the active task, executor checklist, and explicit terminal states. Internal architecture need not match OMP when the required host API is unavailable.
2. **Stock Pi is the portability baseline.** Prewalk has no runtime dependency on Conversion, context-mode, pi-subagents, or another extension. Optional integrations are feature-detected and tested separately.
3. **Mutation fidelity is semantic, not name-based.** The trigger means the first positively proven successful code mutation after the todo gate. Stock `edit`/`write` establish the baseline; direct patches, shell patches, Code Mode, and future ecosystems qualify only through equivalent terminal success evidence.
4. **Mutation evidence has an adapter boundary.** Core normalization owns common stock shapes. Optional adapters may translate third-party tool events into the same evidence contract. Unknown or ambiguous tools never trigger by guesswork and produce bounded diagnostics when useful.
5. **Provider overlay remains the public-API handoff.** The selected planner and saved settings remain unchanged. Routing is limited to a configured executor with the same provider and Pi API. Unsupported cross-provider pairs fail before mutation; Prewalk does not simulate temporary switching with persistent `setModel()` calls.
6. **Failure is recoverable and ownership-safe.** Every terminal failure restores an owned overlay or discards stale ownership state. A retry creates and validates a fresh overlay against the current provider registration and current configuration.
7. **Automatic assessment is run-scoped.** Its hidden message carries explicit assessment identity and remains visible only during that assessment. Bypass, completion, cancel, and settlement remove it without affecting later tasks.
8. **Native Responses compaction is unsupported during an active Prewalk route in this unit.** Prewalk must fail closed or clearly disable/refuse that composition before hidden guidance or the wrong effective model can be compacted. Implementing executor-aware native replay is deferred.
9. **Compatibility claims are evidence-bound.** Core support is proved against stock Pi. Named optional integrations are claimed only after their own deterministic composition lane passes. Provider-backed canaries remain explicit, cost-gated, and outside routine verification.
10. **Prewalk does not authorize subagents or broaden verification.** Work and proof remain proportional to the user's deliverable.

## Scope

### In scope

- `src/mutation.ts` and a narrow mutation-adapter contract/module.
- `src/provider-overlay.ts` provider ownership and retry behavior.
- `extensions/prewalk.ts` automatic assessment identity, lifecycle cleanup, adapter wiring, compaction guard, and diagnostics.
- Focused tests under `test/` for core stock behavior and optional composition.
- `scripts/smoke-rpc.mjs`, `test/codex-conversion.test.ts`, package metadata, and README statements necessary to make compatibility evidence accurate.
- Documentation of the OMP baseline, intentional public-API deviations, optional integrations, and unsupported compositions.

### Out of scope

- A private Pi patch or new Pi host API.
- Cross-provider executor routing.
- Executor-aware native Responses compaction or replay.
- Guessing that arbitrary custom tools mutated files.
- Requiring or modifying context-mode, Conversion, pi-subagents, or OMP.
- Analytics redesign, benchmark claims, unrelated cleanup, broad repository audits, or provider spending.

## Acceptance criteria

1. Manual stock-Pi Prewalk preserves the selected planner, opens the todo gate only from valid success evidence, and hands off after the first positively proven successful mutation at the complete assistant-turn boundary.
2. Automatic assessment instructions survive effective-context transformation, are available only to the matching assessment, and are absent after bypass, cancel, completion, settlement, reload closure, or a later task.
3. Built-in `edit`/`write` and the existing supported patch paths normalize into one documented mutation-evidence contract. Failed, partial, cancelled, running, quoted, printed, dynamically constructed, or ambiguous activity does not trigger.
4. A third-party adapter can translate a tool result without importing that package into Prewalk core. Adapter absence leaves stock behavior unchanged. Duplicate or conflicting evidence cannot select more than one trigger.
5. Executor failure, abnormal stream termination, provider drift, cancellation, shutdown, and retry restore or discard only overlays Prewalk still owns. A retry uses current configuration and current provider registration.
6. Current supported Composition tests invoke the wrapped provider stream with a fake transport and prove planner request, executor request, model identity, reasoning, context filtering, terminal propagation, and selected-planner stability without a network call.
7. Stock-Pi tests run without Conversion or context-mode installed or loaded. Separate optional lanes cover the supported installed Conversion version and representative context-hook/tool preservation.
8. Routine RPC smoke uses the declared supported Pi executable and reports exactly which optional extensions were loaded. README claims match what the smoke and tests actually prove.
9. While a Prewalk run is active, unsupported native Responses compaction fails closed before remote serialization. Normal Pi compaction continues to exclude ephemeral planning/assessment guidance while retaining required executor guidance.
10. No implementation path persists hidden planning guidance, changes Pi saved model/thinking defaults, authorizes subagents, or invents broader verification work.

## Implementation units

### U1. Characterize fidelity and define mutation evidence

- Record the OMP-observable baseline and local intentional deviations in tests and documentation.
- Extract a small, package-agnostic mutation-evidence adapter contract from the current detector without weakening existing positive-proof rules.
- Keep stock shapes in core and route Conversion-shaped Code Mode traces through an optional adapter or adapter-compatible normalizer.

### U2. Repair assessment and provider lifecycle

- Give automatic assessment messages explicit run-scoped identity and correct context/compaction visibility.
- Make failure teardown ownership-safe and make every retry construct a fresh overlay.
- Add lifecycle coverage for failure, drift, cancel, reload, shutdown, changed configuration, and successful retry.

### U3. Harden optional composition and compaction boundaries

- Add deterministic Conversion composition tests against the supported installed dependency version without provider calls.
- Verify context-mode-style late tool registration and context injection remain preserved without making context-mode a dependency.
- Refuse active-run native Responses compaction until an executor-aware design exists.

### U4. Align verification and documentation

- Update package compatibility metadata only to versions actually exercised.
- Make RPC smoke optionally load Conversion first and report the real loaded version; preserve a stock-only lane.
- Correct README compatibility, tool-trigger, compaction, and verification claims.

## Execution

- [x] U1: Characterize fidelity and define mutation evidence. Exported a fail-closed optional adapter contract; focused mutation tests passed.
- [x] U2: Repair assessment and provider lifecycle. Automatic assessment now has run-scoped identity and terminal failure releases the owned overlay; focused extension tests passed.
- [x] U3: Harden optional composition and compaction boundaries. Prewalk now refuses to arm when the optional Conversion config enables native Responses compaction, before the unsafe hook-order composition can begin.
- [x] U4: Align verification and documentation. Corrected the README's actual stock-RPC/Conversion-test guarantees; `npm run typecheck` and focused mutation/extension tests passed.

## Verification

Focused proof only:

- Mutation adapter and coordinator tests for stock `edit`/`write`, direct patch, shell patch, async completion, failure, ambiguity, ordering, and one-shot selection.
- Extension tests for automatic assessment context visibility and terminal cleanup.
- Provider-overlay tests for executor routing, terminal events, drift, teardown, changed configuration, and retry.
- Agent-loop test with stock Pi and fake provider streams.
- Optional Conversion composition test using the declared supported version and a fake/no-network transport.
- RPC smoke in stock-only and Conversion-loaded modes, asserting selected planner and settings bytes remain unchanged.
- Focused lint and typecheck for changed files/package.

A real provider canary is not required for implementation acceptance. If run later, it must require explicit cost confirmation and use the configured executor rather than a hard-coded model.

## Known risks

- The working tree already contains unrelated modifications; implementation must preserve and distinguish them.
- Pi and Conversion public event/detail shapes can drift; adapters must fail closed and compatibility metadata must not overclaim.
- Tool registration and provider wrapping are load-order-sensitive; ownership checks must remain identity-based.
- Refusing native compaction during an active route is less convenient but safer than leaking hidden guidance or compacting under the wrong model identity.
- Semantic mutation proof cannot cover opaque third-party tools without cooperation from an adapter.

## Open blockers

None for the proposed scope. Cross-provider routing and executor-aware native compaction require separate architectural decisions.

## Primary references

- [OMP Prewalk coordinator](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/coding-agent/src/session/prewalk.ts)
- [OMP Prewalk tests](https://github.com/can1357/oh-my-pi/blob/80627462b4e91f46795ba87f3678174bd3c0b907/packages/coding-agent/test/agent-session-prewalk.test.ts)
- [Conversion provider implementation](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/main/packages/pi-codex-conversion/src/providers/openai-codex-custom-provider.ts)
- [Conversion Code Mode provider](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/main/packages/pi-codex-conversion/src/providers/code-mode-proxy-provider.ts)
- `docs/plans/2026-07-31-001-fix-right-size-automatic-prewalk-plan.md`
- `src/core.ts`, `src/mutation.ts`, `src/provider-overlay.ts`, and `extensions/prewalk.ts`

## Approval

**Status:** Approved

Approval date: 2026-08-01.
