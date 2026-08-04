# Faithful Core Compatibility and OMP Drift

**Status:** Approved implementation brief  
**Date:** 2026-08-03  
**Supersedes:** [`2026-07-30-001-feat-automated-pi-compatibility-plan.md`](2026-07-30-001-feat-automated-pi-compatibility-plan.md)

## Goal

Make Prewalk a faithful adaptation of Oh My Pi's core planner-to-executor behavior while keeping stock Pi as the required runtime.

The target is behavioral fidelity through Pi's public APIs, not architectural parity with Oh My Pi. Where stock Pi cannot expose the same internal mechanism, the implementation must document the observable adaptation and test the resulting behavior.

This brief covers:

- exact pinned OMP prompt parity;
- the main-session planner-to-executor lifecycle;
- optional child-local Prewalk;
- removal of the patched `pi-subagents` dependency;
- trustworthy delegated-cost evidence;
- stock-Pi runtime proof;
- Pi release compatibility reporting;
- OMP source and behavior drift reporting;
- portable setup migration.

This is an implementation brief. It does not authorize patching Pi, patching `pi-subagents`, publishing packages, deploying services, auto-merging changes, or spending provider credits.

## Product contract

### Stock Pi is the runtime baseline

Prewalk must run on an unmodified stock Pi release. The local Pi checkout may be used for development and tests, but it is not a runtime dependency.

Prewalk must use Pi's public extension, provider, session, command, and tool-result APIs. It must not depend on private Pi source paths, a patched Pi distribution, or a patched `pi-subagents` package.

Conversion, context-mode, `pi-subagents`, and other extensions remain optional integrations. Their absence must not prevent ordinary stock-Pi Prewalk from loading.

### OMP-faithful core with explicit adaptations

The observable core trajectory is:

1. retain the selected planner;
2. inject the exact planning guidance;
3. require the todo gate;
4. wait for the first successful qualifying mutation;
5. hand off to the configured executor;
6. inject the exact continuation/checklist guidance;
7. keep the executor route active for later user turns;
8. finish, cancel, fail, or release through explicit terminal lifecycle states.

The implementation need not copy OMP's internal classes. It must not claim architectural parity where only equivalent observable behavior is provided.

### Exact prompt parity

The implementation must vendor these three files byte-for-byte from one immutable OMP commit:

- `packages/coding-agent/src/prompts/system/prewalk-plan.md`
- `packages/coding-agent/src/prompts/system/prewalk-checklist.md`
- `packages/coding-agent/src/prompts/system/prewalk-continue.md`

The implementation milestone must fetch OMP immediately before changing the prompts, resolve one immutable commit SHA, and record:

- the OMP repository and commit SHA;
- each source path;
- each vendored destination;
- each SHA-256 digest;
- the retrieval date;
- whether the source was a tagged release or an untagged commit.

The local prompt files are currently deliberate rewrites. Their provenance claims are inaccurate and must be corrected. Later implementation must replace the rewrites with the pinned byte-for-byte assets and update `README.md`, `THIRD_PARTY_NOTICES.md`, and prompt tests accordingly.

Prompt tests must compare exact bytes or exact SHA-256 values. They must fail when a prompt changes without a deliberate baseline update. A later OMP drift report must never silently replace the pinned prompts.

### Main-session handoff

The provider overlay remains the public-API handoff mechanism.

Before handoff, Prewalk preserves the user's selected planner and its settings. During the active route, the overlay directs the next primary request to the configured executor without persistently changing Pi's selected planner.

The handoff is one-way:

- do not automatically remove the overlay at `agent_settled`;
- keep the executor route active across later user turns;
- retain the same transcript and selected planner underneath the overlay;
- keep auxiliary and unrelated streams scoped safely;
- restore the planner only through an explicit release or terminal cleanup path.

Match OMP's persistence boundary. The executor route survives later turns and an extension `/reload` while the same live Pi session remains open. It does not survive closing and reopening Pi, even when the transcript is resumed. A clean shutdown finalizes the active receipt as session-ended. Crash recovery treats stale active evidence as interrupted, removes any stale routing state, and resumes on the selected planner rather than silently resurrecting the executor.

Add `/prewalk release` with this contract:

- it is valid only after a successful executor handoff;
- it removes the provider overlay;
- it restores the underlying selected planner in the same transcript;
- it records a distinct manual-release outcome and receipt state;
- it does not re-arm Prewalk;
- subsequent turns remain on the restored planner unless the user starts another run.

`/prewalk cancel` remains the pre-handoff cancellation command. It disables automatic admission for the session and cancels the active pre-handoff run. It must not be presented as equivalent to releasing an already active executor route.

Failed handoffs, provider errors, cancellation, and release must restore routing safely and must not leave a stale overlay or a misleading selected-model display.

### Child model behavior

Remove the patched `pi-subagents` dependency and all global child execution-profile ceiling or policy mutation.

Use unmodified upstream `pi-subagents`. Children retain normal independent model, thinking, explicit override, and fallback precedence. Parent Prewalk does not propagate to children.

In particular, Prewalk must not:

- rewrite every child's `model` or `thinking`;
- remove or replace `fallbackModels`;
- set a global descendant ceiling;
- claim strict descendant enforcement;
- use a custom policy environment variable to imply enforcement;
- reject a child solely because it does not load Prewalk.

A child that does not opt into child-local Prewalk remains an ordinary upstream child for its complete run.

### Experimental child-local Prewalk

Ship child-local Prewalk as experimental and disabled by default. Do not enable it in `my-pi-setup` until controlled benchmark evidence exists.

The feature must be explicit per agent and use stock public surfaces, such as per-agent extension/configuration overrides and public child identity signals. It must not patch Pi or `pi-subagents`.

For a selected child:

1. resolve the child's own model, thinking level, fallback list, tools, and permissions normally;
2. start on that independently resolved model;
3. provide the exact pinned OMP planning guidance and child todo gate;
4. wait for that child's first successful qualifying mutation;
5. switch one-way to its configured child executor;
6. provide the exact continuation/checklist guidance;
7. keep the child executor active for the rest of that child session.

The child implementation must follow these OMP-aligned rules:

- the child target is explicit per agent;
- model and thinking resolution remains child-local;
- same-model handoff that lowers effective thinking is valid;
- equal or unavailable targets leave the child unarmed;
- read-only children do not arm;
- plan-mode children do not arm;
- a failed or ambiguous mutation does not trigger a handoff;
- descendants do not inherit child-local Prewalk automatically;
- a child must opt in independently if its own definition/configuration permits it;
- no efficacy or savings claim is made merely because the feature exists.

The experimental feature must expose a clear status or diagnostic reason when it is disabled, unavailable, equal to the starting profile, or not loaded in a child. It must fail closed rather than guessing the child identity or mutation result.

### Mutation evidence

The handoff trigger is the first positively proven successful code mutation after the todo gate.

Stock `edit` and `write` are the baseline. `apply_patch`, direct patch tools, shell-based patching, Code Mode, and future tool ecosystems qualify only when an adapter proves equivalent terminal success evidence.

Unknown or ambiguous mutation shapes must not trigger the handoff. Optional adapters may translate third-party events into the common semantic evidence contract without making those integrations runtime dependencies.

### Analytics

Use standard public `pi-subagents` tool-result details for the best available direct and nested cost evidence.

Direct-child evidence should use the unique public result usage slices. Nested evidence should use the public nested run summaries and their reported terminal cost. Aggregate details that already include descendants must not be added a second time.

Missing async or detached terminal evidence remains pending or incomplete. Do not infer final cost, tokens, lifecycle, or savings from a running result, a process exit, a guessed relationship, or an aggregate whose ownership cannot be proven.

Analytics must:

- retain actual Pi-reported cost separately from estimates;
- label incomplete coverage;
- avoid double counting parent aggregates and child slices;
- remain local and content-free;
- never retain prompts, code, credentials, transcript text, or absolute workstation paths;
- remove claims that strict descendant profile enforcement exists;
- continue to work when upstream `pi-subagents` is absent.

## Evidence and benchmark boundary

OMP's session-level mechanism has an internal benchmark claim supporting its general planning-to-execution handoff. There is no published child-specific efficacy result establishing that recursive child Prewalk improves quality, cost, or duration.

The local benchmark corpus is currently empty. Child Prewalk must be benchmarked before anyone recommends or enables it by default.

The efficacy benchmark remains a separate frozen protocol:

- Pi `0.82.1`;
- Pi Codex Conversion `3.0.3`;
- frozen prompt hashes, corpus, tools, model policy, and sandbox contract;
- manual, approval-gated, cost-confirmed provider execution only.

Compatibility testing must use stock Pi release candidates, including current stable candidates, and must not mutate the frozen efficacy benchmark.

The child benchmark should compare at least:

- child configured model throughout;
- child configured model followed by child-local Prewalk;
- the current parent-only Prewalk composition.

It should include direct and nested children, mutation and read-only work, retries and fallbacks, failed mutations, long and short tasks, and task outcomes that require recovery after the first edit. Record pass rate, test validity, cost, tokens, duration, retries, fallback use, and terminal evidence coverage. No default is justified until the result is independently reviewed.

## OMP baseline and parity fixture

Before implementation changes:

1. fetch OMP immediately before implementation;
2. resolve and record one immutable commit SHA;
3. record the three prompt paths and hashes;
4. inspect the relevant session and task-agent source;
5. regenerate `test/fixtures/omp-prewalk-parity.json` from that immutable revision;
6. preserve the fixture's revision binding;
7. classify every local scenario against the pinned source.

The fixture must include the current relevant scenario names and classify the two newer `xd://` mutation-tier cases rather than silently dropping them. A moving `main` branch is not a valid parity baseline.

The drift monitor later compares the pinned revision with current upstream source, but it never changes the pinned fixture or prompts automatically.

## Compatibility CI

### Normal push and pull-request checks

Add ordinary push and pull-request checks for the repository's existing validation categories:

- formatting and lint;
- TypeScript typecheck;
- the complete test suite;
- Agent-loop tests;
- RPC smoke;
- Markdown links, using the repository's existing link checker if present;
- package dry-run/content audit;
- `git diff --check`.

Use existing package scripts where available, including likely `lint`, `typecheck`, `test`, `test:agent-loop`, `smoke:rpc`, and package dry-run commands. If a command name differs, acceptance is by behavior, not by preserving a guessed filename or script name.

These checks must not invoke paid providers.

### Pi release discovery

Add scheduled and manual release discovery that queries the complete published stable version list from npm. Do not query only the latest version. A delayed schedule must discover every stable release not yet represented in the ledger.

The discovery record must include the exact npm version, publication metadata when available, package integrity, discovery time, and the source of the observation. Prereleases are manual-only.

Dependabot remains secondary: group exact Pi development pins where useful, but do not rely on Dependabot to test every intermediate stable release.

Maintain one rolling compatibility ledger issue. Each tested stable release gets one idempotent entry containing:

- version and exact package identity;
- test status;
- tested Pi and dependency versions;
- workflow run and artifact identifiers;
- bounded failure summary;
- whether the release is supported, failed, pending, skipped, yanked, or requires review.

Use stable machine-readable markers in the issue body so retries update the existing ledger entry rather than creating duplicates. Open separate deduplicated actionable issues for compatibility failures. A yanked release remains recorded with its observed status; it is not silently deleted or retested forever.

Retention and recovery must be explicit:

- preserve the rolling issue as the durable summary;
- retain raw artifacts for the repository's configured retention period;
- include enough immutable identifiers to recover a ledger entry after artifact expiry;
- rerunning a version must be idempotent;
- a newer report must not overwrite evidence for a different candidate;
- failed reporting retries must not create duplicate issues;
- manual dispatch must permit recovery after schedule delays or disabled schedules.

### Candidate isolation

The candidate-version matrix must be secret-free.

Candidate jobs must:

- use checkout with persisted credentials disabled;
- receive no repository write token, provider credential, or unrelated secret;
- acquire candidate packages before isolation where necessary;
- execute candidate code outside the repository's writable checkout;
- prevent candidate code from writing repository files;
- disable network after acquisition where practical;
- bound CPU, memory, process count, wall time, output size, and artifact size;
- emit strict, schema-validated JSON only;
- preserve no transcripts or credentials.

The candidate job must not patch Pi, patch `pi-subagents`, publish, deploy, merge, or adopt a dependency.

A separate trusted reporting job may have only the minimum permission needed to update issues, such as `issues: write`. It must validate, bound, sanitize, and escape every artifact field. It must never execute candidate-provided strings, commands, paths, scripts, or workflow expressions. It may open or update the ledger and deduplicated failure issues only.

### OMP drift monitoring

Add a read-only scheduled/manual drift check that compares:

- the pinned immutable OMP revision;
- current upstream source at a newly resolved immutable revision;
- exact prompt hashes;
- relevant scenario names;
- session handoff and mutation-gate source behavior;
- the two newer `xd://` mutation-tier scenarios.

Drift reports must be deduplicated by a stable fingerprint containing the pinned revision, current revision, changed paths, hashes, and scenario classification.

Drift is report-only. It must never update prompts, fixtures, runtime code, package pins, or compatibility claims automatically. A human must classify each report as:

- adopt;
- adapt for stock Pi;
- exclude with a reason;
- investigate.

## Paid canaries and benchmark runs

Provider-backed canaries and efficacy benchmark runs remain manual, protected, approval-gated, and cost-confirmed.

Routine CI must not:

- call a paid provider;
- use a personal credential;
- run the benchmark;
- enable child-local Prewalk;
- publish benchmark results;
- treat directional results as a release gate without the documented protocol.

## Scope

### In scope

- replacement of the obsolete patched-Pi compatibility plan;
- exact pinned OMP prompt parity;
- stock-Pi core lifecycle changes;
- explicit release lifecycle;
- upstream `pi-subagents` migration;
- disabled experimental child-local Prewalk;
- public-result analytics coverage;
- required runtime regression tests;
- stock-Pi compatibility discovery and reporting;
- OMP drift reporting;
- security-bounded artifact handling;
- documentation and setup migration.

### Out of scope

- patching Pi or maintaining a Pi fork;
- patching or extending upstream `pi-subagents`;
- global child model ceilings;
- automatic dependency adoption;
- automatic prompt or fixture updates;
- automatic PRs that change runtime behavior;
- auto-merge, publishing, deployment, or installation;
- paid-provider execution in normal CI;
- claiming recursive child Prewalk improves quality or savings without benchmark evidence;
- changing the frozen efficacy benchmark;
- broad analytics redesign unrelated to public delegated evidence.

## Implementation units

Implement these units serially. Each unit must pass its focused checks before the next begins.

### U0. Freeze the source and compatibility contracts

Resolve the immutable OMP commit, prompt paths, hashes, relevant source paths, and scenario names. Regenerate the parity fixture from that revision. Record the candidate Pi compatibility baseline separately from the frozen benchmark baseline.

**Proof:** the fixture and baseline metadata contain immutable revisions and hashes; no moving branch is used.

### U1. Vendor exact prompts and correct provenance

Replace the three local prompt rewrites with exact pinned OMP bytes. Update prompt tests, `README.md`, and `THIRD_PARTY_NOTICES.md` so provenance is truthful.

**Proof:** byte/hash tests pass; a deliberate prompt-byte mutation fails; documentation names the pinned source and adaptation boundary accurately.

### U2. Complete the main-session lifecycle

Update the Prewalk coordinator and extension lifecycle in the existing implementation, including the provider overlay and terminal cleanup:

- keep the overlay active after `agent_settled`;
- implement `/prewalk release`;
- restore the planner in the same transcript;
- record manual release distinctly;
- keep cancellation pre-handoff;
- prevent re-arming after release;
- preserve the route across extension reload in the same live session;
- return to the planner after a true process/session reopen;
- finalize clean shutdown as session-ended and stale crash evidence as interrupted;
- preserve failure and cleanup behavior.

**Proof:** lifecycle tests cover handoff, later turns, release, cancel, failure, live-session extension reload, process/session reopen, clean shutdown, crash recovery, and stale-overlay prevention.

### U3. Remove the fork policy

Delete the runtime dependency on the patched `pi-subagents` fork and remove global execution-profile policy mutation. Remove or repurpose `src/subagent-policy.ts` and `src/execution-profile-policy.ts` only after every call site and test has been classified.

Do not replace the removed ceiling with fallback stripping or another hidden policy.

Update `my-pi-setup` separately so its package pin uses the approved unmodified upstream `pi-subagents` release or exact upstream source reference. Keep machine-local overrides separate from portable settings.

**Proof:** package/config search finds no fork pin or strict descendant-policy claim; upstream child model, thinking, and fallback precedence remain intact; analytics tests still pass with upstream public result shapes.

### U4. Add the disabled experimental child path

Add a child-local extension/configuration path using public per-agent extension/config surfaces and public child identity signals. Keep it off by default and do not add it to `my-pi-setup`.

Implement the exact child rules in this brief, including non-propagation, read-only and plan-mode exclusions, same-model effort handoff, and fail-closed unavailable-target behavior.

**Proof:** focused tests exercise an explicitly opted-in child, an unconfigured child, a reviewer/read-only child, a plan-mode child, a nested descendant, an equal target, an unavailable target, a failed mutation, and a successful mutation.

### U5. Reconcile delegated analytics

Keep direct and nested ownership on public `pi-subagents` result details. Mark missing async/detached terminal evidence pending or incomplete. Remove strict-policy assumptions from reports and tests.

**Proof:** direct costs are counted once; nested costs are counted once; aggregate overlap is excluded; missing terminal evidence never becomes guessed spend.

### U6. Add runtime proof

Add tests before treating compatibility CI as authoritative:

- real stock-Pi manual, threshold, and overflow compaction;
- overlapping primary and auxiliary streams;
- a real request through the Conversion wrapper;
- release lifecycle;
- unmodified upstream foreground, nested, and async evidence;
- child-local experimental behavior;
- child non-propagation;
- current OMP mutation-tier `xd://` scenario classification;
- exact prompt bytes and hashes.

Use deterministic fixtures for ordinary tests. Keep paid-provider checks manual.

### U7. Add compatibility and drift workflows

Add the normal push/PR checks, full npm stable discovery, candidate matrix, trusted issue reporter, rolling ledger, failure issue deduplication, and read-only OMP drift monitor.

Workflow filenames and helper names should follow repository conventions; do not assume a path that does not exist yet. Likely implementation locations are a `.github/workflows/` set of workflow files and bounded scripts under `scripts/compatibility/`, with policy tests under `test/`.

**Proof:** structural tests enforce permissions, no persisted credentials, no secrets in candidate jobs, bounded artifacts, strict schema validation, no candidate execution in the reporter, issue idempotence, retry behavior, yanked handling, and drift report-only behavior.

### U8. Finish documentation and migration

Update the main README and third-party notices. Explain:

- exact pinned prompt provenance;
- stock-Pi support;
- one-way executor routing;
- `/prewalk release` versus `/prewalk cancel`;
- independent child model behavior;
- disabled experimental child-local Prewalk;
- no strict descendant enforcement;
- incomplete delegated evidence;
- compatibility ledger and drift issue behavior;
- manual canary and benchmark boundaries;
- migration from the fork pin in `my-pi-setup`.

Preserve all historical plans. The old automated compatibility plan receives only the superseded notice below.

## Acceptance criteria

1. Prewalk's core behavior is proved against stock Pi public APIs and documented adaptations are explicit.
2. The three prompts match one immutable OMP revision byte-for-byte and tests fail on drift.
3. Main-session executor routing remains active across later turns until `/prewalk release`.
4. `/prewalk release` restores the planner in the same transcript, records a manual-release outcome, and does not re-arm.
5. `/prewalk cancel` remains the pre-handoff cancellation path.
6. Executor routing survives extension reload in the live session but a closed/reopened session starts on the planner, matching OMP's ephemeral persistence boundary.
7. No patched Pi or patched `pi-subagents` dependency remains.
8. Children retain independent upstream model, thinking, and fallback precedence.
9. Child-local Prewalk is explicit, disabled by default, experimental, OMP-faithful, and non-propagating.
10. No strict descendant-profile claim remains in code or documentation.
11. Public direct and nested delegated cost evidence is reconciled without guessing or double counting.
12. Required runtime tests pass before compatibility CI is considered authoritative.
13. The frozen efficacy benchmark remains isolated from candidate Pi compatibility tests.
14. Candidate CI has no repository write credentials or provider secrets.
15. Only the trusted reporter can write issues, and it never executes candidate strings.
16. The ledger and issue reporters are idempotent across retries, delayed schedules, yanked releases, and artifact recovery.
17. OMP drift is reported but never auto-adopted.
18. Paid canaries and benchmark runs remain manual, protected, approval-gated, and cost-confirmed.

## Verification categories

Run the repository's existing scripts where available. At minimum, the implementation must provide passing evidence for:

- formatting/lint;
- typecheck;
- all tests;
- Agent-loop tests;
- RPC smoke;
- Markdown links;
- package dry-run;
- `git diff --check`;
- exact prompt hash tests;
- lifecycle and release tests;
- stock-Pi compaction tests;
- overlapping-stream tests;
- Conversion wrapper tests;
- upstream `pi-subagents` public-result tests;
- child-local opt-in and non-propagation tests;
- workflow policy and artifact-schema tests;
- compatibility ledger idempotence tests;
- OMP drift classification tests.

A provider canary or efficacy benchmark is not part of routine implementation acceptance.

## Risks and evidence gaps

- Child-local Prewalk may reduce quality after a difficult first edit. No child-specific efficacy result currently supports enabling it.
- Independent child defaults may cost more than the patched ceiling. Benchmark evidence is required before recommending a default.
- Upstream may change public child-result shapes. Candidate compatibility tests and incomplete-coverage labels must fail safely.
- OMP may change prompts or mutation semantics. Drift reports require human classification.
- A delayed npm schedule may miss a release unless discovery scans the full stable version list.
- A yanked release may remain in historical records while no longer being installable.
- Artifact expiry may remove raw evidence. The ledger must retain immutable identifiers and bounded summaries sufficient to request a rerun.
- A trusted reporter could mishandle untrusted fields. Strict schemas, field bounds, escaping, and no dynamic execution are mandatory.
- The local benchmark corpus is empty. No efficacy, quality, savings, or duration claim may be made from it.
- Native Responses compaction remains unsupported during an active Prewalk route unless a later implementation proves executor-aware replay.

## Rollback

If runtime changes regress:

1. disable Prewalk automatic admission;
2. use `/prewalk cancel` for active pre-handoff runs;
3. use `/prewalk release` only for active post-handoff routes;
4. restore the previous extension package from the last known-good release;
5. restore the upstream `pi-subagents` package pin if migration validation fails;
6. leave historical receipts and compatibility ledger entries intact;
7. revert only the runtime or workflow commit under review.

Never roll back by deleting analytics, credentials, unrelated sessions, worktrees, caches, or historical plans. A failed candidate or drift report must not modify the installed runtime.
