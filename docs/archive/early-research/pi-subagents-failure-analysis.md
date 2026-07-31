# Research: Why Pi subagents fail frequently and whether higher turn counts are the right fix

## Summary

The dominant failure is orchestration policy, not model or installation failure: 7 of 11 recent launches failed, with 6 caused by ad hoc hard turn budgets and one caused by an invalid `verified` acceptance contract. The two screenshot failures are lifecycle/contract failures; one worker was interrupted with only partial output, while the other finished its model work but was rejected solely because `verified` acceptance had no runtime `verify` command. Raising every cap would reduce symptoms but preserve the unsafe failure mode; mutation-capable workers should have no hard turn/tool cap and should instead receive smaller serial delivery slices, while optional caps belong only on narrowly scoped read-only roles.

## Findings

1. **Critical — hard budgets selected by the parent explain 6/7 failures.** The supplied history shows six budget failures: worker 72 turns versus `45+5`, planner 32 versus `10+2`, reviewers 18 versus `8+2`, 11 versus `8+2`, and 21 versus `15+3`, plus oracle 12 versus `8+2`. Two other workers completed at 16 turns under `35+5` and 30 under `55+8`. These values were inline launch fields chosen ad hoc by the parent; they were not inherited from persistent configuration. The installed guidance explicitly says turn count measures neither delivery safety nor progress and prohibits `turnBudget`/hard `toolBudget` for implementation workers, fix workers, or any mutation-capable child. See `skills/pi-subagents/references/prompting-and-roles.md`, sections **Long-running work** and **Review-loop technique**, and the upstream incident. [Issue #482](https://github.com/nicobailon/pi-subagents/issues/482)

2. **High — the screenshot's two red lifecycle results do not prove that both implementations failed.** The budget-aborted worker cannot be considered complete: its edits may exist, but the runtime returned partial output and the worktree/tests must be inspected before reuse. By contrast, the supplied U3 record says the model succeeded at 47 turns/46 tools within `50+5`; lifecycle finalization then rejected it because `acceptance.level: "verified"` had no `acceptance.verify` commands. That is an acceptance-configuration failure after model completion, not evidence that its implementation was wrong. The runtime implements this distinction directly: when verified acceptance has no commands, it adds `verification-config: failed`, sets the ledger to `rejected`, and returns (`src/runs/shared/acceptance.ts:1112-1116`).

3. **High — `45+5` can truthfully abort at 72 because 50 is a safe-boundary threshold, not an unconditional kill point.** `turnBudgetDecision()` computes `hardLimit = maxTurns + graceTurns`; at or beyond that limit it returns `defer` whenever tool work is active or starting, unless a strict hard limit is forced. It aborts only at a later non-tool/safe assistant boundary (`src/runs/shared/turn-budget.ts`, `turnBudgetDecision`). Thus a child that repeatedly emits tool-use turns after turn 50 can continue to turn 72 before the runtime sees a safe boundary. U1's 72 assistant turns and 71 tool calls are consistent with that mechanism. This behavior was introduced specifically to avoid killing a writer mid-mutation; the 0.35.0 changelog says timeout and explicit stop still take precedence and reiterates that hard caps remain inappropriate for mutation-capable workers (`CHANGELOG.md`, 0.35.0 **Fixed**, issue #482 entry). [Issue #482](https://github.com/nicobailon/pi-subagents/issues/482)

4. **High — increasing budgets globally is the wrong fix; policy should vary by role.**
   - **Worker/fix worker or any edit-authorized reviewer:** omit `turnBudget` and hard `toolBudget`. Give one bounded milestone, one writer, explicit success criteria, and targeted validation; split large work into serial milestones. Use a generous elapsed deadline only as an operational backstop, never as proof of safe delivery, and request checkpoints after active tool work returns.
   - **Planner/reviewer/oracle/researcher that is explicitly read-only:** first narrow the task (specific files, diff, or review angle). Hard caps are permissible only here. If a cap is operationally required, start above observed demand rather than below it—for this small sample, approximately planner `40+5`, reviewer `30+5`, oracle `20+3`—then tune from more history. These are guardrails, not completion guarantees; omission is reasonable for bounded tasks.
   - **Tool budgets:** if used for read-only agents, block read/search tools after the hard limit so the model can still return final text. Do not apply count limits to writers because counts do not measure buildability or completion.

   This matches the installed recommendations to “prefer narrow tasks,” keep writes single-threaded, and use serial milestones (`skills/pi-subagents/references/constraints-and-recipes.md`, **Best Practices** and **Fable mode for complex work**) and the upstream incident's conclusion that the runtime cannot infer repository safety. [Issue #482](https://github.com/nicobailon/pi-subagents/issues/482)

5. **High — exact acceptance correction.** Use one of these invocation shapes:

   ```ts
   // Ordinary writer: child evidence, but no parent-executed verification.
   acceptance: {
     level: "checked",
     evidence: ["changed-files", "tests-added", "commands-run", "residual-risks", "no-staged-files"]
   }
   ```

   ```ts
   // Verified writer: runtime must have commands it can execute itself.
   acceptance: {
     level: "verified",
     verify: [
       { id: "focused-tests", command: "<project-specific test command>", timeoutMs: 120000 }
     ]
   }
   ```

   If no reliable command is known, downgrade to `checked`; a child's claimed command output is evidence, not runtime verification. For read-only reviewers (and ordinary read-only planner/oracle calls), **omit `acceptance` entirely** rather than forcing writer evidence or `verified`. This is the documented rule in `skills/pi-subagents/references/constraints-and-recipes.md`, **Clarify → Plan → Implement → Review**, and is enforced at `src/runs/shared/acceptance.ts:1112-1128`. [Upstream acceptance source](https://github.com/nicobailon/pi-subagents/blob/main/src/runs/shared/acceptance.ts)

6. **Medium — current discovery/model configuration is healthy and is not the root cause.** Installed `package.json` identifies pi-subagents 0.37.2. `~/.pi/agent/settings.json` sets `openai-codex/gpt-5.6-sol` and high thinking but contains no `subagents` object; both `~/.pi/agent/extensions/subagent/config.json` and project `.pi/settings.json` are absent. With only nine builtins and no custom agents/chains, workers therefore inherit the current model/thinking and builtin role behavior. Nothing in these facts creates the inline `turnBudget`, `toolBudget`, or `acceptance` objects; the parent supplied those per launch.

7. **Medium — recommended stable configuration/invocation policy.**
   - **Persistent user/project settings (`~/.pi/agent/settings.json` or `.pi/settings.json`):** use `subagents.defaultModel`, `subagents.defaultThinking`, and `subagents.agentOverrides.<role>` only when a stable model/thinking/role override is actually desired. The current inheritance is already deterministic, so no persistent change is required to fix these failures. Persistent agent defaults can also live in agent frontmatter, but hard writer caps should not be encoded there.
   - **Extension runtime config (`~/.pi/agent/extensions/subagent/config.json`):** reserve for orchestration/runtime behavior such as async defaults, concurrency, artifact location, wait/control behavior, and scheduling—not for inventing acceptance evidence or task-specific delivery budgets.
   - **Per run:** set `task`, context, output, and task-specific acceptance. Omit hard budgets for writers; omit acceptance for read-only reviewers; use `checked` for normal writers; use `verified` only with nonempty project-specific `verify` commands. Keep `context: "fork"` for a worker that needs parent history and prefer `context: "fresh"` for adversarial read-only reviewers (`skills/pi-subagents/references/execution-controls.md`, **Forked context**; `prompting-and-roles.md`, **Builtin Agents**).

## Recommended policy table

| Role | Scope | Turn/tool budget | Acceptance | Context |
| --- | --- | --- | --- | --- |
| Worker / fix worker | One serial milestone; sole writer | Omit hard caps | `checked`, or `verified` + nonempty `verify` | `fork` when inherited decisions matter |
| Edit-authorized reviewer | One narrowly defined fix | Omit hard caps | Same as writer | Usually `fork`/explicit evidence |
| Read-only reviewer | One diff angle or file set | Usually omit; optional generous read-only cap | Omit | `fresh` |
| Planner | One bounded plan surface | Optional read-only cap; not `10+2` for repo-wide work | Omit unless a specific attestation is needed | `fork` only when history matters |
| Oracle | One decision/risk question | Optional read-only cap | Omit | `fork` by design |
| Researcher/scout | Defined questions and retrieval stop rule | Optional read-only cap | Omit | Usually `fresh` |

## Sources

- Kept: [Upstream incident #482](https://github.com/nicobailon/pi-subagents/issues/482) — primary incident report explaining why turn counts are not delivery-safety metrics and why writer caps remain prohibited.
- Kept: `.../pi-subagents/src/runs/shared/turn-budget.ts` ([upstream](https://github.com/nicobailon/pi-subagents/blob/main/src/runs/shared/turn-budget.ts)) — primary implementation of deferred termination.
- Kept: `.../pi-subagents/src/runs/shared/acceptance.ts` ([upstream](https://github.com/nicobailon/pi-subagents/blob/main/src/runs/shared/acceptance.ts)) — primary implementation of acceptance inference and verified-command rejection.
- Kept: `.../pi-subagents/CHANGELOG.md`, versions 0.33.0 and 0.35.0 ([upstream](https://github.com/nicobailon/pi-subagents/blob/main/CHANGELOG.md)) — primary release history for budget introduction and deferred-termination correction.
- Kept: installed `skills/pi-subagents/references/{execution-controls,constraints-and-recipes,prompting-and-roles}.md` — package-owned operational guidance for context, role scoping, budgets, and acceptance.
- Kept: `~/.pi/agent/settings.json` and installed `package.json` — primary local evidence for model/thinking inheritance and installed version.
- Dropped: third-party articles and search summaries — excluded because the task required primary sources only.

## Gaps

The four supplied artifact paths were not present when read during this run (each returned `ENOENT`), so artifact-level fields could not be independently re-extracted; the run counts and U1–U4 classifications above use the aggregated history supplied with the task. A budget-aborted worker's implementation state remains unknown until its actual worktree diff and targeted tests are inspected. The suggested read-only cap numbers are provisional floors from only 11 launches, not statistically stable percentiles.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Report provides severity-ranked findings with concrete local paths, source function/line references, upstream links, exact acceptance corrections, and a role-specific invocation policy."
    }
  ],
  "changedFiles": [
    "research/pi-subagents-failure-analysis.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Primary-source inspection of installed pi-subagents 0.37.2 docs/source, local settings, supplied artifact paths, and upstream issue #482",
      "result": "passed",
      "summary": "Core implementation/config conclusions verified; supplied artifact paths returned ENOENT and are disclosed under Gaps."
    }
  ],
  "validationOutput": [
    "Confirmed turnBudgetDecision defers termination during active/starting tool work.",
    "Confirmed verified acceptance without verify commands is rejected at acceptance.ts:1112-1116.",
    "Confirmed settings.json has no subagents key and both requested persistent config files are absent."
  ],
  "residualRisks": [
    "The missing run artifacts prevented independent reconstruction of the supplied 11-launch aggregate.",
    "The proposed read-only numeric caps require tuning against a larger history sample."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added a primary-source failure analysis and stable role-specific subagent budget/acceptance policy; no product code or configuration changed.",
  "reviewFindings": [
    "no blockers",
    "high: hard count caps on mutation-capable workers are the dominant and unsafe failure source",
    "high: verified acceptance without runtime verify commands caused a lifecycle rejection rather than an implementation failure"
  ],
  "manualNotes": "Only the requested report file was written."
}
```
