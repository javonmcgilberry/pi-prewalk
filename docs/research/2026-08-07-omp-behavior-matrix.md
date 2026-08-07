# Prewalk behavior matrix: this extension against Oh My Pi

Compares Prewalk, a standalone extension on stock Pi, with Oh My Pi's built-in
prewalk. Rows record what each side does, whether the difference is forced or
chosen, and the evidence behind the claim.

References are `file:line` at the time of writing.

- **OMP** — `~/webdev/oh-my-pi`, `packages/coding-agent/src/session/prewalk.ts`
  and neighbors.
- **Stock Pi** — `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`
  at 0.84.1, read from `node_modules`. Line numbers move between Pi releases;
  the same statements sit 3 lines earlier at 0.82.1.
- **This extension** — `extensions/prewalk.ts`, `src/`.

## Relationship to the pinned parity fixture

This document does not replace `test/fixtures/omp-prewalk-parity.json`. That
fixture is the authority for *scenario* parity: it pins an Oh My Pi revision,
hashes the three prompt assets, and classifies each upstream coordinator and
degradation scenario as `direct`, `pi-adapted`, or `excluded` with a rationale.
`test/omp-parity.test.ts` enforces it, so scenario drift fails a test run.

This document covers what the fixture deliberately does not: architecture-level
differences such as the handoff mechanism, compaction ownership, the context
window floor, and features that exist on only one side. Scenario-level claims
belong in the fixture, where they are machine-checked. Add rows here only for
behavior a scenario cannot express.

Two fixture rationales predate cross-provider support and now read as stale:
"treats a target effort the model clamps back to the active effort as a no-op"
and "switches when a same-model target clears auto mode even though efforts both
resolve to undefined". Both are `excluded` on the grounds that "phase one" has no
same-model target or provider-agnostic effort routing. Refreshing them requires
re-reading those scenarios at the pinned revision, so they are left alone here
rather than edited from inference.

## The one difference everything else follows from

OMP owns its harness, so its handoff is a real session model switch:
`setModelTemporary(target, thinkingLevel, { ephemeral: true })`
(`session/prewalk.ts:138`, `session/model-controls.ts:255`). The session becomes
the executor, and every model-aware subsystem follows automatically.

An extension cannot do that. Stock Pi's public `setModel` writes the user's
saved default (`agent-session.js:1197` calls `setDefaultModelAndProvider` at
`:1205`), so using it would change the model for every future session. Checked
again at 0.84.1: `ExtensionAPI` still declares no session-only model setter. The
limitation is recorded in
`docs/research/prewalk-extension-only-feasibility.md`.

So Prewalk keeps the planner selected and overlays the provider's
`streamSimple`, substituting the executor for primary Agent-loop requests
(`src/provider-overlay.ts`). Pi's session still believes the planner is active.
Several rows below are consequences of that, not preferences.

## Matrix

| # | Behavior | OMP | This extension | Kind | Evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | Handoff mechanism | Real session model switch, ephemeral | Provider `streamSimple` overlay; selected model never changes | **Forced** | OMP `session/prewalk.ts:138`; here `src/provider-overlay.ts` |
| 2 | Persists a new default model | No, `ephemeral: true` | No, nothing is written | Same outcome | `session/model-controls.ts:255`; overlay writes no settings |
| 3 | Handoff trigger | First `edit`/`write` tool result after the todo gate | Same | Same | `session/prewalk.ts:22,101`; `src/core.ts` `onTurnEnd` |
| 4 | Todo gate before handoff | Yes | Yes | Same | `session/prewalk.ts:83,100`; `src/core.ts` |
| 5 | Hidden deep-plan nudge | Injected once | Injected once | Same | `session/prewalk.ts:107`; `PREWALK_PLAN_MESSAGE_TYPE` |
| 6 | Continuation nudge | Yes | Yes | Same | `session/prewalk.ts:88`; `requestContinuation` |
| 7 | Checklist at handoff | Yes | Yes | Same | `session/prewalk.ts:146`; `PREWALK_CHECKLIST_MESSAGE_TYPE` |
| 8 | Plan nudge scrubbed from history | `#scrubPlanNudge` | `pi.on("context")` filter | Same outcome | `session/prewalk.ts:127`; `extensions/prewalk.ts` context hook |
| 9 | Cross-provider planner/executor | Yes, and it is the default | **Yes, as of this change** | Same | `priority.json` `smol`; `src/provider-overlay.ts` executor delegate |
| 10 | Cross-API planner/executor | Yes | Yes | Same | see "Cross-provider evidence" below |
| 11 | Default executor | `smol` role, resolved from a priority list | Configured `executor` plus an ordered `executorFallbacks` chain | **Chosen** | `priority.json`; `src/core.ts` `parseConfig` |
| 12 | Executor degrades when unavailable | Yes, walks the priority list | **Yes, walks the configured chain** | Same | `model-resolver.ts:966`; `src/executor-chain.ts` |
| 12b | Executor chain is inferred, not configured | Yes, a built-in priority list ships | No, the chain is written by hand | **Gap** | `priority.json`; no built-in default chain here |
| 13 | Executor context window must be >= planner's | No such rule | Yes, enforced per candidate | **Forced** | no OMP check; `src/executor-chain.ts` `context-window-too-small` |
| 14 | Auto-compaction protects the executor | Yes, sized against the switched-to model | No, Pi sizes against the planner | **Forced** | `agent-session.js:1517` uses `this.model` |
| 14b | Context-overflow *recovery* covers the executor | Yes | No, the check is skipped entirely | **Forced** | `agent-session.js:1522` `sameModel` gate |
| 15 | Same model + same effort handoff | Graceful no-op with a notice | **Graceful no-op with a notice** | Same | `thinking.ts:169` `prewalkWouldBeNoop`; `src/executor-chain.ts` `same-as-planner` |
| 16 | Effort-only downgrade, same model | Supported | Supported | Same | OMP fixed in #6659; `src/executor-chain.ts` compares reasoning before rejecting |
| 17 | Unresolvable or unauthorized target | Skips the handoff, session continues | **Stays unarmed with a notice, session continues** | Same | `main.ts:1007-1019` (issue #6064); `unavailableExecutorNotice` |
| 18 | Subagent/child prewalk | Yes, per-agent frontmatter and settings | Behind `experimentalChild`, default off | **Chosen** | `docs/task-agent-discovery.md:39`; `src/core.ts` |
| 19 | Plan-yolo | Yes, separate feature | Not implemented | **Chosen** | `session/prewalk.ts:238` |
| 20 | Status line annotation | Yes | Yes | Same | `src/status.ts` |
| 21 | Manual release back to planner | Not present | `/prewalk release` | **Addition** | `extensions/prewalk.ts` `release` |
| 22 | Local cost analytics and receipts | Not present | Yes | **Addition** | `src/analytics*.ts` |
| 23 | Provider-ownership drift detection | Not needed | Yes, `provider-drift`, for both the planner registration and the executor model | **Forced** | `verifyOverlayOwnership`; `resolveExecutor` |
| 24 | Native Responses compaction | Supported | Refused, `native-compaction-unsupported` | **Forced** | `nativeResponsesCompactionState` |
| 25 | Model display names | Generic | `gpt-5.6-sol`/`luna` special-cased | **Cosmetic gap** | `src/status.ts:17`; `extensions/prewalk.ts` `modelLabelForNotice` |
| 26 | `configure` offers cross-provider executors | n/a, no wizard | **Yes, planner's provider ranked first** | **Addition** | `extensions/prewalk.ts` `configure` |

## Cross-provider evidence

The blocking concern was whether history from one API family can be replayed to
another. It can. Stock Pi already normalizes it, in
`pi-ai/dist/api/transform-messages.js`, whose own docstring says "Normalize tool
call ID for cross-provider compatibility."

`transformMessages` computes
`isSameModel = provider && api && model.id all match`, then for a non-matching
assistant message:

- `thinking` with a signature becomes plain text; the signature is dropped
- `redacted` thinking is dropped
- `textSignature` and `thoughtSignature` are stripped
- tool call ids are renormalized, and tool results are remapped to match
- errored and aborted assistant turns are skipped
- orphaned tool calls receive synthetic results

Verified by direct execution, first against 0.82.1 and re-run unchanged against
0.84.1, for anthropic to openai, openai to anthropic, and anthropic to google.
Every pair converted without throwing, and tool call/result pairing survived.

**The load-bearing detail:** `openai/sol -> openai/luna`, a same-provider pair on
two different model ids, takes the *identical* `isSameModel === false` branch and
loses the same signatures. The shipped Sol-to-Luna default already replays
degraded history today, so cross-provider introduces no new degradation for the
API families named above. That is what makes row 9 safe rather than merely
possible.

The claim is deliberately scoped. `transformMessages` is the shared generic
pass; the final wire conversion still belongs to each target API adapter
(`anthropic-messages.js`, `openai-responses-shared.js`, `google-shared.js`), so
a cross-API pair does not take a byte-identical path end to end — only an
identical generic-normalization path. Transports that forward context to a
backend without their own normalization, such as `pi-messages.js`, and any
provider a third party registers, are outside what was tested. Treat those as
unverified rather than supported.

An earlier draft of this document claimed `openai-responses-shared.js` would
throw on a foreign `thinkingSignature` via an unguarded `JSON.parse`. That was
wrong: `transformMessages` converts the block to text first, so the parse never
receives foreign input. The claim was retracted after being tested rather than
read.

## Where the differences are worth keeping

Rows 13, 14, and 14b travel together, and the picture is worse than compaction
sizing alone. Pi sizes compaction against its selected model, which stays the
planner. Pi's *overflow recovery* is then gated on `sameModel`
(`agent-session.js:1522`), comparing the assistant message's provider and model
against the selected model. Replies produced by the executor carry the
executor's identity while the selected model is the planner, so that comparison
is false and the overflow branch never runs. During the executor phase Prewalk
therefore has neither executor-sized compaction nor executor overflow recovery.

The context-window floor is the only thing standing in for both, and it is a
conservative guard rather than a proof. Equal nominal windows do not guarantee
equal usable history, because tokenizers differ across families, so a pair that
passes the floor can still overflow the executor. Built-in providers clamp
output with `clampMaxTokensToContext` (`pi-ai/dist/api/simple-options.js`),
which covers the reserve for those families but not for a custom transport.
Removing the floor without executor-aware compaction would trade a clear startup
error for provider errors mid-run.

Rows 15 and 17 used to be stricter than OMP: an unusable executor failed the
whole run. That is no longer the case. Oh My Pi shipped the strict version too
and had to reverse it in issue #6064, after an unresolvable hand-off target
locked users out of the app; `main.ts:1007-1019` now warns and leaves prewalk
unarmed. Prewalk does the same, and the overlay is restored on the way out so
nothing is left installed.

The planner keeps the strict treatment. A missing or unauthorized *planner* is
not a degraded hand-off, it is a session with nothing to hand off from, so
`resolveExecutor` still throws for that case.

Row 12b is the remaining half of that gap. Oh My Pi ships `priority.json`, so a
user who has configured nothing still gets a sensible hand-off target and a
chain to fall back through. Prewalk now degrades through a chain, but only one
written by hand, so an unconfigured install still has a single point of failure.
Shipping a default chain, ordered by the planner's provider first, would close
it.

One caution learned from reading Oh My Pi: `priority.json` is a *preference
order*, not an allowlist. Nothing in `session/prewalk.ts` validates a target
against it, and `--prewalk-into` accepts any pattern the ordinary model resolver
accepts (`main.ts:1002`). A default chain here should behave the same way, as a
starting point a user can override rather than a set of permitted models.

## Not verified

- Whether losing reasoning signatures measurably degrades executor quality or
  prompt-cache hit rate. Untested here, and it already applies to the shipped
  same-provider default.
- Google and Bedrock-family converters beyond the three pairs executed above.
- Whether OMP's published guidance recommends a specific planner/executor pair.
  No such document was found in the repository; the `smol` and `slow` priority
  lists are the only in-repo signal.
- Rows 5, 6, 7, 8, 18, 19, 20 were checked against OMP source but not executed
  in a live OMP session.
- Cross-family replay through `pi-messages.js` or any third-party registered
  transport. Only the three built-in adapters above were executed.
- Whether a tokenizer difference between two equal-window models can overflow
  the executor in practice. The mechanism is real; the frequency is unmeasured.
- Cross-provider routing has unit coverage but has never run against two live
  provider credentials end to end.
