# Research: standalone Prewalk as a public Pi extension

> Superseded on 2026-07-30. The current implementation uses Pi 0.82.1's public
> provider registration seam to wrap the conversion-owned `openai-codex`
> stream. It keeps Sol selected while routing primary post-gate requests to
> Luna. See the current README and
> `docs/plans/2026-07-30-002-feat-extension-only-sol-luna-prewalk-plan.md`.

## Summary

**Verdict: B / feasible with a small manual handoff; D / not feasible for a seamless in-process handoff on Pi 0.82.1.** Packaging, installation, removal, transcript persistence, UI prompts, and custom commands are all supported publicly. The blocking host limitation is narrow but decisive: every public in-process model/thinking setter available to an extension also writes the global defaults, and neither 0.82.1 nor current `main` exposes a session-only equivalent.

The smallest supported extension-only compromise is: let Prewalk plan in the current saved session, then show a copyable restart command using the same session ID/path plus `--model` and `--thinking`; the user exits and runs it. That preserves the live transcript while startup flags select the target runtime for the resumed session without requiring Prewalk to call the persistent setters.

## Findings

1. **[Blocker] Public extension setters are not session-only in 0.82.1.** `ExtensionAPI` declares `setModel(model: Model<any>): Promise<boolean>` and `setThinkingLevel(level: ThinkingLevel): void` in `packages/coding-agent/src/core/extensions/types.ts`. Their host implementation routes through `AgentSession.setModel` / `setThinkingLevel`; the installed/tagged 0.82.1 source records model/thinking changes in session history **and** calls `settingsManager.setDefaultModelAndProvider(...)` / `settingsManager.setDefaultThinkingLevel(...)`. Thus an extension cannot make the required “rest of this session only” change through these APIs without changing future-session defaults. [0.82.1 declarations](https://github.com/earendil-works/pi-mono/blob/v0.82.1/packages/coding-agent/src/core/extensions/types.ts) · [0.82.1 implementation](https://github.com/earendil-works/pi-mono/blob/v0.82.1/packages/coding-agent/src/core/agent-session.ts)

2. **[Blocker] Newer official source does not currently remove the limitation.** Current `main` retains the same public setter signatures and the same persistence-coupled `AgentSession` behavior. No overload/options object such as `{ persistDefault: false }`, no `setSessionModel`, and no extension context method for replacing the active request model/thinking level is declared. The upstream request is still open as [issue #5263](https://github.com/earendil-works/pi-mono/issues/5263), and the proposed implementation is still unmerged as [PR #5270](https://github.com/earendil-works/pi-mono/pull/5270). Therefore upgrading from 0.82.1 is not, by itself, a verified fix. [current declarations](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/extensions/types.ts) · [current implementation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/agent-session.ts) · [current changelog](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md)

3. **[Major] `/model`, model cycling, and thinking controls do not provide an alternate nonpersistent seam.** Official extension lifecycle docs say `/model` and Ctrl+P emit `model_select`, while thinking controls and `pi.setThinkingLevel()` emit `thinking_level_select`; those events are notifications, not veto/replace hooks. The declarations expose only `ctx.model`, `ctx.thinkingLevel`, model registry access, and the persistent setters. An extension can prompt/select a target with `ctx.ui.select()`, but selection UI alone cannot apply it session-locally. [extension model events/API](https://github.com/earendil-works/pi-mono/blob/v0.82.1/packages/coding-agent/docs/extensions.md) · [types](https://github.com/earendil-works/pi-mono/blob/v0.82.1/packages/coding-agent/src/core/extensions/types.ts)

4. **[Major] Context/request interception cannot safely substitute a target model.** The public `context` hook may replace messages; `before_agent_start` may inject a message or replace the system prompt; `before_provider_request` may replace the already-provider-specific payload; tool hooks may block/transform tools/results. None returns a model or thinking-level override. Rewriting a serialized provider request does not change the host’s selected provider transport, authentication, model metadata, context window, accounting, or reasoning configuration, so it is not a generic model-switch seam. [events documentation](https://github.com/earendil-works/pi-mono/blob/v0.82.1/packages/coding-agent/docs/extensions.md) · [event result types](https://github.com/earendil-works/pi-mono/blob/v0.82.1/packages/coding-agent/src/core/extensions/types.ts)

5. **[Supported compromise] Resume the same transcript with startup overrides.** Official 0.82.1 CLI docs support `--session <path|id>`, `--model <pattern>` (including `provider/id` and `:<thinking>` shorthand), and `--thinking <level>`. Sessions are automatically saved, and `/session` exposes the file/ID. A standalone Prewalk extension can finish planning, display a command such as `pi --session <id> --model <provider/model> --thinking <level>`, and optionally call the public `ctx.shutdown()` after confirmation. The user runs the command in the same terminal. This keeps one persisted transcript/session and avoids calling the extension setters. The manual exit/restart is the only material friction. [usage: sessions and CLI flags](https://github.com/earendil-works/pi-mono/blob/v0.82.1/packages/coding-agent/docs/usage.md) · [session context format](https://github.com/earendil-works/pi-mono/blob/v0.82.1/packages/coding-agent/docs/session-format.md)

   **Verified:** all three startup flags exist; saved sessions retain transcript and model/thinking change entries. **Inference requiring a smoke test before shipping:** startup `--model`/`--thinking` overrides do not rewrite global defaults. Source structure and the distinction between CLI overrides and settings defaults support this, but the official usage text does not explicitly promise “nonpersistent.”

6. **[Pass] Standalone install/uninstall distribution is fully supported.** A package can publish a `package.json` with `keywords: ["pi-package"]` and `pi.extensions`; npm, git, URL, and local sources are accepted. Commands include `pi install npm:<pkg>`, `pi remove npm:<pkg>` / `pi uninstall npm:<pkg>`, `pi list`, and update commands. A one-run trial is supported by `pi -e npm:<pkg>`, installed user packages live under `~/.pi/agent/npm/`, and package records live in `~/.pi/agent/settings.json`. [Pi packages](https://github.com/earendil-works/pi-mono/blob/v0.82.1/packages/coding-agent/docs/packages.md) · [extension distribution](https://github.com/earendil-works/pi-mono/blob/v0.82.1/packages/coding-agent/docs/extensions.md) · [npm package](https://www.npmjs.com/package/%40earendil-works/pi-coding-agent)

7. **[Rejected] Do not monkey-patch private runtime state.** Although SDK consumers can access `session.agent.state.model` and `.thinkingLevel`, an ordinary extension receives `ExtensionAPI` plus read-only context snapshots—not the owning `AgentSession`. Reaching internal runner/session objects, importing private paths, or mutating captured internals would be unsupported, version-fragile, and potentially desynchronize session history, UI, authentication, compaction, and accounting. The SDK is a public embedding API, not evidence that the same object is exposed to installed extensions. [SDK AgentState access](https://github.com/earendil-works/pi-mono/blob/v0.82.1/packages/coding-agent/docs/sdk.md) · [extension context declarations](https://github.com/earendil-works/pi-mono/blob/v0.82.1/packages/coding-agent/src/core/extensions/types.ts)

8. **[Rejected] Do not build a custom proxy/provider to simulate handoff.** Provider extensions can register models and custom streaming, but emulating arbitrary target providers would duplicate Pi’s routing, authentication, reasoning mapping, payload conversion, streaming, retries, usage, and future compatibility. It is gross overengineering relative to one supported restart command and does not create a true host-level model switch. [custom provider API](https://github.com/earendil-works/pi-mono/blob/v0.82.1/packages/coding-agent/docs/custom-provider.md)

## Recommended architecture

### Preferred: extension-only with manual handoff

- Ship Prewalk as a normal npm Pi package containing one extension and its planner resources.
- Run planning in the active saved session.
- Let the user choose the target model/thinking level using extension UI and public model-registry data.
- At handoff, render an exact, safely quoted resume command using the current session ID/path:
  `pi --session <id-or-path> --model <provider/model> --thinking <level>`.
- Ask for confirmation, then shut down through `ctx.shutdown()` or let the user exit manually.
- On resume, the target model continues from the same transcript for that session.

This is the best fit for the stated priority: public, installable/uninstallable, understandable, and no patched binary. Do not automate terminal replacement/spawn unless a later UX test proves the single copy/paste step unacceptable.

### Smallest fallback if manual restart is rejected

Use a **version-gated update-time source patch tool**, not a permanent fork or binary monkey patch:

1. Verify the installed package identity/version and an exact source hash for `packages/coding-agent/src/core/agent-session.ts` (or the installed compiled equivalent).
2. Apply the smallest upstream-shaped change: add a nonpersistent option/internal method so extension calls can update agent state and session entries without calling the two `SettingsManager` default setters.
3. Patch the public declaration/binding only as necessary (ideally matching PR #5270), then run a focused smoke test for transcript continuity and unchanged `settings.json`.
4. Refuse unknown versions/hashes, keep a backup, provide uninstall/restore, and automatically stop patching once an official release lands.

This fallback should remain dormant unless the restart compromise is explicitly rejected. Track issue #5263 / PR #5270 rather than maintaining a broad downstream fork.

## Release comparison

| Surface | 0.82.1 | Current `main` | Consequence |
| --- | --- | --- | --- |
| `ExtensionAPI.setModel(model)` | Present; persistence-coupled | Same public shape | No seamless session-only handoff |
| `ExtensionAPI.setThinkingLevel(level)` | Present; persistence-coupled | Same public shape | No seamless session-only handoff |
| Model/thinking notification events | Present; notification-only | Present | Cannot replace the selection |
| Startup `--session`, `--model`, `--thinking` | Present | Present | Enables manual same-transcript restart |
| npm/git Pi packages and remove/uninstall | Present | Present | Standalone distribution is viable |
| Upstream session-only setter work | Not released | Issue open; PR unmerged | Watch upstream; do not claim upgrade solves it |

## Sources

- **Kept:** [`v0.82.1` extension declarations](https://github.com/earendil-works/pi-mono/blob/v0.82.1/packages/coding-agent/src/core/extensions/types.ts) — exact public signatures and event result shapes.
- **Kept:** [`v0.82.1` AgentSession](https://github.com/earendil-works/pi-mono/blob/v0.82.1/packages/coding-agent/src/core/agent-session.ts) — exact persistence coupling.
- **Kept:** [current declarations](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/extensions/types.ts) and [current AgentSession](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/agent-session.ts) — newer-source comparison.
- **Kept:** [official extension docs](https://github.com/earendil-works/pi-mono/blob/v0.82.1/packages/coding-agent/docs/extensions.md) — supported hooks, UI, commands, and distribution.
- **Kept:** [official package docs](https://github.com/earendil-works/pi-mono/blob/v0.82.1/packages/coding-agent/docs/packages.md) — install/remove/update and manifest details.
- **Kept:** [official usage docs](https://github.com/earendil-works/pi-mono/blob/v0.82.1/packages/coding-agent/docs/usage.md) — startup/session/model/thinking flags.
- **Kept:** [official SDK docs](https://github.com/earendil-works/pi-mono/blob/v0.82.1/packages/coding-agent/docs/sdk.md) — distinction between SDK-owned sessions and extension context.
- **Kept:** [issue #5263](https://github.com/earendil-works/pi-mono/issues/5263) and [PR #5270](https://github.com/earendil-works/pi-mono/pull/5270) — upstream status of the missing seam.
- **Dropped:** mirrors, blogs, and third-party extension examples — excluded because the task required primary sources.

## Gaps and residual risks

- Run one local 0.82.1 smoke test before implementation: snapshot `~/.pi/agent/settings.json`, resume a fixture session with explicit `--model`/`--thinking`, and confirm the file is byte-identical while the resumed session uses the target values.
- Confirm quoting behavior for session paths and model IDs on macOS/Linux shells.
- Upstream issue/PR status can change; recheck at implementation time and prefer a released public option when available.
- Resuming the same session intentionally adds model/thinking change entries to that session; this is desired transcript metadata, not global-default persistence.
