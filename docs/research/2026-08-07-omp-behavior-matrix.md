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

The pinned fixture's model-clamping scenario is now `pi-adapted`: the executor
resolver compares the configured target with the planner after Pi clamps both
levels to the target model, and the configure wizard and experimental child
guard use the same helper. The remaining auto-mode scenario stays `excluded`:
Stock Pi exposes the current concrete thinking level to extensions but not the
configured auto-versus-fixed selector, so Prewalk cannot reproduce that
distinction through its public API.

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
(`src/model-runtime.ts` over `src/provider-overlay.ts`). Pi's session still
believes the planner is active.
Several rows below are consequences of that, not preferences.

## Matrix

| # | Behavior | OMP | This extension | Kind | Evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | Handoff mechanism | Real session model switch, ephemeral | Run-scoped temporary-model lease over a provider `streamSimple` overlay; selected model never changes | **Forced** | OMP `session/prewalk.ts:138`; here `src/model-runtime.ts` |
| 2 | Persists a new default model | No, `ephemeral: true` | No, nothing is written | Same outcome | `session/model-controls.ts:255`; overlay writes no settings |
| 3 | Handoff trigger | First `edit`/`write` tool result after the todo gate | Same | Same | `session/prewalk.ts:22,101`; `src/core.ts` `onTurnEnd` |
| 4 | Todo gate before handoff | Yes | Yes | Same | `session/prewalk.ts:83,100`; `src/core.ts` |
| 5 | Hidden deep-plan nudge | Injected once | Injected once | Same | `session/prewalk.ts:107`; `PREWALK_PLAN_MESSAGE_TYPE` |
| 6 | Continuation nudge | Yes | Yes | Same | `session/prewalk.ts:88`; `requestContinuation` |
| 7 | Checklist at handoff | Yes | Yes | Same | `session/prewalk.ts:146`; `PREWALK_CHECKLIST_MESSAGE_TYPE` |
| 8 | Plan nudge scrubbed from history | `#scrubPlanNudge` | Context filter plus exact outgoing executor-context filter | Same outcome | `session/prewalk.ts:127`; `extensions/prewalk.ts`; `src/model-runtime.ts` |
| 9 | Cross-provider planner/executor | Yes, and it is the default | **Yes, including authenticated provider-backed responses** | Same | `priority.json` `smol`; provider-backed evidence below |
| 10 | Cross-API planner/executor | Yes | **Yes, including one third-party transport** | Same at the routing boundary | see "Cross-provider evidence" below |
| 11 | Default executor | `smol` role, resolved from a priority list | Configured `executor` plus inferred or explicit ordered fallbacks | **Chosen** | OMP `priority.json`; `src/default-executors.ts`; `src/core.ts` |
| 12 | Executor degrades when unavailable | Yes, walks the priority list | **Yes, walks inferred or configured chain** | Same | OMP `model-resolver.ts:966`; `src/executor-chain.ts` |
| 12b | Executor chain is inferred, not configured | Yes, a built-in priority list ships | **Yes, from OMP's `smol` patterns; explicit `[]` opts out** | Same outcome | OMP `priority.json`; `src/default-executors.ts`; `test/extension.test.ts` |
| 13 | Executor context window must be >= planner's | No such rule | **No startup floor; request-time executor guard** | Same outcome with safety guard | `src/executor-chain.ts`; `src/executor-context.ts`; `test/extension.test.ts` |
| 14 | Auto-compaction protects the executor | Yes, sized against the switched-to model | **Executor watchdog uses Pi's effective reserve (16,384 fallback), waits for settlement, and reuses native compaction when it already ran** | Same outcome with public-API limit | OMP `agent-session.js:1517`; `src/model-runtime.ts`; `extensions/prewalk.ts` |
| 14b | Context-overflow *recovery* covers the executor | Yes | **Preflight and failed detectable overflow compact and retry; completed over-window responses compact without replay; unknown native overflow remains outside Pi's `sameModel` path** | Partial parity | OMP `agent-session.js:1522`; `src/provider-overlay.ts`; `test/provider-overlay.test.ts` |
| 15 | Same model + same effective effort handoff | Graceful no-op with a notice | **Graceful no-op with a notice** | Same | `thinking.ts:169` `prewalkWouldBeNoop`; `src/executor-chain.ts` `isSameModelAtEffectiveReasoning` |
| 16 | Effort-only downgrade, same model | Supported | Supported | Same | OMP fixed in #6659; `src/executor-chain.ts` compares model-clamped reasoning before rejecting |
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

## What the live smoke test caught

Unit tests with hand-built fakes reported cross-provider working while the real
thing could not arm at all. `src/provider-overlay.ts` registered the overlay as
`{ ...previous, streamSimple }`, and Pi rejects a `streamSimple` registration
that carries no `api`. Only a provider another extension had already configured
contributed one, so the overlay installed exclusively on `openai-codex`, where
Pi Codex Conversion supplies it. A planner on any stock provider failed with a
swallowed error surfaced as `provider-unavailable`.

The bug predates cross-provider support and was never same-provider specific. It
survived because the existing RPC smoke test never armed a run: it exercised
`status`, `cancel`, and `reload`, none of which install the overlay.

Two lessons are now encoded in `scripts/smoke-rpc-cross-provider.mjs`. It arms a
run rather than only booting the extension, and it asserts against the audit
trail rather than stderr, because a refused arm never reaches stderr and the
first version of this test passed against a deliberately broken build.

The authenticated canary now covers the rest of the route. Two isolated,
provider-backed runs completed the todo gate, bounded fixture mutation, and
executor handoff:

- `openai-codex/gpt-5.6-luna` to `anthropic/claude-haiku-4-5`
- `anthropic/claude-haiku-4-5` to `cursor/gemini-3.6-flash`

Both runs recorded the executor model in the assistant transcript, reached
`handoff-completed`, left Pi's selected planner unchanged, and kept the isolated
settings file byte-identical. The Cursor run also proves that a third-party
transport can receive and finish a Prewalk handoff. It does not prove the
transport's serialized wire payload was inspected: both custom transports
bypass Pi's `before_provider_request` hook, and the canary records that as
`target-payload-hook-unavailable` rather than treating missing observation as a
clean payload.

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
backend without their own normalization, such as `pi-messages.js`, remain
outside the conversion test. The Cursor canary verifies routing and a complete
response through one third-party transport, not its internal normalization or
final wire payload, and not every registered provider.

An earlier draft of this document claimed `openai-responses-shared.js` would
throw on a foreign `thinkingSignature` via an unguarded `JSON.parse`. That was
wrong: `transformMessages` converts the block to text first, so the parse never
receives foreign input. The claim was retracted after being tested rather than
read.

## Where the differences are worth keeping

Rows 13, 14, and 14b travel together. Pi still sizes automatic compaction against
its selected model, which stays the planner. Pi's *provider-native overflow
recovery* is gated on `sameModel` (`agent-session.js:1522`), comparing the
assistant message's provider and model against the selected model. Replies
produced by the executor carry the executor's identity while the selected model
is the planner, so that branch still does not run.

Prewalk now closes the practical request-safety gap through public seams: it
conservatively estimates the context sent to the executor, blocks a request
above Pi's effective reserve, waits until the agent settles before invoking
Pi's public compaction API, and reuses a native compaction entry when Pi already
handled the turn. It retries the hidden checklist once when a blocked or failed
request needs replay. A completed response may compact without replay; a second
unchanged pressure failure stops the run rather than looping. It also
supplements Pi's planner threshold after executor turns. This removes the
blanket context-window floor without pretending to own every provider-native
overflow branch. A provider
with a tokenizer or error format that defeats the conservative estimate and
Pi AI's overflow detector can still report an overflow that stock Pi will not
recover automatically; that is the remaining 14b boundary.

Rows 15 and 17 used to be stricter than OMP: an unusable executor failed the
whole run. That is no longer the case. Oh My Pi shipped the strict version too
and had to reverse it in issue #6064, after an unresolvable hand-off target
locked users out of the app; `main.ts:1007-1019` now warns and leaves prewalk
unarmed. Prewalk does the same, and the overlay is restored on the way out so
nothing is left installed.

The planner keeps the strict treatment. A missing or unauthorized *planner* is
not a degraded hand-off, it is a session with nothing to hand off from, so
`resolveExecutor` still throws for that case.

Row 12b is now closed. Prewalk ships the OMP `smol` patterns, resolves them only
against the live registry, ranks the planner's provider first, and leaves
explicit primary/fallback configuration authoritative. An omitted
`executorFallbacks` field gets the inferred chain; an explicit empty array
disables inference. The patterns remain a preference order rather than an
allowlist.

One caution learned from reading Oh My Pi: `priority.json` is a *preference
order*, not an allowlist. Nothing in `session/prewalk.ts` validates a target
against it, and `--prewalk-into` accepts any pattern the ordinary model resolver
accepts (`main.ts:1002`). A default chain here should behave the same way, as a
starting point a user can override rather than a set of permitted models.

## Not verified

- Whether losing reasoning signatures measurably degrades executor quality or
  prompt-cache hit rate. Untested here, and it already applies to the shipped
  same-provider default.
- Additional Google and Bedrock-family paths beyond the direct conversion
  probes above.
- Whether OMP's published guidance recommends a specific planner/executor pair.
  No such document was found in the repository; the `smol` and `slow` priority
  lists are the only in-repo signal.
- Rows 5, 6, 7, 8, 18, 19, 20 were checked against OMP source but not executed
  in a live OMP session.
- Cross-family replay through `pi-messages.js`, and payload-level inspection of
  third-party transports that bypass Pi's provider-payload hook. Cursor routing
  and response completion are verified, but its serialized payload is not.
- Whether a provider tokenizer or custom transport can defeat the conservative
  executor estimate and produce a native overflow in practice. The mechanism is
  real; the frequency is unmeasured, and stock Pi still skips recovery for the
  executor's foreign assistant identity.
