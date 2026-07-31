---
title: Right-Size Automatic Prewalk - Plan
type: fix
date: 2026-07-31
topic: right-size-automatic-prewalk
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Right-Size Automatic Prewalk - Plan

## Goal Capsule

- **Objective:** Keep Prewalk manual by default while offering a session-scoped automatic mode that admits only clearly substantial implementation work and quietly exits when the first planner turn shows that substantial work does not remain.
- **Product authority:** OMP revision `4df68d60438423b384b2b47fb3d6835641624757` remains the authority for the planner-to-executor handoff. This plan supplies the admission, proportionality, and stopping behavior that OMP receives from its wider host prompt but stock Pi does not.
- **Open blockers:** None.

## Product Contract

### Summary

Prewalk remains an explicit tool by default and gains a conservative `/prewalk auto` mode for the current Pi session. Automatic mode uses a closed admission check followed by one structured first-turn decision, and either check may return the task to normal Pi operation without creating more work.

### Problem Frame

An ordinary package-installation task entered automatic Prewalk because configuration enabled it for every request. The injected planning prompt required a comprehensive plan and five to nine todos even though no product-code mutation was expected. Later tool results then created continuation pressure after the requested installation was complete, and the agent invented audits and runtime smoke-test subagents to satisfy that pressure.

OMP makes this uncommon by keeping Prewalk off by default. Its wider system prompt also skips todos for trivial work, accepts investigation output as proof for research, and avoids inferred validation scope. The local extension copied OMP's handoff coordinator and prompt bytes, but stock Pi does not provide those surrounding proportionality rules. Prompt parity alone therefore does not produce behavioral parity.

### Key Decisions

- **Hybrid activation:** Manual `/prewalk run` remains the default. `/prewalk auto` adds convenience for the current session without making Prewalk universal.
- **Session authority:** Automatic activation is runtime session state, not persisted configuration. Configuration describes executor and analytics settings only.
- **Conservative admission:** Unknown, ambiguous, operational, research-only, and small requests bypass automatically without questions or ceremony.
- **Two-stage circuit breaker:** A request must pass deterministic admission and a structured first-turn assessment before the full OMP planning cadence begins.
- **Proportional proof:** Prewalk never invents tests, audits, cleanup, or delegation to prove a deliverable whose natural proof is smaller.
- **Independent delegation authority:** Prewalk prompts and tools never authorize or initiate subagents. Independently authorized delegation remains governed by Plan 004.

### How This Work Fits Together

- This plan extends the handoff baseline in `docs/plans/2026-07-30-002-feat-extension-only-sol-luna-prewalk-plan.md`.
- Analytics and the Prewalk-aware pi-subagents execution-profile ceiling remain owned by `docs/plans/2026-07-30-004-fix-prewalk-policy-analytics-reconciliation-plan.md`.
- The current repository `prewalk.json` is updated to the canonical executor and analytics schema. Installed package caches and installed extension source remain untouched.

### Actors

- A1. **Pi user:** Chooses session automatic mode and remains the authority for scope, stopping, and delegation.
- A2. **Prewalk extension:** Evaluates admission, requests one first-turn decision, coordinates an accepted OMP handoff, and exits quietly when either gate rejects the task.
- A3. **Planner and executor:** Perform only the requested work, use proof appropriate to the deliverable, and delegate only when another authority permits it.

### Requirements

**Activation and lifetime**

- R1. A new Pi session must begin with automatic Prewalk inactive, while manual `/prewalk run` remains available.
- R2. `/prewalk auto` must enable conservative automatic admission for the current Pi session only.
- R3. `/prewalk cancel` must disable automatic admission for the remainder of the session and cancel any evaluating or active run.
- R4. Extension reload may preserve automatic mode only for the same session identity. Startup, new session, resume, fork, and shutdown must not transfer it to another session.

**Conservative admission**

- R7. Automatic admission must require clear implementation intent and at least one substantial-work signal.
- R8. Substantial-work signals include an exact approved implementation plan, coordinated behavior across multiple concerns, a bug requiring reproduction and regression protection, or an explicit substantial refactor, migration, feature, or end-to-end implementation request. The first-turn assessment, not admission, determines whether a named plan still has unfinished work.
- R9. Research, explanation, diagnosis without an implementation request, package installation, configuration-only operations, one-off operational commands, and small isolated edits must bypass automatic Prewalk.
- R10. Ambiguous requests must bypass automatic Prewalk without asking, adding todos, changing models, initializing executor infrastructure, or delaying normal Pi work.

**First-turn confirmation**

- R11. Every automatically admitted task must receive only a bounded assessment instruction before Prewalk injects its full planning cadence. The assessment window is the complete agent run opened by the admitting `before_agent_start`, not an individual `turn_end`.
- R12. The planner must report a structured `continue` or `bypass` decision after inspecting enough evidence to know whether substantial implementation remains.
- R13. `bypass`, an already-completed plan, or a smaller sufficient action must quietly disarm the task. A missing decision fails closed when the assessment run reaches `agent_settled`; intermediate `turn_end` events neither bypass nor begin planning.
- R14. Manual `/prewalk run` bypasses automatic admission because it is an explicit user request, while still respecting completion, cancellation, proportional proof, and independent delegation authority.

**Scope, verification, and delegation**

- R15. Prewalk guidance must preserve the user's scope and must not turn installation, research, explanation, or small operational work into code testing, repository auditing, runtime smoke testing, or adjacent cleanup.
- R16. Proof must match the deliverable: investigation evidence proves research, installation confirmation proves installation, direct observation proves an operational action, and permanent code behavior receives focused regression protection appropriate to the changed contract.
- R17. Prewalk prompts, tools, and follow-ups must never instruct or initiate delegation. Prewalk must not block delegation that the user, an invoked skill, or project instructions independently authorize.
- R18. Plan 004 remains the sole authority for planner and child execution-profile enforcement.

**Continuation and stopping**

- R19. A continuation prompt must require a pending or in-progress in-scope todo. Blocked-only work, generic tool results, and arbitrary activity are insufficient, and automatic mode may send at most one bounded continuation per task.
- R20. Completed or dropped todos, a completed deliverable, an exact standalone stop or cancel control, quiet disarm, or `/prewalk cancel` must suppress later continuation for that task.
- R21. Repeated tool activity must not revive continuation or cause the agent to invent verification merely to satisfy a handoff.
- R22. The status surface must show session mode separately from the current or last task outcome, so `auto ready` may coexist with `last task bypassed`. The new right-sizing fields add no analytics detail and preserve Plan 004's existing compact delegation projection.
- R23. After todo ownership has been established, `agent_settled` with no actionable todo finalizes the task. A run that never creates a todo must perform its in-scope action in the same agent run; an eligible mutation may hand off, while settling without a mutation finalizes without continuation. Finalization restores the planner overlay and prior active-tool slate, clears task state, and retains only session auto readiness.
- R24. The first valid assessment decision wins and is applied only after the assessment run settles. Malformed, duplicate, late, post-cancel, post-completion, and post-mutation results cannot revive or advance a task; mutation before `continue` disarms evaluation and cannot trigger handoff; and a recorded `continue` queues planning only after `agent_settled`.
- R25. `/prewalk configure` must write only executor and analytics configuration and must not start a run, install an overlay, open run analytics, or inject a prompt.
- R26. The local Prewalk plan, continuation, and checklist prompts must preserve OMP's handoff sequence while making todos conditional, removing fixed cardinality, and matching verification to the deliverable. The external pinned OMP revision remains reference evidence, but local prompt bytes and fixture hashes may change.
- R27. Prewalk-owned todo and assessment tools must be inactive while Prewalk is inactive or auto-ready. Evaluation preserves the existing non-Prewalk slate and adds assessment while removing Prewalk's todo; accepted planning or manual run removes assessment and adds todo; bypass, cancel, completion, and reload restore the exact prior non-Prewalk tool slate.
- R28. Reload restores same-session automatic readiness but quietly closes an in-flight evaluation because its original agent run no longer exists. Existing planning, handoff, and executor restoration remains phase-aware, and the active Prewalk tool slate is derived from the restored phase.

### Key Flows

1. **Enable automatic mode.** `/prewalk auto` records session-local auto state without validating executor configuration, installing overlays, opening analytics, or starting a run.
2. **Establish a task boundary.** A new idle interactive or RPC input starts admission. Extension-originated input and streaming steer or follow-up input do not create a new task.
3. **Bypass conservatively.** An ineligible or ambiguous request receives no Prewalk prompt, tool activation, todo requirement, executor initialization, or continuation.
4. **Assess an admitted task.** `before_agent_start` opens one complete assessment agent run, preserves existing non-Prewalk tools, removes Prewalk's todo, and adds assessment. Guidance requires bounded read-only inspection, and observed mutation fails closed. Intermediate turns do not resolve the gate.
5. **Continue substantial work.** `agent_settled` applies the first valid decision. `continue` swaps assessment for todo and queues planning; `bypass` or no valid decision closes only the task-level run and restores the prior tool slate.
6. **Finish or stop.** `agent_settled` finalizes a task with no actionable todo, restores the planner overlay and prior tool slate, and clears queued Prewalk pressure. Session auto remains ready for the next task unless the user disabled it.

### Acceptance Examples

- AE1. **Covers R1 and R4.** A new session using the canonical executor and analytics configuration starts with automatic mode inactive.
- AE2. **Covers R2 and R4.** `/prewalk auto` survives extension reload in the same session but is inactive in a new, resumed, or forked session.
- AE3. **Covers R9, R10, R15, and R16.** An SSL-installation diagnosis proceeds without Prewalk planning, code tests, repository audits, or subagent smoke tests.
- AE4. **Covers R9, R15, and R16.** A skill installation is proven by successful installation and registration unless the user or skill contract requests runtime validation.
- AE5. **Covers R7, R8, R11, and R12.** A cross-cutting bug fix receives one assessment turn and enters planning only after `continue`.
- AE6. **Covers R11 through R13.** A false-positive admission that inspection resolves with one small action produces `bypass` and no todo, continuation, handoff, or checklist.
- AE7. **Covers R8, R12, and R13.** An exact approved plan that is already complete quietly bypasses.
- AE8. **Covers R17.** With no independent delegation authority, Prewalk emits no instruction, tool action, or follow-up that launches a subagent.
- AE9. **Covers R17 and R18.** An invoked skill may independently authorize a subagent, and Plan 004 governs its execution profile.
- AE10. **Covers R19 through R21.** Generic tool results after completion do not send another continuation or manufacture verification.
- AE11. **Covers R3 and R20.** `/prewalk cancel` during evaluation disables auto mode, cancels the run, and prevents later assessment or tool results from reviving it.
- AE12. **Covers R14, R19, and R20.** Manual `/prewalk run` starts planning immediately but completion still prevents additional continuation.
- AE13. **Covers R13 and R24.** Evaluation that settles without a decision, submits malformed input, or submits a second or late result quietly disarms and cannot revive.
- AE14. **Covers R19, R21, and R23.** One pending or in-progress todo may receive one bounded continuation; blocked-only, completed, or dropped todos receive none, and a second settle cannot send another. A run with no todo either hands off from an eligible same-run mutation or finalizes without continuation.
- AE15. **Covers R22 and R23.** After a bypass or completed task, status shows `auto ready` with the last outcome, the planner overlay is authoritative again, and the next task is evaluated from that planner.
- AE16. **Covers R25.** `/prewalk configure` saves executor and analytics settings without starting a run, overlay, analytics journal, assessment, or planning prompt.
- AE17. **Covers R7 through R10.** Explicit non-mutation intent outranks implementation-looking quoted text, and install, configuration, or research intent outranks generic action verbs. Extension input and queued steer or follow-up input never create a task.
- AE18. **Covers R26.** The complete effective provider guidance permits fewer than five todos and deliverable-specific proof while preserving the OMP handoff sequence.
- AE19. **Covers R11, R13, R24, and R27.** Assessment may use multiple read-only tool turns; intermediate `turn_end` does nothing, and only `agent_settled` applies the decision or fails closed.
- AE20. **Covers R27.** Inactive, auto-ready, and bypassed work receives neither Prewalk todo nor assessment guidance. Evaluation preserves non-Prewalk tools and adds assessment only; accepted planning removes assessment and adds todo without disturbing the non-Prewalk slate.
- AE21. **Covers R28.** Reload during evaluation quietly returns to same-session auto-ready with the prior non-Prewalk tool slate; reload during a later supported phase restores that phase and derives its Prewalk tool slate.

### Scope Boundaries

**In scope**

- Session-scoped `/prewalk auto` and `/prewalk cancel`.
- Conservative deterministic admission.
- Structured first-turn continue or bypass assessment.
- Proportional proof and non-authorizing delegation guidance.
- Todo-backed completion-aware continuation.
- Status, audit, documentation, configuration, and deterministic public-surface coverage.

**Outside this plan**

- Analytics semantics, savings calculation, and delegation projection owned by Plan 004.
- Prewalk-aware pi-subagents model and reasoning ceilings owned by Plan 004.
- A model-based task classifier or general semantic complexity service.
- Persistent automatic mode across sessions.
- Compatibility or migration machinery for obsolete activation configuration.
- Pi core changes, OMP source changes, installed package cache edits, generated files, or private runtime imports.
- Unrelated retry, timeout, setup, prompt, or test cleanup.

### Dependencies and Assumptions

- Pi's public `input`, `before_agent_start`, `turn_end`, `agent_settled`, `session_start`, `session_shutdown`, tool-registration, and custom-session-entry APIs remain the only lifecycle dependencies.
- A new idle interactive or RPC input is a task boundary. Streaming steer and follow-up inputs continue the active task.
- Conservative admission favors false negatives. Manual `/prewalk run` is the escape hatch.
- A small structured assessment tool is acceptable internal evidence even when its renderer is intentionally quiet.
- Local prompt assets may diverge from the pinned OMP bytes where needed to supply the proportionality rules that OMP normally receives from its host. OMP remains the handoff-sequence reference.

### Sources and Research

- `src/core.ts` - current coordinator and generic tool-result continuation.
- `extensions/prewalk.ts` - public lifecycle integration, config loading, commands, and prompt injection.
- `src/todo.ts` - current todo state and completion evidence.
- `src/status.ts` - current run-only status.
- `src/audit.ts` - existing custom session-entry and reload patterns.
- `test/extension.test.ts` - public extension harness and lifecycle assertions.
- `prompts/prewalk-plan.md`, `prompts/prewalk-continue.md`, and `prompts/prewalk-checklist.md` - pinned OMP handoff guidance.
- `prewalk.example.json` and `../prewalk.json` - canonical and workspace configuration.
- `docs/plans/2026-07-30-004-fix-prewalk-policy-analytics-reconciliation-plan.md` - separate analytics and execution-profile authority.
- [OMP Prewalk setting](https://github.com/can1357/oh-my-pi/blob/4df68d60438423b384b2b47fb3d6835641624757/packages/coding-agent/src/config/settings-schema.ts#L453-L462)
- [OMP proportional task guidance](https://github.com/can1357/oh-my-pi/blob/4df68d60438423b384b2b47fb3d6835641624757/packages/coding-agent/src/prompts/system/system-prompt.md#L198-L246)
- [OMP Prewalk coordinator](https://github.com/can1357/oh-my-pi/blob/4df68d60438423b384b2b47fb3d6835641624757/packages/coding-agent/src/session/prewalk.ts)

## Planning Contract

### Key Technical Decisions

1. **Activation is separate from configuration.** Remove `enabled` from the canonical `PrewalkConfig`, example, workspace configuration, and `/prewalk configure` output. The strict schema rejects the obsolete key after the repository configurations are corrected; it does not preserve, announce, or migrate it.
2. **Admission is closed and deterministic.** A pure admission module evaluates a small explicit rule table. It requires implementation intent plus a substantial-work signal and defaults unknown input to bypass.
3. **The first-turn gate is structured.** Register a small Prewalk assessment tool through Pi's public API. It accepts only `continue` or `bypass`, is added beside existing non-Prewalk tools only for evaluation, and records the first valid decision without parsing free-form assistant text. Existing mutation evidence invalidates evaluation. `agent_settled` applies the decision or fails closed, and Prewalk exactly restores the prior slate after bypass, cancel, completion, or reload.
4. **Executor work starts lazily.** Admission and evaluation do not validate the executor model, install provider overlays, open run analytics, add todos, or inject the full planning prompt. These begin only after `continue`.
5. **Reload continuity uses session identity.** Append a versioned session-local auto-mode entry and restore it only on reload when its recorded session identity equals the current identity.
6. **Continuation uses actionable unfinished work.** After todo ownership exists, replace `hasToolResults` re-arming with a predicate that reports an in-scope pending or in-progress item. Blocked-only state settles without follow-up, and one task receives at most one automatic continuation. Without a todo, work must mutate and hand off in the same agent run or settle as complete.
7. **Local prompts preserve behavior, not bytes.** Update the local plan, continuation, and checklist assets so the OMP handoff sequence remains intact while todo count and proof are proportional. Update local hash fixtures accordingly; do not edit OMP source or installed copies.
8. **User control wins.** `/prewalk cancel` always disables session auto mode and cancels active evaluation or execution. Exact normalized standalone stop or cancel inputs close only the current task without broad substring matching. Model selection cancels the current task epoch but leaves session auto enabled.
9. **Completion restores planner authority.** On `agent_settled`, no actionable todo finalizes the task, restores the planner overlay and tool slate, and keeps only session auto readiness. This is a deliberate task-scoped departure from OMP's one-way session routing.
10. **Reload does not revive evaluation.** Same-session reload restores auto readiness but closes evaluating state. Later supported phases restore from audit and derive their tool slate rather than replaying stale tool state.

### Assumptions

- The user's autonomous approval covers the full brainstorm scope and the public-API approach above.
- Obsolete activation config needs removal, not a migration subsystem or backwards-compatible behavior.
- A first-turn structured tool call is sufficiently quiet when it has a minimal renderer and causes no further Prewalk pressure after bypass.
- Plan 004 remains complete and is not reopened by this work.

### Product Contract Preservation Note

The requirements-only artifact was enriched without changing the settled hybrid activation, conservative bypass, first-turn self-disarm, proportional proof, delegation, or completion behavior. R5 and R6 from the earlier draft were removed because the user explicitly replaced migration work with a direct canonical `prewalk.json` correction. Existing requirement identifiers were not renumbered.

## Implementation Units

### U1. Canonical configuration and session automatic mode

**Files**

- `src/core.ts`
- `src/audit.ts` or one narrowly scoped session-state module
- `extensions/prewalk.ts`
- `prewalk.example.json`
- `../prewalk.json`
- `README.md`
- `test/core.test.ts`
- `test/audit.test.ts`
- `test/extension.test.ts`

**Work**

- Remove persisted activation from the canonical config type and writers.
- Parse executor and analytics independently of session activation.
- Add versioned session-local auto state with same-session reload restoration.
- Add `/prewalk auto`; make `/prewalk cancel` disable auto mode and cancel any run.
- Make `/prewalk configure` save configuration without starting Prewalk work.
- Ensure startup, new, resume, fork, and shutdown begin or end with auto inactive.

**Acceptance**

- AE1, AE2, and AE16 pass through the public extension harness.
- Enabling auto alone performs no model validation, provider installation, analytics run creation, or prompt injection.

### U2. Conservative admission and first-turn self-disarm

**Files**

- `src/admission.ts`
- `src/core.ts`
- `extensions/prewalk.ts`
- `prompts/prewalk-assess.md`
- `test/admission.test.ts`
- `test/core.test.ts`
- `test/extension.test.ts`
- `test/prompts.test.ts`

**Work**

- Add table-driven admission with explicit substantial and explicit bypass signals.
- Establish task boundaries from idle interactive or RPC input and ignore extension-generated or streaming continuity input.
- Add distinct ready, evaluating, planning, handed-off, and bypassed lifecycle states.
- Register a structured assessment action beside the existing non-Prewalk slate only while evaluating and restore the previous slate exactly afterward.
- Treat assessment as one complete agent run: bounded read-only inspection may span intermediate turns, while `agent_settled` alone applies the first valid decision or fails closed.
- Keep Prewalk's todo tool inactive until manual or accepted automatic planning, and defer foreign todo ownership checks until that point.
- Treat bypass, malformed or missing assessment, completed plans, and small sufficient actions as quiet disarm.
- Make the first valid decision authoritative and ignore duplicate, late, post-cancel, and post-completion results.
- Forbid mutation, todo initialization, tests, and subagent launch during assessment while allowing bounded read-only inspection; observed mutation fails closed.
- Start executor-dependent behavior only after an accepted continue decision.

**Acceptance**

- AE3 through AE7, AE11, AE13, AE17, and AE19 through AE21 pass.
- Tests prove bypass causes zero full-plan prompt, todo pressure, overlay installation, analytics run, continuation, or provider request.
- Tests exercise public extension events and the registered tool instead of private helpers alone.

### U3. Proportional proof and completion-aware continuation

**Files**

- `src/todo.ts`
- `src/core.ts`
- `extensions/prewalk.ts`
- `prompts/prewalk-plan.md`
- `prompts/prewalk-continue.md`
- `prompts/prewalk-checklist.md`
- `src/status.ts`
- `README.md`
- `test/todo.test.ts`
- `test/core.test.ts`
- `test/extension.test.ts`
- `test/status.test.ts`
- `test/prompts.test.ts`

**Work**

- Add a todo predicate for pending or in-progress in-scope work; blocked-only work does not continue.
- Remove generic tool-result continuation re-arming.
- Update the local Prewalk prompts to make todo use and verification proportional while preserving the OMP handoff sequence, then update the local hash fixtures.
- Ensure Prewalk guidance neither authorizes delegation nor blocks separately authorized delegation.
- Report session mode separately from current or last task outcome, add no analytics detail, and preserve Plan 004's existing delegation projection.
- Suppress queued prompts after completion, bypass, or cancel.
- Finalize settled tasks, restore planner and tool authority, and admit the next task from the planner profile.

**Acceptance**

- AE8 through AE10, AE12, AE14, AE15, and AE18 pass.
- One pending or in-progress todo may justify one bounded continuation after todo ownership exists; blocked, completed, or dropped work and arbitrary tool output may not. A no-todo run must mutate in the same run or finalize.
- Prompt snapshots prove the complete effective guidance contains no unconditional todo count, full-module test, audit, cleanup, or delegation requirement.

## Verification Contract

All test execution must use the local `run-tests-on-request` skill.

### Focused checks during implementation

- U1: configuration, audit, and extension lifecycle tests only.
- U2: admission, coordinator, prompt, and extension assessment tests only.
- U3: todo, coordinator, status, prompt, and extension continuation tests only.
- A failed focused check returns to the same serial writer for correction.

### Comprehensive implementation checks

Run once after U1 through U3 are complete:

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run test:agent-loop`
- `npm run smoke:rpc`

### Combined review

Run one fresh read-only correctness and reliability review against:

- this exact plan path;
- the complete diff;
- focused and comprehensive check results;
- the separation boundary with Plan 004;
- proof that installed caches and OMP source were not changed.

Deduplicate findings, accept only reproducible issues, and apply accepted findings in one consolidated fix pass. Run a second review only if an unresolved blocker remains.

### Final verification

Rerun only checks affected by the fix pass, then run the comprehensive command set once more. Record exact results and residual risks.

## Definition of Done

- The canonical configuration contains executor and analytics settings without persisted activation, and `/prewalk configure` performs configuration only.
- New sessions are manual by default; `/prewalk auto` is same-session only.
- Simple, ambiguous, research-only, installation, configuration-only, and one-off operational work bypasses without Prewalk pressure.
- Admitted work must receive a structured first-turn continue decision before full planning begins.
- False positives and completed plans quietly disarm.
- Generic tool results and blocked-only todos cannot re-arm continuation.
- Settled tasks restore planner and prior tool authority before the next task.
- Proof remains proportional to the deliverable.
- Prewalk does not authorize delegation and Plan 004 remains separate.
- Every acceptance example is traceable to deterministic coverage. Public-harness tests cover lifecycle boundaries and cross-component contracts; pure admission tables, todo predicates, malformed inputs, and prompt wording stay in focused unit tests.
- Required checks and final review pass.
- No Pi core, OMP source, installed package cache, generated file, commit, push, PR, or publication is changed or created.
