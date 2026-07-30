# Research: Pi subagent mutation-safe orchestration policy

## Summary

The proposal is strongly aligned with current upstream `main` (verified at commit `60ed7a5d93d9f16e86b7b41a03233728fdc1714c`), especially items 1–4 and 6. The main refinement is item 5: per-run budgets and acceptance are a sound policy for task-specific controls, but upstream **does** support persistent child defaults for `turnBudget`, `timeoutMs`, and `acceptance` in agent frontmatter (and documents global `turnBudget` precedence), so it would be inaccurate to say no persistent child turn-budget default exists.

## Findings

1. **Hard count caps should stay off mutation-capable children; optional caps remain appropriate for explicitly read-only children.** Current README and packaged skill guidance explicitly say not to set `turnBudget` or a hard `toolBudget` on implementation workers, fix workers, edit-authorized reviewers, or any mutation-capable child. They also explicitly preserve hard caps for bounded, explicitly read-only scouts, reviewers, and validators. This is a conservative orchestration policy, not a runtime prohibition. [README parameter guidance](https://github.com/nicobailon/pi-subagents/blob/main/README.md#parameter-reference) · [Packaged skill](https://github.com/nicobailon/pi-subagents/blob/main/skills/pi-subagents/SKILL.md) · [Prompting/roles reference](https://github.com/nicobailon/pi-subagents/blob/main/skills/pi-subagents/references/prompting-and-roles.md#review-loop-technique)

2. **Issue #482’s original immediate turn-budget race is historical, but its safety conclusion still stands.** Current `main` defers a hard turn-budget termination when an assistant starts tool work at the limit, exposing `termination-deferred` until a later assistant boundary. However, elapsed timeout and explicit stop retain precedence, and the runtime cannot infer whether a worktree is buildable or safe. Therefore the proposal should ground the no-count-cap rule in delivery safety, not claim that current turn-budget handling still always kills mid-tool. [Issue #482](https://github.com/nicobailon/pi-subagents/issues/482) · [CHANGELOG](https://github.com/nicobailon/pi-subagents/blob/main/CHANGELOG.md) · [Merged guidance PR #483](https://github.com/nicobailon/pi-subagents/pull/483)

3. **The writer-slice/checkpoint policy is correct, with one wording refinement.** Upstream recommends one writer per cwd/worktree, a narrow delivery slice, and an outer `timeoutMs`/`maxRuntimeMs` with enough margin. The parent should request the checkpoint **before** the deadline (for example with `steer` or an attention notice), while instructing the child to checkpoint only after the current tool returns. The deadline itself must not be the trigger or be described as mutation-safe. The checkpoint should include changed files, build/test state, remaining work, and commit/PR state. Note that foreground runs have a 30-minute fallback when no timeout is supplied, whereas async runs have no default elapsed timeout; an async writer that is meant to be bounded needs an explicit deadline. [README parameter guidance](https://github.com/nicobailon/pi-subagents/blob/main/README.md#parameter-reference) · [Execution controls](https://github.com/nicobailon/pi-subagents/blob/main/skills/pi-subagents/references/execution-controls.md#asyncbackground)

4. **The acceptance recommendation is accurate.** Upstream says ordinary writer tasks infer/use `checked`; `verified` means runtime verification commands passed, not merely that the child reported commands. Current source rejects `verified` when `acceptance.verify` is empty with `verified acceptance requires runtime verify commands.` For reviewer/read-only calls, omit explicit acceptance; omission still allows upstream’s inferred lightweight read-only attestation, so “omit” should not be described as “disable all acceptance.” [README acceptance gates](https://github.com/nicobailon/pi-subagents/blob/main/README.md#acceptance-gates) · [Acceptance source](https://github.com/nicobailon/pi-subagents/blob/main/src/runs/shared/acceptance.ts) · [Constraints/recipes](https://github.com/nicobailon/pi-subagents/blob/main/skills/pi-subagents/references/constraints-and-recipes.md#clarify--plan--implement--review-self-orchestrated-workflow)

5. **Fork for inherited implementation decisions and fresh for adversarial review is upstream’s intended split.** A fork is a real branch of the persisted parent session and inherits its history; it is not a filtered summary and fails if no persisted parent session is available. Packaged `worker` defaults to fork. Fresh-context reviewers are preferred for adversarial inspection of the repository/diff without inheriting the implementer’s reasoning. [Execution controls: forked context](https://github.com/nicobailon/pi-subagents/blob/main/skills/pi-subagents/references/execution-controls.md#forked-context) · [Constraints](https://github.com/nicobailon/pi-subagents/blob/main/skills/pi-subagents/references/constraints-and-recipes.md#important-constraints)

6. **Item 5 needs qualification, not rejection.** Stable model/thinking/agent-role overrides belong in `~/.pi/agent/settings.json` or project `.pi/settings.json`, while task-specific acceptance and budgets are best kept visible in the invocation. But upstream also supports persistent single-agent defaults for `async`, `timeoutMs`, `turnBudget`, and `acceptance` in agent frontmatter; README states `turnBudget` precedence is explicit call → agent default → global `turnBudget` config. Thus revise the last sentence to: “Use orchestration instructions for parent behavioral guardrails; do not mistake a persistent child count default for a mutation-safety policy.” [README agent frontmatter](https://github.com/nicobailon/pi-subagents/blob/main/README.md#agent-frontmatter) · [Prompting/roles settings](https://github.com/nicobailon/pi-subagents/blob/main/skills/pi-subagents/references/prompting-and-roles.md#builtin-agents)

7. **Serial milestones are the best-supported response to very large implementation work.** Upstream’s Fable workflow says to break large work into serial milestones rather than concurrent writes, and its large-work recipe gives each milestone one writer, a validation contract, fresh review/validation, a fix pass, and parent acceptance. Raising count caps is not offered as the safety mechanism. [Constraints/recipes: Fable mode](https://github.com/nicobailon/pi-subagents/blob/main/skills/pi-subagents/references/constraints-and-recipes.md#fable-mode-for-complex-work)

### Recommended refined policy text

- Keep hard turn/tool-call caps off every mutation-capable child. Optional count caps are appropriate only when the child is explicitly read-only and bounded.
- Give each writer one narrow serial slice and one cwd/worktree, set an elapsed deadline with margin, and request a checkpoint before that deadline to be emitted after current tool work returns. Never treat timeout as mutation-safe.
- Use `checked` for ordinary writers. Use `verified` only with at least one valid runtime `verify` command. Omit explicit acceptance for read-only reviewer calls.
- Use fork when implementation must inherit approved decisions; use fresh for adversarial review. Remember that fork requires a persisted parent session and inherits full history.
- Put stable model/thinking/role overrides in Pi user/project settings. Keep genuinely task-specific budgets/acceptance in the invocation, while acknowledging that agent frontmatter/global child defaults exist. Express parent behavioral safety rules as orchestration instructions, not as count-limit guarantees.
- Split very large implementation into serial, independently accepted milestones.

## Sources

- Kept: [README on current main](https://github.com/nicobailon/pi-subagents/blob/main/README.md) — canonical public behavior, parameter, settings, context, acceptance, and budget guidance.
- Kept: [Packaged `pi-subagents` skill](https://github.com/nicobailon/pi-subagents/tree/main/skills/pi-subagents) — current orchestration policy and detailed recipes shipped to parents.
- Kept: [Acceptance runtime source](https://github.com/nicobailon/pi-subagents/blob/main/src/runs/shared/acceptance.ts) — direct evidence that empty verification configuration rejects `verified` acceptance.
- Kept: [Issue #482](https://github.com/nicobailon/pi-subagents/issues/482) and [PR #483](https://github.com/nicobailon/pi-subagents/pull/483) — incident rationale, ownership boundary, and maintainer-merged guidance.
- Kept: [CHANGELOG on main](https://github.com/nicobailon/pi-subagents/blob/main/CHANGELOG.md) and [v0.35.0 release](https://github.com/nicobailon/pi-subagents/releases/tag/v0.35.0) — confirms the runtime deferral fix and continued conservative writer guidance.
- Dropped: forks, third-party extensions, gists, and unrelated repositories returned by broad search — excluded by the first-party-only requirement.

## Gaps

No material gap remains for the policy decision. Upstream could change after the inspected main SHA; future consumers should recheck README/skill guidance and `src/runs/shared/acceptance.ts`. “Best-supported” here means best supported by current upstream documentation and source, not proof that elapsed deadlines can make arbitrary filesystem mutation transactional.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Only research/pi-subagents-upstream-confirmation.md was written; no product code or configuration was edited."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "The report cites current-main README, packaged skill references, runtime source, changelog/release, issue #482, and merged PR #483, and records the inspected main SHA."
    }
  ],
  "changedFiles": [
    "research/pi-subagents-upstream-confirmation.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "First-party GitHub web searches across README, skills references, source, changelog/releases, issue #482, and PR #483",
      "result": "passed",
      "summary": "Located and cross-checked the current upstream policy and implementation evidence."
    },
    {
      "command": "GitHub API recursive tree lookup for nicobailon/pi-subagents main",
      "result": "passed",
      "summary": "Resolved current main to 60ed7a5d93d9f16e86b7b41a03233728fdc1714c and identified authoritative source paths."
    },
    {
      "command": "Inspect src/runs/shared/acceptance.ts on current main",
      "result": "passed",
      "summary": "Confirmed verified acceptance with zero verify commands is rejected at runtime."
    }
  ],
  "validationOutput": [
    "All six proposed policy items were checked against current upstream main; item 5 was identified as needing qualification.",
    "Optional hard count caps were confirmed as supported guidance for explicitly read-only children only."
  ],
  "residualRisks": [
    "Upstream main may change after SHA 60ed7a5d93d9f16e86b7b41a03233728fdc1714c."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added one cited research report; no product code or configuration changes.",
  "reviewFindings": [
    "no blockers"
  ],
  "manualNotes": "No tests were added because this was a documentation-only research task. The report file was written directly and not staged."
}
```
