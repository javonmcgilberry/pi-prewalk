---
title: Portable Prewalk Core - Plan
type: refactor
date: 2026-08-12
topic: portable-prewalk-core
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

# Portable Prewalk Core - Plan

## Goal Capsule

- **Objective:** Establish the requirements for extracting Prewalk's trusted planner-to-executor behavior into a host-neutral core that can support Pi, Claude Code, Codex, Cursor, and OpenCode without pretending their control surfaces are equivalent.
- **Product authority:** [`docs/research/2026-08-12-prewalk-harness-portability.md`](../research/2026-08-12-prewalk-harness-portability.md) defines the current cross-harness evidence; the current Pi behavior remains authoritative for existing Prewalk semantics.
- **Open blockers:** None for planning the core boundary. The first implementation plan must choose a narrow non-Pi contract proof before locking the extracted public interface.

---

## Product Contract

### Summary

Prewalk will become a portable planner-to-executor orchestration engine with one strict behavior contract and capability-based harness adapters. It will preserve a shared vendor-native trajectory where possible and label every weaker handoff honestly.

### Problem Frame

The current implementation proves the paradigm inside Pi: a planner explores the repository, establishes a todo list, makes the first successful code change, and hands the same live conversation to an executor. Pi-specific lifecycle events, provider routing, context filtering, and persistence currently sit close to otherwise portable policy.

Moving those modules into a package without testing another host would likely preserve Pi assumptions behind generic names. At the other extreme, reducing portability to a planner summary sent to another agent would discard the main value of Prewalk and recreate plan mode.

The product needs a durable definition of shared trajectory, a strict minimum behavior contract, and explicit fidelity grades so adapters can degrade without making false equivalence claims.

### Actors

- A1. **Open-source Prewalk user:** wants to use an existing coding harness and provider setup without surrendering unrelated sessions or global configuration to Prewalk.
- A2. **Adapter maintainer:** implements one harness integration and needs a bounded contract, capability tests, and honest fallback rules.
- A3. **Core maintainer:** evolves shared policy without importing vendor events, authentication, provider routing, or transcript formats into the core.
- A4. **Future evaluator:** compares quality, cost, and handoff fidelity using receipts that distinguish observed usage from estimates.

### Key Decisions

- **Shared trajectory is the product boundary.** A qualifying high-fidelity adapter continues the same vendor-native session, thread, or agent after the planner settles. A summary sent to a fresh agent is a labeled bridge, not equivalent Prewalk behavior.
- **One strict core, asymmetric adapters.** The core defines admission, phase state, work-state gates, mutation proof, handoff eligibility, exact run ownership, cleanup, and analytics meaning. Each adapter translates the host's actual capabilities rather than imitating Pi.
- **Fidelity is derived from evidence.** Adapters advertise tested capabilities; Prewalk derives a visible grade and fails closed when a required capability or model-identity proof is absent.
- **Controlled sessions are optional and task-scoped.** The strongest integration may start one harness task through Prewalk, but it does not replace the user's normal harness, modify unrelated sessions, or require global ownership.
- **Prompt removal is preferred, not assumed.** An adapter that cannot remove planner-only guidance must preserve and disclose it, then receive a lower context-fidelity grade.
- **Research precedes package shape.** The extraction boundary is not finalized from Pi alone. A narrow non-Pi contract proof must challenge the proposed interface before shared production code is moved behind it.
- **Rankings guide rather than commit.** The first proving adapter is chosen during planning from the question being tested, current vendor stability, authentication constraints, and implementation cost.

### Requirements

**Shared trajectory**

- R1. A high-fidelity adapter must continue one vendor-native conversation container across planner and executor work.
- R2. The executor must receive the planner's surviving repository exploration, tool calls, tool results, todo state, and successful mutation evidence through that trajectory or through an explicitly tested restoration mechanism.
- R3. A fresh-agent summary handoff must be labeled `bridged` and must never satisfy a shared-trajectory acceptance claim.
- R4. Cross-model replay may be described as semantic continuity only; Prewalk must not claim byte-identical context when the harness normalizes provider metadata or compacts history.

**Planner gate and mutation proof**

- R5. Each run must have an isolated work-state checklist that another run, child, resumed process, or stale event cannot satisfy.
- R6. Handoff eligibility requires both a valid work-state gate and positively proven persisted code mutation.
- R7. Tool success without sufficient filesystem evidence must not count as mutation when the host event cannot establish that the change persisted.
- R8. The planner must reach a host-confirmed settled boundary before executor route activation.

**Model routing and context**

- R9. The adapter must request an executor model through a supported host mechanism and verify the observed model identity when the harness exposes that evidence.
- R10. A missing, mismatched, or unverifiable required executor route must fail closed or use a separately labeled fallback.
- R11. Planner-only guidance must be removed from future model-visible context when the host supports safe removal.
- R12. When guidance cannot be removed, the adapter must preserve it honestly, prevent contradictory executor instructions where possible, and downgrade context fidelity.

**Lifecycle and recovery**

- R13. Every observation that can affect a run must be attributable to an exact adapter run identity or be treated under a documented unknown-event policy.
- R14. Cancellation, interruption, provider failure, process loss, resume, compaction, and replacement must not leave a stale executor route or handoff reservation.
- R15. Adapter-owned state and vendor-owned session state must reconcile after restart without fabricating todo completion, mutation proof, model identity, or terminal completion.
- R16. Compaction support must state which planner facts survive in active model context and which remain available only in durable audit history.

**Capability and fidelity model**

- R17. Every adapter must publish machine-readable capabilities for durable trajectory, tool observation, terminal confidence, model control, context filtering, resume, compaction, authentication mode, and usage evidence.
- R18. Prewalk must derive one of `native`, `controlled`, `resumed`, `bridged`, or `unsupported` from proven capabilities rather than vendor name.
- R19. Experimental, source-inferred, or version-sensitive capabilities must be distinguishable from stable documented capabilities.
- R20. Runtime canaries must guard capabilities that configuration alone cannot prove, especially served-model identity and resume behavior.

**User control and installation**

- R21. A controlled session must be optional and limited to one task trajectory.
- R22. Controlled mode must use supported harness mechanisms to reuse project configuration, tools, permissions, and credentials where possible.
- R23. Prewalk must not rewrite global harness settings, broker vendor credentials, or interfere with unrelated harness sessions.
- R24. The user must be able to inspect the underlying vendor session identity and interrupt, leave, or resume the controlled flow without losing repository control.
- R25. An in-harness or simpler bridge mode may ship alongside controlled mode when its reduced guarantees are visible before use and in the final receipt.

**Authentication, distribution, and analytics**

- R26. Each adapter must implement its vendor's authentication and credential rules independently; the core must not normalize credentials into a shared secret format.
- R27. Subscription allowance, API billing, cloud-provider billing, and observed usage must remain distinct in configuration, receipts, and documentation.
- R28. Claude subscription authentication must not be offered to third-party users without vendor approval; supported API or cloud credentials remain the distributable default unless policy changes.
- R29. Analytics must separate observed vendor usage and cost from counterfactual savings estimates.
- R30. Cross-harness efficacy claims require a separately approved benchmark with frozen tasks, quality criteria, model policy, and cost accounting.

**Architecture and evolution**

- R31. The core must not import Pi, Claude Code, Codex, Cursor, or OpenCode event and protocol types.
- R32. Host event translation, transcript projection, compaction mechanics, authentication, model routing, and vendor usage collection remain adapter responsibilities.
- R33. Pi remains the reference behavior implementation, but its event names, provider overlay, and public API limitations must not become mandatory adapter semantics.
- R34. The public core interface must not be locked until at least one narrow non-Pi proof exercises durable trajectory, work state, mutation evidence, settled handoff, model identity, resume, and cleanup.
- R35. Later adapters must be addable without weakening existing core invariants or adding vendor-specific policy branches to the core.

### Key Flows

- F1. **Controlled high-fidelity run**
  - **Trigger:** The user starts a Prewalk task through a supported controller mode.
  - **Actors:** A1, harness adapter, Prewalk core.
  - **Steps:** The adapter opens one vendor session on the planner; the core establishes run and work state; adapter events prove mutation and settlement; the adapter selects and verifies the executor; the executor continues the same session.
  - **Outcome:** One task preserves a shared trajectory without changing unrelated harness sessions.

- F2. **Degraded bridge**
  - **Trigger:** The chosen harness mode cannot preserve or control the required trajectory.
  - **Actors:** A1, harness adapter, Prewalk core.
  - **Steps:** The adapter reports missing capabilities; Prewalk offers or applies only an allowed fallback; the UI and receipt name what state is lost.
  - **Outcome:** The workflow remains useful without being represented as equivalent to high-fidelity Prewalk.

- F3. **Resume after process loss**
  - **Trigger:** Prewalk or the harness exits while a vendor session remains resumable.
  - **Actors:** A1, harness adapter, Prewalk core.
  - **Steps:** The adapter reconnects to the exact vendor session; adapter and core journals reconcile phase, todo, mutation, and route facts; uncertain facts remain unknown rather than inferred.
  - **Outcome:** The task resumes safely or stops with an honest recovery explanation.

- F4. **Capability drift**
  - **Trigger:** A harness or SDK version changes.
  - **Actors:** A2, harness adapter, Prewalk core.
  - **Steps:** Version and capability probes run; failed or changed canaries disable affected behavior; fidelity is recalculated; unaffected lower-grade modes remain available where safe.
  - **Outcome:** Upgrades fail closed instead of silently overstating control.

### Acceptance Examples

- AE1. **Covers R1-R4.** Given a planner and executor use the same vendor session ID, when handoff completes, then the executor receives the vendor-preserved conversation and the receipt reports a shared-trajectory grade. Given a fresh session receives only a summary, the grade is `bridged`.
- AE2. **Covers R5-R8.** Given the planner writes a checklist but has not produced a persisted code change, when its turn settles, then handoff remains blocked. Given an attributed mutation persists and the turn then settles, handoff may become eligible.
- AE3. **Covers R9-R12.** Given the adapter requests executor model E but observes planner model P, when the next request starts, then the route fails closed and no native or controlled handoff is claimed.
- AE4. **Covers R13-R16.** Given a late tool terminal from run A arrives after run B starts, when the adapter correlates it, then it cannot satisfy run B's mutation or todo gate.
- AE5. **Covers R17-R20.** Given a previously supported experimental model-switch capability disappears after an upgrade, when capability probing runs, then the adapter downgrades or refuses before mutation rather than failing during handoff.
- AE6. **Covers R21-R25.** Given a controlled Codex or Claude task is active, when another ordinary harness session runs concurrently, then Prewalk does not change its model, settings, transcript, or lifecycle.
- AE7. **Covers R26-R30.** Given usage is charged to a subscription allowance in one harness and an API account in another, when analytics renders the runs, then it labels the billing modes separately and does not compare unobserved dollar savings as fact.
- AE8. **Covers R31-R35.** Given the first non-Pi proof reveals a host without Pi-style provider interception, when the core interface is revised, then the shared policy remains host-neutral and model routing stays in the adapter.

### Scope Boundaries

**In scope**

- Requirements for a host-neutral Prewalk behavior core.
- Capability, fidelity, lifecycle, authentication, and analytics boundaries.
- Pi, Claude Code, Codex, Cursor, and OpenCode as the initial evidence set.
- A future narrow non-Pi contract proof before the extraction interface is finalized.
- Both controlled and degraded modes with explicit user-visible distinctions.

**Deferred for later**

- Selecting the first proving adapter.
- Detailed package layout, interfaces, schemas, and migration sequence.
- Adapter implementation and compatibility test fixtures.
- Cross-harness quality, latency, and savings benchmarks.
- Publication, hosted services, or commercial support policy.

**Outside this product's identity**

- Calling a fresh-agent summary the same as shared trajectory.
- Patching proprietary harness binaries or private storage to simulate control.
- Brokering user OAuth tokens or bypassing vendor authentication terms.
- Taking permanent control of a user's normal coding harness workflow.
- Weakening mutation, todo, settlement, or exact-run safety to increase adapter count.

### Success Signals

- A planning agent can design the extraction without inventing what shared trajectory, fidelity, or degradation means.
- One non-Pi contract proof can exercise the same core policy without importing Pi event or provider types.
- Users can tell before and after a run whether they received a controlled shared trajectory or a weaker bridge.
- A harness upgrade that removes control produces a safe downgrade or refusal rather than a false successful handoff.
- Future efficacy measurements can compare observed cost and quality without conflating subscription allowances, API billing, or estimated savings.

### Dependencies and Assumptions

- Vendor public APIs and policies will continue to change; adapter support is versioned and evidence-bound.
- Shared trajectory means durable semantic continuity, not preservation of private reasoning bytes or provider signatures.
- A user may prefer the normal in-harness experience over stronger controller ownership; both modes remain optional where supported.
- No current evidence guarantees arbitrary outgoing-context rewrite across all target harnesses.
- No provider-backed canary or efficacy benchmark was part of this requirements artifact.

### Research References

- [`docs/research/2026-08-12-prewalk-harness-portability.md`](../research/2026-08-12-prewalk-harness-portability.md)
- [`README.md`](../../README.md)
- [`docs/prewalk-vs-omp.md`](../prewalk-vs-omp.md)
- [`docs/research/2026-08-07-omp-behavior-matrix.md`](../research/2026-08-07-omp-behavior-matrix.md)
- [`docs/architecture/host-event-correlation.md`](../architecture/host-event-correlation.md)
