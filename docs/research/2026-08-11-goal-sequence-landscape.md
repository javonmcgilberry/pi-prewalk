# Research: GoalSequence, Pi subagents, and OMP

**Status:** research only; no GoalSequence implementation is proposed by this document

**Date:** 2026-08-11

**Question:** What would GoalSequence add beyond Pi and its subagent tooling, how
would it compose with parent and child agents, and would it materially harden
the Prewalk experience?

## Executive answer

GoalSequence is not another child-agent runner. Its useful distinction would be
a durable, user-controlled record of an ordered set of goals:

```text
goal revision -> exact attempt -> Prewalk trajectory -> user disposition
```

The user would decide whether an attempt is done, failed, retried, or cancelled.
The next goal would not start until the previous attempt and its descendants
had settled and cleanup had been acknowledged.

Pi core does not provide that product concept. However, the current
`pi-subagents` package already provides much of the surrounding orchestration:
sequential and parallel workflows, retries, checkpoints, missions, durable
state, artifacts, background work, supervision, and schedules. OMP also has a
strong first-class task and child-agent system with typed results, isolated
worktrees, nested agents, and live supervision.

Therefore, GoalSequence should not be justified as a replacement for either
subagent system. If pursued, it should be a small control layer above them: a
user-owned goal ledger, ordering gate, and recovery model. It would harden the
workflow around Prewalk, not replace or substantially change Prewalk's internal
planner-to-executor handoff.

## Scope and evidence

This report compares four different things that are easy to conflate:

1. **Pi core:** sessions, branching, resuming, extension APIs, and one agent
   trajectory.
2. **Pi plus `pi-subagents`:** an optional Pi extension that delegates work and
   runs scripted multi-agent workflows.
3. **OMP (Oh My Pi):** a separate Pi-derived coding agent with a first-class
   `task` tool and Agent Hub.
4. **GoalSequence:** the paused, design-only proposal preserved outside the
   repository's product tree.

The local evidence reviewed for this report was:

- current Prewalk checkout at `bb9d8c2`;
- installed `pi-subagents` version `0.45.2`;
- OMP checkout `can1357/oh-my-pi` at `45e12e5`;
- the preserved GoalSequence brief at
  `/tmp/refactor-pi-prewalk/phase-7/paused-user-superseded/`.

The OMP conclusions are bounded to that inspected revision. They describe
what the source and documentation show, not a claim that OMP can never add a
different feature later.

## What Pi core already provides

Pi core provides the substrate for a session-local agent trajectory:

- transcript and session persistence;
- session branching and forking;
- resume and session switching;
- extension commands, tools, events, and session entries;
- the public `AgentSession` and extension APIs used by packages.

It does not provide a first-class user-owned sequence of semantic goals. In
particular, Pi core does not define:

- immutable goal revisions;
- attempt ordinals that cannot be rebound to another run;
- a user-only `done`, `fail`, `retry`, or `cancel` decision;
- a durable rule that the next goal waits for the exact previous attempt to
  settle;
- recovery that distinguishes an interrupted attempt from an accepted goal.

Pi's session fork or branch is therefore not a GoalSequence. A fork preserves
or branches conversation state; it does not mean that a user-defined project
goal was completed or that the next goal is authorized to begin.

## What current `pi-subagents` already provides

The installed `pi-subagents` package describes itself as an extension for
single-agent delegation and scripted multi-agent workflows. Its current skill
and source provide:

- `workflowScript` execution with serial runs, parallel groups, branching,
  retries, gates, and aggregation;
- child agents with different roles, models, tools, and output schemas;
- asynchronous and background execution;
- pause, resume, steer, interrupt, and stop controls;
- nested parent-child runs and supervisor messaging;
- mission records with objective, status, runs, artifacts, receipts, and
  durable JSON state;
- follow-up work attached to an existing mission with `missionId`;
- scheduled one-shot and recurring workflow launches.

Its mission support is important, but it is not the same as GoalSequence. A
mission is primarily a durable objective and run history. A goal mission can
be active, paused, or budget-exhausted, and a workflow can use state such as
`nextReadyAction`. That is useful for continuation, but it is not an
immutable, ordered list of goal revisions with a separate user-authoritative
outcome for every attempt.

The practical consequence is that many proposed GoalSequence workflows can be
implemented today without new product code. For example:

```text
scout -> worker -> human checkpoint -> reviewer -> human checkpoint
```

If that is the desired behavior, `pi-subagents` should be tried first. A new
GoalSequence layer would otherwise duplicate its workflow engine, mission
storage, child controls, and scheduling.

## What OMP provides

The inspected OMP revision has a different emphasis. Its first-class `task`
system is designed for parent-to-child delegation:

- one task can fan out to several agents;
- `task.batch` supplies shared context and per-child work;
- child results can be schema-validated and returned to the parent;
- children can use isolated worktrees or branches;
- nested children are represented in a status tree;
- Agent Hub shows live child activity and allows steering, revival, and
  termination;
- children can contact their supervisor when blocked on a decision;
- child sessions do not inherit the entire parent conversation, so context and
  artifacts must be passed deliberately.

That is a strong answer to:

> “Have a parent investigate a problem, ask several specialists to work in
> parallel, collect typed results, and then decide what to do next.”

The inspected OMP sources did not show a first-class feature matching the
exact GoalSequence contract: an immutable user-authored ordered goal list in
which only the user can complete or retry each goal and the next goal is
blocked on the previous attempt's settled state. OMP can approximate that with
parent prompts, task calls, checkpoints, scripts, and files, but that remains
orchestration policy rather than a distinct goal-sequence product model.

## Parent-child composition

The safest composition is:

```text
GoalSequence coordinator
  -> one goal attempt
    -> one parent/orchestrator trajectory
      -> zero or more child agents
```

Children may run in parallel inside a goal. The sequence remains serial across
goals. A child finishing is not enough to complete the goal. The parent must
aggregate child results, the Prewalk trajectory must settle, and the user must
choose the disposition.

Each child should retain its own local:

- Prewalk extension state;
- host-event correlation state;
- planner and executor route;
- todo and mutation gates;
- runtime lease;
- compaction and failure handling;
- analytics and artifacts.

GoalSequence should not rewrite a child model, inject parent lifecycle state,
or schedule descendants. It should observe the parent attempt through a narrow
port and record the aggregate outcome.

This also requires an explicit goal context packet. Neither Pi child workflows
nor OMP children should be expected to reconstruct the parent's full reasoning
history. The packet should contain the goal revision, acceptance criteria,
prior artifacts, relevant context, attempt identity, and expected output
contract.

## What GoalSequence would add

GoalSequence would be justified only by these additional guarantees:

### 1. Immutable identity

The executable identity would be:

```text
(logical goal ID, immutable revision, attempt ordinal)
```

An attempt could bind to at most one Prewalk run ID and epoch. A retry would
create a new attempt rather than rebind an old one.

### 2. User authority

The model and child agents could report findings, but they could not mark the
goal complete. Handoff success, a clean test result, or a child exit code would
not silently become a user acceptance decision.

### 3. Exact serial gating

The next goal would require evidence that the previous attempt and all of its
descendants were settled, its runtime and route were released, and its final
state was durably recorded.

### 4. Cross-run recovery

After reload or restart, the system could distinguish:

- a goal that was never started;
- an active attempt that was interrupted;
- an attempt that failed before cleanup;
- an attempt waiting for user disposition;
- a goal already accepted;
- a retry that must use a new identity.

That is the part neither ordinary Pi sessions nor generic child delegation
make explicit.

## Would this harden Prewalk?

### It could harden the surrounding experience

It could make repeated Prewalk use more reliable by adding:

- a clear project-level progress view;
- safer retry and cancellation behavior;
- fewer duplicate or accidentally rebound runs;
- durable links between goals, attempts, runs, and artifacts;
- explicit recovery after interruption or restart;
- a clear answer to “did the model stop, and did that count?”;
- deliberate user control over expensive work.

### It would not replace Prewalk's internal hardening

It would not by itself improve planner-to-executor routing, mutation proof,
todo validation, compaction, runtime leases, or host-event correlation. Those
remain Prewalk concerns. GoalSequence would harden the control plane around
multiple runs, not the handoff algorithm inside one run.

### It could make the system worse

A broad implementation could introduce:

- a second scheduler beside `pi-subagents`;
- duplicated mission or run state;
- parent and child lifecycle leakage;
- accidental completion based on child exit;
- races while cancelling or cleaning up a live trajectory;
- a new authority that conflicts with Prewalk's existing recovery rules.

The original brief therefore required proof of a safe stop-and-cleanup
handshake using public Pi APIs. Without that proof, an automatic adapter should
not ship.

## Recommendation

Do not revive GoalSequence as another general-purpose subagent scheduler.

If the feature becomes a real priority, take this narrower path:

1. Try the actual workflow with current `pi-subagents` missions,
   `workflowScript`, and checkpoints.
2. Use OMP's `task` and Agent Hub as the comparison point for parent-child
   execution, not as a reason to copy its task API.
3. If the remaining pain is still real, extract a host-neutral goal ledger and
   reducer for identity, ordering, user disposition, and recovery.
4. Treat a parent run plus its descendants as one goal attempt.
5. Add only narrow Pi and OpenCode ports for starting, observing, settling,
   cancelling, and releasing an attempt.
6. Keep scheduling, child selection, and task execution in the existing host
   systems.

The current conclusion is therefore:

- **ordinary parent-child delegation:** already covered by `pi-subagents` and
  OMP;
- **durable, user-controlled, serial project goals:** a real remaining gap;
- **Prewalk hardening:** useful as an outer workflow layer, but not a reason to
  put a scheduler inside Prewalk.

## Sources and related documents

### Local source snapshots

- Installed `pi-subagents` `0.45.2`: `README.md`,
  `skills/pi-subagents/SKILL.md`,
  `skills/pi-subagents/references/execution-controls.md`, and `src/missions/`.
- OMP `can1357/oh-my-pi` revision `45e12e5`: `README.md`,
  `docs/agent-hub.md`, `docs/task-agent-discovery.md`, `docs/session-tree-plan.md`,
  and the `packages/coding-agent` task implementation.
- Paused GoalSequence design brief:
  `/tmp/refactor-pi-prewalk/phase-7/paused-user-superseded/`, SHA-256
  `02aafabf5f0356dcd5aae4d529d195ff7822b21ccb7a930e7c6b7476f3949b18`.

### Public references

- [`Pi`](https://github.com/earendil-works/pi)
- [`pi-subagents`](https://github.com/nicobailon/pi-subagents)
- [`pi-subagents workflow controls`](https://github.com/nicobailon/pi-subagents/blob/main/skills/pi-subagents/references/execution-controls.md)
- [`Oh My Pi`](https://github.com/can1357/oh-my-pi)
- [`Oh My Pi Agent Hub`](https://github.com/can1357/oh-my-pi/blob/main/docs/agent-hub.md)
- [`Oh My Pi task-agent discovery`](https://github.com/can1357/oh-my-pi/blob/main/docs/task-agent-discovery.md)

### Prewalk documents

- [`Prewalk versus OMP`](../prewalk-vs-omp.md)
- [`Repository structure`](../architecture/repository-structure.md)
- [`Prewalk documentation index`](../README.md)
- [`Pi subagent orchestration research`](pi-subagents-upstream-confirmation.md)
