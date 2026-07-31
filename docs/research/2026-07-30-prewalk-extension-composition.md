# Prewalk extension composition research

Date: 2026-07-30

## Verdict

The installed Context Mode and Pi Codex Conversion packages are current and both
run successfully with Prewalk. The composition is useful but not complete:

- Context Mode's MCP tools, lifecycle capture, usage capture, session snapshots,
  and post-compaction restoration are active.
- Context Mode records Codex Conversion Code Mode work as the outer `exec` tool,
  so nested `exec_command` and `apply_patch` traces lose semantic event detail.
- Codex Conversion native Responses compaction V2 is installed but disabled.
- Native Responses compaction must remain disabled for Prewalk until its
  compaction input honors Prewalk's hidden-message scrubbing.

## Installed and upstream state

| Component | Installed | Current upstream | Result |
| --- | --- | --- | --- |
| Pi | 0.83.0 | 0.83.0 used by the adapter | Current |
| `@howaboua/pi-codex-conversion` | 3.0.4 | 3.0.4 at `18c8366a0af0a88c25e5309ec634cda3157687ab` | Current |
| `context-mode` | 1.0.169 | 1.0.169 at `252e74b7a947b5fbb5624037f8710d3a5319af3c` | Current |

Sources:

- [Pi Codex Conversion package](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/18c8366a0af0a88c25e5309ec634cda3157687ab/packages/pi-codex-conversion)
- [Pi Codex Conversion 3.0.4 changelog](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/18c8366a0af0a88c25e5309ec634cda3157687ab/packages/pi-codex-conversion/CHANGELOG.md)
- [Context Mode source](https://github.com/mksglu/context-mode/tree/252e74b7a947b5fbb5624037f8710d3a5319af3c)
- [Pi extension lifecycle documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)

## Context Mode with Codex Conversion

The package is loaded as both a Pi extension and an MCP server. Its Pi extension
registers tool, session, usage, and compaction hooks, while its MCP bridge
registers the `ctx_*` tools before the first model turn.

The inspected Prewalk session recorded 92 Context Mode events through the final
Luna response:

- 46 usage events
- 42 post-tool events
- 4 user-prompt events

This proves the extension remained active before and after the Sol-to-Luna
handoff. The `ctx_*` calls also completed successfully in the transcript.

The limitation is Code Mode trace visibility. Context Mode's Pi adapter handles
the top-level `tool_result` name and input. Codex Conversion exposes a Code Mode
cell as top-level `exec` with nested traces in `details.traces`. Context Mode
does not inspect those traces, so it stores a generic `exec` event instead of
the nested file edit, patch, or shell operation. This does not break routing or
the MCP tools, but it makes Context Mode's event history and active memory less
precise.

Primary source:

- [Context Mode Pi extension](https://github.com/mksglu/context-mode/blob/252e74b7a947b5fbb5624037f8710d3a5319af3c/src/adapters/pi/extension.ts)

## Codex native compaction

`agent/pi-codex-conversion.json` currently sets:

```json
{
  "compaction": {
    "responsesCompaction": false
  }
}
```

Pi's own automatic compaction remains enabled, so the current runtime uses Pi's
textual summary compaction. Enabling V2 through `/codex openai` would make Codex
Conversion handle supported OpenAI Responses compactions and return an encrypted
OpenAI checkpoint to Pi.

All registered `session_before_compact` handlers run in package order. Context
Mode snapshots its event state and returns no compaction result. Prewalk removes
its hidden planning messages from Pi's compaction preparation. Codex Conversion
may then return the actual compaction result. This lifecycle composition is
valid.

The input composition is not yet safe for Prewalk. Codex Conversion's native
compactor serializes `ctx.sessionManager.getBranch()` and
`ctx.sessionManager.getEntries()` directly. It excludes only its own display
message type. It does not consume the filtered
`event.preparation.messagesToSummarize` and does not recognize Prewalk's hidden
custom message types. Native V2 can therefore encrypt stale Prewalk planning,
continuation, checklist, or reminder messages into the checkpoint even though
Pi's normal compactor would omit them.

Native compaction also resolves its target from `ctx.model`. Prewalk deliberately
keeps Pi's selected model on Sol, so a post-handoff native compaction request
would use Sol and Pi's selected thinking level rather than Prewalk's effective
Luna route. The encrypted checkpoint is designed for reuse across models on the
same provider, API, and endpoint, but the request would not use the executor
model.

Primary sources:

- [Compaction event registration](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/18c8366a0af0a88c25e5309ec634cda3157687ab/packages/pi-codex-conversion/src/extension/events.ts)
- [Native compaction input construction](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/18c8366a0af0a88c25e5309ec634cda3157687ab/packages/pi-codex-conversion/src/adapter/compaction/compaction.ts)
- [Session serializer and custom-message filter](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/18c8366a0af0a88c25e5309ec634cda3157687ab/packages/pi-codex-conversion/src/adapter/compaction/serializer.ts)
- [Compaction runtime model resolution](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/18c8366a0af0a88c25e5309ec634cda3157687ab/packages/pi-codex-conversion/src/adapter/compaction/compaction-runtime.ts)

## Recommended next work

1. Keep native Responses compaction disabled for Prewalk sessions.
2. Add Code Mode nested-trace extraction to Context Mode's Pi adapter upstream,
   with fixtures for successful and failed `apply_patch` and `exec_command`.
3. Ask Pi Codex Conversion to honor Pi's prepared compaction messages or expose
   a public custom-message exclusion registry. Add a composition test containing
   Prewalk hidden prompts before enabling V2.
4. Decide explicitly whether post-handoff compaction should use selected Sol or
   effective Luna. Test cost, checkpoint replay, and assistant continuity.
5. Generalize Prewalk configuration only after the provider overlay accepts a
   validated planner/executor pair and reasoning policy. Use Pi's command UI
   primitives for a `/prewalk configure` wizard rather than depending on the
   model-facing `ask_user` tool.

The configuration wizard should validate the selected provider streams and model
APIs before saving. Same-provider pairs such as Opus-to-Sonnet are the first
provider-neutral target. Cross-provider pairs need a separate transport and
checkpoint policy.
