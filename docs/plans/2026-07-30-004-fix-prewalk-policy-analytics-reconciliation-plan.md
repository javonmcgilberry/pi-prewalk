---
title: Reconcile Prewalk Planner Authority, Analytics, and Subagent Policy
type: fix
date: 2026-07-30
topic: prewalk-policy-analytics-reconciliation
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Reconcile Prewalk Planner Authority, Analytics, and Subagent Policy

## Goal Capsule

- **Objective:** Make Pi's selected runtime model and reasoning authoritative for every new Prewalk epoch, finish the observation-only analytics work from Plan 003, and add a separate pi-subagents execution-profile ceiling that prevents expensive planner-profile fan-out.
- **Authority order:** The Pi runtime owns the planner profile. The active Prewalk epoch snapshots the selected model and initial reasoning, follows Pi reasoning changes until handoff, and supplies executor defaults. pi-subagents enforces the accepted inherited and dynamic execution-profile ceilings before any child launch.
- **Execution order:** Correct Plan 002 and its implementation first, complete Plan 003 analytics second, then add the separate launch-policy contract.
- **Compatibility boundary:** Prewalk remains independently installable, the Pi setup continues to pin it as a Git submodule, and neither extension imports or requires the other.
- **Failure boundary:** If an active ceiling cannot resolve an authenticated, supported child profile below the planner, pi-subagents rejects the launch before creating child artifacts, sessions, processes, or provider requests.
- **Tail ownership:** This plan ends with one combined correctness and reliability review, one consolidated fix pass, and final comprehensive verification. It does not commit, push, publish, or open a pull request.

---

## Product Contract

> **Product Contract preservation:** This plan changes the configured-planner requirements in Plan 002 because they conflict with the session-settled Pi-authority decision. It preserves Plan 002's OMP prompt, coordinator, handoff, standalone, provider-composition, and compaction intent. It preserves Plan 003's analytics requirements while repairing incomplete delegation and cleanup behavior. The execution-profile ceiling is a separate launch-control contract and does not add policy fields to analytics events.

### Summary

Prewalk must treat the model and reasoning already selected in Pi as the planner for each new epoch. Prewalk configuration owns the executor model and executor reasoning only. The executor inherits the same session after the OMP handoff gate, while Pi's selected model remains unchanged.

Analytics observes that lifecycle without choosing models or changing routing. Session receipts remain useful when pi-subagents is absent. When pi-subagents is present, its versioned content-free delegation projection supplies direct and nested child identity, lifecycle, and child-only usage evidence for task-tree reporting.

Launch control is separate from analytics. During an active Prewalk epoch, pi-subagents requests a versioned execution-profile policy through Pi's public in-process event bus, intersects it with any inherited ceiling, resolves the child profile centrally, and propagates the accepted snapshot to descendants.

### Problem Frame

The current Prewalk configuration persists a planner and refuses to arm unless Pi has already selected that configured model. This reverses the intended authority: changing Pi's model should change the next epoch's planner without rewriting Prewalk configuration.

Plan 003 added most of the local analytics implementation, but its final review and fix pass were interrupted. Foreground delegation starts are emitted after completion, foreground state is not durably replayed, nested events are rejected by the real Prewalk integration while tests bypass that boundary, reset can report success with cleanup outstanding, and task-tree coverage can hide unresolved overlap.

pi-subagents currently has no model-and-reasoning ceiling tied to an active Prewalk epoch. A child that omits a model override may inherit the planner model and use an equal or higher reasoning level. Existing capability ceilings constrain tools, not execution profiles.

### Actors

- A1. **Pi user:** Selects the planner model and reasoning, configures Prewalk's executor defaults, and expects delegated work to respect the cheaper execution boundary.
- A2. **Pi host:** Owns selected model and reasoning, supported model metadata, authentication, lifecycle events, and the public extension event bus.
- A3. **Prewalk:** Snapshots the planner profile per epoch, performs the OMP-faithful handoff, records local analytics, and optionally answers execution-policy requests while its epoch is active.
- A4. **pi-subagents:** Publishes delegation analytics, requests and enforces execution-profile policy, launches children, and propagates accepted ceilings.
- A5. **Child and descendant agents:** Run with an effective profile that satisfies every inherited and active ceiling.

### Key Decisions

- **Pi's live runtime profile owns the planner.** (session-settled: user-directed - chosen over a persisted Prewalk planner: Shift+Tab and explicit Pi model changes must govern the next epoch without duplicate configuration.) Governs R1 through R5.
- **Prewalk remains a standalone pinned submodule.** (session-settled: user-approved - chosen over folding it into the Pi setup repository: independent installation and history are explicit prerequisites.) Governs R6, R7, R20, and R21.
- **OMP remains the coordinator authority.** (session-settled: user-directed - chosen over a broader Prewalk orchestration layer: only stock Pi extension-boundary adaptations are allowed.) Governs R6 through R9.
- **Analytics observes and launch policy controls.** (session-settled: user-directed - chosen over extending delegation analytics with policy fields: cost evidence and authorization have different lifecycle and trust boundaries.) Governs R10 through R19.
- **Timeouts do not substitute for protocol correctness.** (session-settled: user-approved - chosen over suite serialization and widened retry windows: deterministic synchronization and public lifecycle evidence must prove the behavior.) Governs R22 and R23.

### Requirements

**Planner and handoff authority**

- R1. A new Prewalk epoch must snapshot Pi's currently selected model and reasoning as its initial planner profile. The planner model remains fixed for that epoch unless a model change cancels it.
- R2. Persisted Prewalk configuration must contain enabled state, executor model, executor reasoning, analytics configuration, and any approved reset profile, but no planner selection.
- R3. Before handoff, Shift+Tab must remain Pi's normal planner-reasoning control and update the epoch's current planner reasoning. After handoff, Prewalk must consume Shift+Tab and cycle only the active epoch's executor reasoning. Shift+Tab must never change a model.
- R4. An explicit Pi model change may cancel an active epoch, but the next epoch must derive its planner from the newly selected runtime model.
- R5. Status, audit records, receipts, reload state, and provider routing must use the epoch's host-owned planner state rather than a persisted planner. Reload restores routing only when the selected model and current planner reasoning match the latest valid epoch record.

**OMP fidelity and standalone operation**

- R6. OMP revision `4df68d60438423b384b2b47fb3d6835641624757` remains authoritative for prompt bytes, todo gating, bounded continuation, first-mutation handoff, and one-way executor activation.
- R7. Stock Pi with no Codex Conversion extension must support the normal Prewalk flow. Optional provider composition must use public registration surfaces and must not become a runtime dependency.
- R8. Handoff and compaction filtering must remove only the planning nudge. Continuation and executor-checklist history remain eligible for normal context and compaction behavior.
- R9. The compact footer must contain only planner and executor labels, reasoning, effective side, and one short state clause. Delegation and analytics details belong in explicit status and stats commands.

**Analytics completion**

- R10. Analytics must remain observation-only: it must not select a model, change reasoning, route a request, create a provider request, or delay the provider stream.
- R11. Reset must rotate to a clean generation immediately, preserve retryable cleanup state when prior managed artifacts remain, and report incomplete cleanup until verification succeeds.
- R12. Task-tree aggregation must deduplicate only matching usage-slice evidence keys and must label pending, fallback-backed, overlap-unresolved, unsupported, and incomplete coverage explicitly.
- R13. Prewalk must consume delegation evidence only through the versioned public event projection. Its real event listener must accept authenticated direct and nested descendants across parallel and successive invocations without tests writing evidence directly into storage.
- R14. pi-subagents must publish foreground start before completion, child-only progress and terminal evidence, and durable active or terminal replay across reload for foreground and asynchronous launches. Later same-lineage evidence may add identity or usage but must not regress lifecycle certainty or replace a known child identity.
- R15. Delegation analytics must remain additive, content-free, independent of launch control, and behaviorally invisible when no consumer is installed.

**Execution-profile policy**

- R16. pi-subagents must define a strict versioned before-spawn execution-profile contract over Pi's public in-process event bus. Absent responders preserve existing pi-subagents behavior.
- R17. An active Prewalk epoch must answer policy requests with its immutable planner identity, executor default, allowed model set, maximum reasoning, epoch identity, and source. Prewalk must not import pi-subagents.
- R18. pi-subagents must intersect every dynamic response with the inherited accepted ceiling, choose the Prewalk executor profile by default, reject the exact planner model-and-reasoning tuple, and allow explicit overrides only when they narrow the accepted policy.
- R19. Policy resolution must happen before fallback selection and before any artifact, session, child process, or provider request. If no authenticated supported profile satisfies the ceiling, the launch must fail with an actionable error and must not choose an arbitrary model.
- R20. Foreground, asynchronous, parallel, chain, dynamic-fanout, Delegation v1/v2, resumed, recovered, and nested launches must use the same central resolution. Descendants must inherit the accepted snapshot and cannot regain a broader profile.
- R21. Prewalk-only and pi-subagents-only operation must retain existing behavior. Reload must not revive a stale Prewalk epoch, while resume of an existing child must retain the ceiling accepted for that child.

**Reliability and scope**

- R22. Keep deterministic condition-based test synchronization. Remove broad integration-suite serialization, unjustified timeout inflation, the broad quiet-child polling window, and the unrelated production startup retry-window increase.
- R23. Preserve existing dirty work and the staged Prewalk submodule architecture. Do not modify installed package caches, generated files, or manually maintained changelog output.
- R24. Keep all work local and unpublished unless the user separately authorizes staging, commit, push, publication, or a pull request.

### Key Flows

- F1. **Start an epoch**
  - **Trigger:** A live Pi session arms Prewalk.
  - **Actors:** A1, A2, A3
  - **Steps:** Prewalk reads executor defaults, snapshots `ctx.model` and initial `ctx.thinkingLevel`, follows Pi-owned reasoning changes before handoff, validates the executor independently, and opens the run and analytics journal.
  - **Outcome:** Every run record names the actual planner selected in Pi at that moment.

- F2. **Handoff without changing Pi selection**
  - **Trigger:** The OMP todo gate is open and the planner completes the first eligible mutation.
  - **Actors:** A2, A3
  - **Steps:** Prewalk removes only the planning nudge, activates the executor route at the public provider seam, retains continuation and checklist history, and leaves Pi's selected model untouched.
  - **Outcome:** The executor continues the same session with its configured reasoning.

- F3. **Observe a delegated task tree**
  - **Trigger:** pi-subagents starts, updates, or finishes a child.
  - **Actors:** A3, A4, A5
  - **Steps:** pi-subagents publishes versioned content-free lineage and child-only usage evidence; Prewalk validates and journals it; task-tree reporting joins receipts and matching fallback slices.
  - **Outcome:** Totals are complete only when evidence proves completeness, with unresolved coverage visible.

- F4. **Constrain a child launch**
  - **Trigger:** pi-subagents is about to resolve a child model and reasoning while a Prewalk epoch is active.
  - **Actors:** A2, A3, A4
  - **Steps:** pi-subagents emits a synchronous versioned policy request, validates every response, intersects responses with inherited policy, resolves one allowed authenticated profile, and records the accepted snapshot in launch context.
  - **Outcome:** No child provider request can use the forbidden planner tuple.

- F5. **Propagate and restore policy**
  - **Trigger:** A constrained child launches a nested child or resumes after reload.
  - **Actors:** A3, A4, A5
  - **Steps:** pi-subagents decodes the inherited snapshot, intersects any active local response, persists the accepted identity with recovery state, and rejects stale or broader data.
  - **Outcome:** Nested and resumed work cannot escape the root ceiling.

### Acceptance Examples

- AE1. Given Pi is using Sol at high reasoning and Prewalk is configured for Luna at low reasoning, when a new epoch starts, then the run records Sol/high as its initial planner and Luna/low as executor without a planner field in configuration.
- AE2. Given the executor is not active, when the user presses Shift+Tab, then Pi changes planner reasoning normally. Given the executor is active, the same input changes only executor reasoning.
- AE3. Given stock Pi has no Codex Conversion registration, when Prewalk arms and hands off, then the executor request succeeds through the stock provider.
- AE4. Given a continuation and executor checklist exist, when handoff and later compaction occur, then only the planning nudge is excluded.
- AE5. Given a foreground child is still running, when a consumer subscribes, then it receives a start event before any terminal event. After reload, it receives the current replayed state.
- AE6. Given a nested child's parent differs from the root invocation parent, when its authenticated event arrives, then Prewalk accepts its lineage without a direct analytics-store write.
- AE7. Given a partial reset deletion failure, when reset returns, then new-generation reports exclude old data and the command says cleanup is incomplete with retry guidance.
- AE8. Given Sol/high is the planner and an ordinary child omits overrides, when pi-subagents resolves the launch, then it selects Luna/low or rejects before any provider request.
- AE9. Given an explicit child override exceeds the ceiling, when the launch is requested, then it fails before artifacts or processes exist. A permitted lower reasoning override succeeds.
- AE10. Given a constrained child launches a nested child, when the descendant omits overrides, then the inherited root ceiling still applies.
- AE11. Given Prewalk is absent, when pi-subagents launches a child, then its existing model and reasoning behavior is unchanged.

### Scope Boundaries

**In scope**

- Updating Plan 002 and Plan 003 where their written contracts conflict with the settled authority and verified implementation gaps.
- Replacing the unreleased planner-bearing Prewalk configuration without backwards compatibility.
- Completing the current analytics implementation and public delegation projection.
- Adding the separate versioned execution-profile policy through supported public APIs.
- Keeping the existing Pi submodule integration and deterministic condition-wait improvement.

**Deferred to Follow-Up Work**

- General cost-ranking across arbitrary model providers.
- Cross-provider Prewalk routing.
- A public release, migration guide, or compatibility parser for unreleased planner-bearing configuration.
- Broader pi-subagents reliability work not required by these contracts.

**Outside this product's identity**

- Patching Pi binaries, installed npm package caches, private runtime imports, or generated output.
- Using delegation analytics as an authorization channel.
- Choosing an arbitrary cheaper model when policy cannot prove an allowed profile.
- Global test serialization as a substitute for concurrency correctness.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Construct a host-owned epoch profile.** Build the run from Pi's selected model and initial reasoning plus the persisted executor defaults. Keep the planner model fixed, update current planner reasoning only from Pi's pre-handoff reasoning event, and carry both through audit, status, reload, provider, and analytics records. Configuration parsing rejects the old planner-bearing shape rather than carrying a fallback. Governs R1 through R5.
- KTD2. **Keep OMP adaptation narrow.** Preserve prompt bytes and coordinator transitions. Context and compaction projection distinguish the planning nudge from continuation and checklist messages, and stock provider fallback remains the default lane. Governs R6 through R9.
- KTD3. **Authenticate a delegation tree, not one immediate parent.** Prewalk keeps a bounded invocation registry, establishes each root invocation and accepted delegation run, then validates descendant parent-child continuity and stable child identities across replay rather than requiring every event's parent to equal the root parent. Out-of-order descendants remain pending until an admitted parent appears. Governs R13 and R14.
- KTD4. **Persist foreground and async projection uniformly.** pi-subagents publishes start at launch time and stores current projection state in a content-free durable record that both foreground and async reload paths can replay. A later same-lineage record may add child identity, usage, or stronger terminal certainty when its observation is newer, but cannot regress lifecycle or replace a known identity. Governs R12 through R15.
- KTD5. **Use a separate synchronous event-bus policy request.** pi-subagents emits `pi-subagents:execution-profile-policy:request:v1` with a version, unique request ID, session and launch identity, and an owned `respond(source, policy)` collector callback. The collector accepts at most one response per validated source and at most 16 responses while `EventBus.emit()` is on the stack, closes immediately when `emit()` returns, rejects late or duplicate responses, sorts accepted responses by source before deterministic intersection, and treats no response as no dynamic ceiling. Prewalk registers through public `events.on()`, retains the returned disposer, answers only for the matching active epoch, and disposes the handler on extension reload or shutdown. Any malformed response fails the launch closed. The wire contract contains no task text or analytics fields. Governs R16 and R17.
- KTD6. **Represent policy as explicit allowed profiles.** The accepted snapshot contains the planner tuple, a default child profile, an allowlist of provider/model profiles with maximum reasoning, source, epoch, and version. The initial Prewalk response allows its configured executor and lower supported reasoning only. This avoids speculative price comparison. Governs R18 and R19.
- KTD7. **Enforce before fallback and spawn.** One shared resolver filters candidate models and reasoning before launch construction. All launch modes consume its result rather than applying policy independently after selection. The exact planner tuple is always rejected even if malformed policy attempts to include it. Governs R18 through R20.
- KTD8. **Propagate monotonically.** Serialize the accepted snapshot into supported child launch context, validate it on entry, intersect it with any local dynamic response, and retain the accepted snapshot in resume and recovery state. Invalid inherited state fails closed. Governs R20 and R21.
- KTD9. **Separate reliability fixes by mechanism.** Keep condition polling that observes a real state transition. Remove serialization and widened time thresholds unless a focused reproduced failure proves a distinct product defect. Governs R22 and R23.

### High-Level Technical Design

```mermaid
flowchart TB
  P["Pi selected model and reasoning"] --> E["Prewalk epoch snapshot"]
  C["Prewalk executor configuration"] --> E
  E --> H["OMP coordinator and provider handoff"]
  E --> A["Observation-only analytics"]
  E --> R["Policy response while epoch active"]
  S["pi-subagents before-spawn resolver"] --> Q["Public policy request"]
  Q --> R
  I["Inherited ceiling"] --> S
  R --> S
  S --> V{"Allowed authenticated profile?"}
  V -->|yes| L["Create launch artifacts and child"]
  V -->|no| F["Fail before launch"]
  L --> N["Forward accepted ceiling to descendants"]
```

```mermaid
sequenceDiagram
  participant PS as pi-subagents
  participant EB as Pi event bus
  participant PW as Prewalk
  participant MR as Model registry
  participant CP as Child process
  PS->>EB: execution-profile request v1
  EB->>PW: synchronous request
  PW-->>EB: active epoch policy
  EB-->>PS: collected responses
  PS->>PS: validate and intersect inherited policy
  PS->>MR: resolve allowed authenticated profile
  alt allowed
    PS->>CP: launch with accepted snapshot
  else unavailable or forbidden
    PS-->>PS: actionable pre-launch failure
  end
```

```mermaid
stateDiagram-v2
  [*] --> NoPolicy
  NoPolicy --> ActiveEpoch: Prewalk arms
  ActiveEpoch --> AcceptedLaunch: child policy resolves
  ActiveEpoch --> RejectedLaunch: no allowed profile
  AcceptedLaunch --> InheritedCeiling: child context created
  InheritedCeiling --> AcceptedLaunch: nested launch narrows or preserves
  ActiveEpoch --> Stale: model change or session replacement
  Stale --> NoPolicy: handler no longer answers
```

### Sequencing

1. Correct the planner/configuration contract and OMP boundaries before analytics consumes the new epoch identity.
2. Complete pi-subagents delegation projection before relying on it for task-tree accounting.
3. Finish Prewalk task-tree and cleanup behavior against the stable projection.
4. Add execution-profile policy only after Plan 003 analytics is accepted, keeping the contracts in separate modules and tests.
5. Remove unrelated timing workarounds, run comprehensive checks, review the complete diff once, apply one consolidated fix pass, and run final verification.

### Risks and Mitigations

- **A prohibited candidate reaches a provider before policy.** Central resolution must happen before fallback and launch construction, with tests asserting zero forbidden provider requests.
- **Nested policy becomes broader after reload.** Persist and validate the accepted snapshot, intersect rather than replace, and make invalid inherited data a pre-launch failure.
- **Foreground analytics still reports history instead of lifecycle.** Emit and persist start at launch creation, then test observation before child completion.
- **Task-tree cost double-counts aggregate evidence.** Replace only matching evidence keys and expose overlap-unresolved coverage.
- **Planner configuration silently survives.** Strict parsing deliberately rejects the unreleased old shape, and documentation explains the replacement schema.
- **Test timing changes hide a race.** Restore concurrent integration execution and use observable synchronization instead of larger sleeps.

---

## Implementation Units

### U1. Make Pi's runtime profile authoritative

- **Target repo:** `pi-prewalk`
- **Goal:** Replace the configured planner with a per-epoch snapshot whose planner model and identity are immutable while current planner reasoning follows Pi until handoff.
- **Requirements:** R1 through R5, AE1, AE2
- **Dependencies:** None
- **Files:** `docs/plans/2026-07-30-002-feat-extension-only-sol-luna-prewalk-plan.md`, `src/core.ts`, `src/audit.ts`, `src/status.ts`, `src/analytics.ts`, `extensions/prewalk.ts`, `prewalk.example.json`, `README.md`, `test/core.test.ts`, `test/audit.test.ts`, `test/status.test.ts`, `test/config.test.ts`, `test/extension.test.ts`, `test/analytics.test.ts`
- **Approach:**
  1. Amend Plan 002's configured-planner requirements, configuration unit, status examples, and reset semantics to use the Pi runtime snapshot.
  2. Remove planner from persisted configuration and construct each run from the host snapshot plus executor defaults.
  3. Carry initial and current planner reasoning through audit, reload, status, provider, and receipt identity, updating current reasoning only before handoff.
  4. Keep pre-handoff Shift+Tab unconsumed and post-handoff executor reasoning epoch-local.
- **Execution note:** Start with failing configuration and extension tests that arm from a non-default Pi model and reasoning.
- **Patterns to follow:** `src/core.ts` strict parsing and immutable run snapshots; OMP host-selected planner behavior in the pinned coordinator.
- **Test scenarios:**
  1. A missing config uses executor defaults while preserving an arbitrary selected planner model and reasoning.
  2. A planner-bearing config fails strict validation instead of overriding Pi.
  3. Manual and automatic epochs snapshot the selected model, follow Pi reasoning changes before handoff, and stop following them after executor activation.
  4. Shift+Tab before handoff reaches Pi; after handoff it changes only executor reasoning.
  5. A model change cancels the active epoch and a later epoch snapshots the new selection.
- **Verification:** Config, coordinator, status, audit, and extension tests prove one planner authority and no persisted planner field.

### U2. Restore narrow OMP and standalone boundaries

- **Target repo:** `pi-prewalk`
- **Goal:** Correct prompt filtering, compact status, and stock-provider operation without changing OMP coordinator behavior.
- **Requirements:** R6 through R9, AE3, AE4
- **Dependencies:** U1
- **Files:** `docs/plans/2026-07-30-002-feat-extension-only-sol-luna-prewalk-plan.md`, `src/provider-overlay.ts`, `src/status.ts`, `extensions/prewalk.ts`, `README.md`, `test/provider-overlay.test.ts`, `test/status.test.ts`, `test/context.test.ts`, `test/compaction.test.ts`, `test/agent-loop.test.ts`, `test/omp-parity.test.ts`
- **Approach:**
  1. Delegate through stock `streamSimple` when no compatible registration exists and keep optional registered-stream composition capability-based.
  2. Filter only `prewalk-plan` after handoff and during compaction preparation.
  3. Remove delegation state from compact status while retaining it in explicit detailed status.
  4. Preserve exact prompt assets, continuation transitions, todo gate, and first-mutation handoff.
- **Execution note:** Add characterization coverage for the pinned OMP prompt lifecycle before changing the filters.
- **Patterns to follow:** OMP `#scrubPlanNudge`; existing provider ownership and drift checks.
- **Test scenarios:**
  1. Stock `openai-codex` with no prior custom stream completes the executor path.
  2. A compatible registered stream remains wrapped and restored without package-name detection.
  3. Continuation and checklist messages remain in effective context and compaction preparation while the planning nudge is absent.
  4. Delegation lifecycle does not change compact footer text.
  5. Prompt digests and every applicable OMP parity fixture remain unchanged.
- **Verification:** Real Agent-loop composition and focused provider, context, compaction, status, and parity tests prove the narrow adaptation.

### U3. Complete the public delegation analytics projection

- **Target repo:** `pi-subagents`
- **Goal:** Publish timely, durable, content-free direct and nested child lifecycle evidence for Plan 003.
- **Requirements:** R12 through R15, AE5, AE6
- **Dependencies:** U2
- **Files:** `src/shared/types.ts`, `src/runs/shared/delegation-analytics.ts`, `src/runs/foreground/subagent-executor.ts`, `src/runs/background/async-execution.ts`, `src/runs/background/async-job-tracker.ts`, `src/runs/background/async-resume.ts`, `src/extension/index.ts`, `test/unit/delegation-analytics-contract.test.ts`, `test/integration/delegation-analytics-events.test.ts`, `test/integration/async-job-tracker.test.ts`
- **Approach:**
  1. Emit foreground start when launch identity exists rather than after results return.
  2. Persist current foreground and async projection state in one bounded content-free format and replay active or terminal state after reload.
  3. Preserve root, immediate parent, delegation run, child index, resolved child session, lifecycle, and child-only usage keys through nested launches, parallel siblings, successive invocations, and convergent terminal updates.
  4. Keep the deterministic `waitForCondition` cleanup test improvement.
- **Execution note:** Build one failing public-event composition test for foreground start-before-terminal, then extend the same contract to replay and nesting.
- **Patterns to follow:** `src/runs/shared/capability-ceiling.ts` version validation and the existing async delegation projection.
- **Test scenarios:**
  1. Foreground single and parallel children emit start before terminal with stable lineage.
  2. Chain and nested children retain root identity and name their immediate parent.
  3. Async lifecycle progresses to terminal with child-only usage and replays after reload.
  4. Foreground active and terminal state replays after reload without task, output, path, or raw error content.
  5. A newer same-lineage terminal record may add a resolved child identity and usage, while a stale or running record cannot regress it.
  6. Failed, interrupted, timed-out, stopped, and incomplete children never invent usage.
  7. Existing orchestration result shapes remain unchanged.
- **Verification:** Unit contract and concurrent integration tests prove timing, lineage, replay, privacy, and additive behavior.

### U4. Finish Plan 003 analytics behavior

- **Target repo:** `pi-prewalk`
- **Goal:** Close the reset, task-tree, nested-ingestion, reporting, and integration gaps without affecting routing.
- **Requirements:** R10 through R15, AE6, AE7
- **Dependencies:** U3
- **Files:** `docs/plans/2026-07-30-003-feat-prewalk-personal-savings-analytics-plan.md`, `src/analytics.ts`, `src/analytics-store.ts`, `src/analytics-report.ts`, `src/analytics-subagents.ts`, `extensions/prewalk.ts`, `test/analytics.test.ts`, `test/analytics-store.test.ts`, `test/analytics-report.test.ts`, `test/analytics-subagents.test.ts`, `test/extension.test.ts`, `test/agent-loop.test.ts`
- **Approach:**
  1. Update Plan 003's implementation description to match the completed public projection and runtime planner snapshot.
  2. Report and retry incomplete retired-generation cleanup while keeping the new generation isolated.
  3. Model task-tree actual and estimate coverage with explicit pending, fallback, unresolved-overlap, unsupported, and incomplete states.
  4. Replace one-parent invocation matching with a bounded per-invocation registry and authenticated tree continuity, including out-of-order replay, and remove direct test writes that bypass the event listener.
  5. Correct report rendering and keep every analytics callback isolated from routing.
- **Execution note:** Drive each correction through the public command, event, and result surfaces rather than private store helpers.
- **Patterns to follow:** Strict content-free parsers in `src/analytics-subagents.ts`; atomic generation rotation in `src/analytics-store.ts`.
- **Test scenarios:**
  1. A partial cleanup failure reports incomplete, persists retry state, and becomes complete after a successful retry.
  2. Matching evidence keys replace fallback slices exactly once across replay.
  3. Partial aggregate overlap is excluded and labeled overlap-unresolved.
  4. Nested public events reach the store through the real extension listener.
  5. Unsupported or malformed projection versions leave root-session analytics usable and mark task-tree coverage incomplete.
  6. Task-tree reports contain real line breaks and stable labels.
  7. Storage and reporting failures do not change selected model, reasoning, route, or provider-request count.
- **Verification:** Focused store, report, adapter, command, extension, and real Agent-loop tests satisfy every remaining Plan 003 acceptance case.

### U5. Add the execution-profile ceiling

- **Target repos:** `pi-subagents`, then `pi-prewalk`
- **Goal:** Enforce the active Prewalk executor boundary across every pi-subagents launch path and descendant.
- **Requirements:** R16 through R21, AE8 through AE11
- **Dependencies:** U4
- **Files:** `src/api/execution-profile-ceiling.ts`, `src/runs/shared/execution-profile-ceiling.ts`, `src/runs/shared/model-fallback.ts`, `src/runs/shared/pi-args.ts`, `src/runs/foreground/execution.ts`, `src/runs/foreground/subagent-executor.ts`, `src/runs/foreground/chain-execution.ts`, `src/runs/background/async-execution.ts`, `src/runs/background/async-resume.ts`, `src/runs/background/subagent-runner.ts`, `src/shared/types.ts`, `src/extension/index.ts`, `test/unit/execution-profile-ceiling.test.ts`, `test/integration/execution-profile-policy.test.ts`; in Prewalk: `src/subagent-execution-policy.ts`, `extensions/prewalk.ts`, `test/subagent-execution-policy.test.ts`, `test/agent-loop.test.ts`, `README.md`
- **Approach:**
  1. Define and export the strict versioned request, response, accepted snapshot, validation, intersection, and serialization contracts in pi-subagents.
  2. Request dynamic policy over Pi's public event bus and combine it with inherited policy before model fallback and launch construction.
  3. Make every foreground, async, parallel, chain, dynamic, delegation, resume, and recovery path consume the shared resolved profile.
  4. Propagate the accepted snapshot through supported child environment, launch-contract digest, async status, recovery descriptors, and resume state. Resume intersects the persisted snapshot with any current inherited ceiling before process creation.
  5. Add an independent Prewalk responder that answers only for the matching active epoch and duplicates the minimal wire schema without importing pi-subagents.
- **Execution note:** Begin with a failing real-composition test in which Sol/high would currently launch an ordinary child as Sol/high, and assert that no provider request uses that tuple.
- **Patterns to follow:** Session-scoped registration, intersection, encoding, and nested propagation in `src/runs/shared/capability-ceiling.ts` and `src/runs/shared/pi-args.ts`.
- **Test scenarios:**
  1. No responder preserves existing pi-subagents behavior.
  2. Active Prewalk defaults an override-free child to the configured executor profile.
  3. An allowed lower-reasoning override succeeds, while a forbidden model or reasoning fails before launch.
  4. No authenticated supported allowed profile produces an actionable pre-launch failure with zero provider requests.
  5. Foreground, async, parallel, chain, dynamic-fanout, Delegation v1, and Delegation v2 resolve the same effective policy before artifacts or provider requests.
  6. Resume retains the original accepted ceiling even after the active epoch changes.
  7. Nested children inherit and may narrow but never broaden the root ceiling.
  8. Reload clears stale Prewalk responders and does not revive a cancelled epoch.
  9. Prewalk-only operation and pi-subagents-only operation remain unchanged.
- **Verification:** Public-interface unit and real-composition tests prove effective model and reasoning, policy identity, propagation, failure timing, and zero forbidden requests.

### U6. Remove unrelated timing workarounds and verify the complete system

- **Target repos:** `pi-subagents`, `pi-prewalk`, and the Pi setup
- **Goal:** Restore meaningful concurrency coverage, confirm packaging boundaries, and complete one bounded review and verification tail.
- **Requirements:** R22 through R24
- **Dependencies:** U1 through U5
- **Files:** `package.json`, `src/runs/shared/subagent-startup-retry.ts`, `test/integration/async-execution.test.ts`, `test/integration/parallel-execution.test.ts`, `test/integration/single-execution.test.ts`, `test/integration/async-job-tracker.test.ts`; in Prewalk: `package.json`, `README.md`, `prewalk.example.json`; in the Pi setup: `.gitmodules`, `README.md`, `setup.sh`, `scripts/check.sh`
- **Approach:**
  1. Restore concurrent integration execution and the original production startup retry classification.
  2. Remove widened timing thresholds and broad polling introduced only to pass Plan 003 verification, retaining condition-based synchronization tied to observable state.
  3. Confirm the Pi setup still pins and installs the independent Prewalk checkout without modifying installed caches.
  4. Run each repository's comprehensive checks once, conduct one combined read-only correctness and reliability review, apply accepted findings in one consolidated pass, and run final verification.
- **Execution note:** If restoring a threshold reproduces a real defect, preserve the failing case and fix the lifecycle synchronization rather than raising the threshold again.
- **Patterns to follow:** Existing concurrent integration scripts and `waitForCondition` helpers.
- **Test scenarios:**
  1. Integration tests pass under normal concurrency without shared projection contamination.
  2. Timeout-specific tests still exercise actual timeout behavior at bounded values.
  3. Startup retry classification remains strict and unrelated model failures are not retried.
  4. Pi setup dry-run resolves the pinned Prewalk submodule and leaves installed caches untouched.
  5. Package dry-runs include runtime policy and analytics modules but exclude local journals, projections, and exports.
- **Verification:** Comprehensive Prewalk, pi-subagents, real-session, package, and Pi setup checks pass before and after the consolidated review fix pass.

---

## Verification Contract

All test invocations must use the repository's `run-tests-on-request` skill.

| Gate | Repository | Coverage | Done signal |
|---|---|---|---|
| Focused planner and OMP | `pi-prewalk` | Config, core, audit, status, provider, context, compaction, extension, Agent loop | Runtime planner authority and OMP boundaries pass |
| Focused delegation analytics | `pi-subagents` | Contract, foreground timing, nested lineage, async and foreground replay | Public projection is timely, durable, and content-free |
| Focused Prewalk analytics | `pi-prewalk` | Ledger, reset, report, adapter, command, task tree | Plan 003 gaps pass through public surfaces |
| Focused execution policy | Both extension repos | Contract, intersection, serialization, fallback, every launch mode, real composition | No forbidden provider request and nested ceilings remain monotonic |
| Comprehensive pi-subagents | `pi-subagents` | Unit, integration under normal concurrency, E2E and real-session checks | All required suites pass without broad serialization |
| Comprehensive Prewalk | `pi-prewalk` | Lint, typecheck, unit, Agent loop, smoke RPC, package dry-run, diff validation | All required suites and packaging checks pass |
| Pi setup | Pi setup | Shell and JSON validation, submodule/install dry-run, secret boundary | Setup checks pass without installed-cache changes |
| Combined review | Both extension repos and Pi setup | Complete diff against this plan | No unresolved correctness or reliability blocker |
| Final verification | All affected repositories | Affected focused checks followed by comprehensive checks | Exact final results recorded |

---

## Definition of Done

- Pi's selected model and reasoning define every new Prewalk planner profile.
- Prewalk configuration contains executor defaults and analytics only.
- Shift+Tab retains the agreed before-handoff and after-handoff meanings.
- OMP prompt, continuation, todo, mutation, and narrow filtering behavior is preserved.
- Stock Pi works without Codex Conversion, and optional composition stays public and capability-based.
- Plan 003 reset, task-tree coverage, nested ingestion, foreground timing, and reload requirements are complete.
- Analytics remains observation-only and separate from launch control.
- Every pi-subagents launch path enforces and propagates the active execution-profile ceiling before launch.
- The forbidden planner tuple never reaches a provider in composition tests.
- Both extensions still work independently.
- Broad test serialization, unjustified timeout inflation, and the unrelated startup retry expansion are absent, while deterministic condition synchronization remains.
- Required focused, comprehensive, review, and final verification gates pass.
- The Prewalk submodule architecture remains intact.
- No installed cache, generated file, commit, push, publication, pull request, or release state is changed.
