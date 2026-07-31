# Prewalk Extension-Only Implementation Verification

Date: 2026-07-29

## Result

The supported restart architecture is implemented and installed from:

`/Users/javonmcgilberry/.pi/pi-prework/prewalk`

The legacy loose extension was removed, so a fresh Pi process loads one
`/prewalk` registration from the package. The active configuration is:

- target: `openai-codex/gpt-5.6-luna`
- thinking: `low`
- automatic mode: enabled
- cross-provider acknowledgements: none required for the current same-provider pair

Pi's configured fresh-session defaults remain:

- `openai-codex/gpt-5.6-sol`
- thinking `high`

## Verification Evidence

### Offline

- TypeScript: passed
- Vitest: 17 tests passed across coordinator and adapter suites
- Pi package load: custom `--prewalk-handoff` flag discovered
- npm pack dry run: 6 intended runtime files, 32,332 unpacked bytes
- isolated Pi package lifecycle: install, list, and remove all passed
- Pi Lens full scan: no diagnostics in the four TypeScript source/test files

### RPC startup isolation

A fixture session was resumed through a temporary copied agent profile with:

`--prewalk-handoff`, `--session`, `--model openai-codex/gpt-5.6-luna`, and
`--thinking low`.

Assertions passed:

- exact fixture session ID remained active;
- runtime model was `openai-codex/gpt-5.6-luna`;
- runtime thinking was `low`;
- temporary `settings.json` remained byte-for-byte unchanged.

The test was repeated with `defaultThinkingLevel: high`, CLI `--thinking low`,
and a three-second wait for `SettingsManager`'s queued write before process
termination. Runtime thinking was `low`, the file remained byte-identical both
mid-run and after exit, and the persisted default remained `high`. The
`setThinkingLevel(created.session.thinkingLevel)` call in `dist/main.js` is a
no-op here because the created session already holds the CLI-selected level and
`AgentSession.setThinkingLevel` writes settings only when the effective level
changes.

### Provider-backed canary

A temporary saved session asked `gpt-5.6-sol` to make one minimal edit under a
manual Prewalk run. The extension used real Pi RPC and built-in tools.

Assertions passed:

- `prewalk_checkpoint` call persisted;
- successful checkpoint result persisted;
- the reserved built-in `edit` succeeded;
- its successful tool result remained in session JSONL after `ctx.abort()`;
- the file contained the expected edit;
- `agent_settled` fired and the handoff UI was presented;
- the full hidden planning instruction was absent from session JSONL;
- Pi emitted no stderr errors.

## Residual Boundaries

- The handoff is intentionally manual and POSIX-only.
- The user must exit the planner Pi before launching the target command.
- The checkpoint checklist is intentionally stored and provider-visible.
- Context-hook extensions that run after Prewalk can observe projected context.
- Only Pi's typed built-in `edit` and `write` tools qualify.
- Authentication can still expire between mutation and restart.
