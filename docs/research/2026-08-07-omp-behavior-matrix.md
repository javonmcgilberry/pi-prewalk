# Prewalk behavior matrix: this extension against Oh My Pi

Compares Prewalk, a standalone extension on stock Pi, with Oh My Pi's built-in
prewalk. Rows record what each side does, whether the difference is forced or
chosen, and the evidence behind the claim.

References are `file:line` at the time of writing.

- **OMP** — `~/webdev/oh-my-pi`, `packages/coding-agent/src/session/prewalk.ts`
  and neighbors.
- **Stock Pi** — `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`
  at 0.82.1, read from `node_modules`.
- **This extension** — `extensions/prewalk.ts`, `src/`.

## The one difference everything else follows from

OMP owns its harness, so its handoff is a real session model switch:
`setModelTemporary(target, thinkingLevel, { ephemeral: true })`
(`session/prewalk.ts:138`, `session/model-controls.ts:255`). The session becomes
the executor, and every model-aware subsystem follows automatically.

An extension cannot do that. Stock Pi's public `setModel` writes the user's
saved default (`agent-session.js:1197` calls `setDefaultModelAndProvider` at
`:1205`), so using it would change the model for every future session. That was
confirmed still true in 0.84.1, not only 0.82.1. The limitation is recorded in
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
| 11 | Default executor | `smol` role, resolved from a priority list | One configured `executor` in `prewalk.json` | **Chosen** | `priority.json`; `src/core.ts` `parseConfig` |
| 12 | Executor auto-selected for the current planner | Yes, by role resolution | No, explicit config only | **Gap** | `commit/model-selection.ts:82`; no equivalent here |
| 13 | Executor context window must be >= planner's | No such rule | Yes, enforced at startup | **Forced** | no OMP check; `extensions/prewalk.ts` `validateModels` |
| 14 | Auto-compaction protects the executor | Yes, sized against the switched-to model | No, Pi sizes against the planner | **Forced** | `agent-session.js:1515` uses `this.model` |
| 15 | Same model + same effort handoff | Graceful no-op with a notice | Hard `configuration-invalid` error | **Divergence** | `thinking.ts:169` `prewalkWouldBeNoop`; `validateModels` |
| 16 | Effort-only downgrade, same model | Supported | Supported | Same | OMP fixed in #6659; `validateModels` allows differing reasoning |
| 17 | Unresolvable or unauthorized target | Skips the handoff, session continues | Fails the run with a reason code | **Divergence** | `task/executor.ts:2706`; `fail("authorization-unavailable")` |
| 18 | Subagent/child prewalk | Yes, per-agent frontmatter and settings | Behind `experimentalChild`, default off | **Chosen** | `docs/task-agent-discovery.md:39`; `src/core.ts` |
| 19 | Plan-yolo | Yes, separate feature | Not implemented | **Chosen** | `session/prewalk.ts:238` |
| 20 | Status line annotation | Yes | Yes | Same | `src/status.ts` |
| 21 | Manual release back to planner | Not present | `/prewalk release` | **Addition** | `extensions/prewalk.ts` `release` |
| 22 | Local cost analytics and receipts | Not present | Yes | **Addition** | `src/analytics*.ts` |
| 23 | Provider-ownership drift detection | Not needed | Yes, `provider-drift` | **Forced** | `verifyOverlayOwnership` |
| 24 | Native Responses compaction | Supported | Refused, `native-compaction-unsupported` | **Forced** | `nativeResponsesCompactionState` |
| 25 | Model display names | Generic | `gpt-5.6-sol`/`luna` special-cased | **Cosmetic gap** | `src/status.ts:17`; `extensions/prewalk.ts:2141` |

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

Verified by direct execution against the installed 0.82.1 build, for
anthropic to openai, openai to anthropic, and anthropic to google. Every pair
converted without throwing, and tool call/result pairing survived.

**The load-bearing detail:** `openai/sol -> openai/luna`, a same-provider pair on
two different model ids, takes the *identical* path and loses the same
signatures. The shipped Sol-to-Luna default already replays degraded history
today. Cross-provider therefore introduces no new degradation, which is what
makes row 9 safe rather than merely possible.

An earlier draft of this document claimed `openai-responses-shared.js` would
throw on a foreign `thinkingSignature` via an unguarded `JSON.parse`. That was
wrong: `transformMessages` converts the block to text first, so the parse never
receives foreign input. The claim was retracted after being tested rather than
read.

## Where the differences are worth keeping

Rows 13 and 14 travel together. Pi decides compaction against its selected
model, and Prewalk's selected model stays the planner for the whole run, so a
smaller executor would receive requests that no automatic compaction is
watching. OMP does not need the rule because its switch is real. Removing row 13
without building a compaction watchdog against the executor's true window would
trade a clear startup error for provider errors mid-run.

Rows 15 and 17 are stricter than OMP on purpose: this extension holds a provider
registration, so it prefers refusing a run to leaving an overlay installed in a
state it did not plan for. OMP can degrade to "carry on unswitched" because
nothing is installed. Both are defensible; row 17 in particular is worth
revisiting, since failing an entire run because a cheap executor lost auth is
harsher than continuing on the planner.

Row 12 is the most valuable remaining gap. OMP resolves an executor from a
priority list against whatever models are available, so a planner change does
not strand the user. Here a planner on a provider the configured executor does
not match produced a bare `model-unavailable`. Cross-provider removes the hard
failure; automatic selection would remove the surprise.

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
