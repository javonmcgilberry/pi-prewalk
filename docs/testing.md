# Testing practice

## A test is not evidence until it has failed

Two bugs in this repository were shipped and survived under a full green suite.
Neither was subtle in hindsight, and both had the same cause: a test that could
not fail.

**The `api` bug.** `src/provider-overlay.ts` registered its overlay as
`{ ...previous, streamSimple }`. Pi rejects a `streamSimple` registration that
carries no `api`, and only a provider that another extension had already
configured contributed one. Prewalk could therefore arm on `openai-codex` and
nowhere else. Every unit test passed, because no test ever armed a run in a real
Pi process; the RPC smoke test exercised `status`, `cancel`, and `reload`, none
of which install the overlay.

**Two false teeth checks.** While verifying that new tests actually caught
regressions, two hand-run mutation checks reported success against builds that
were deliberately broken:

1. A smoke test asserted on `stderr`. A refused arm never reaches `stderr` — it
   is reported through a UI notice and the audit trail — so the test passed with
   cross-provider routing fully disabled.
2. A patch script's string replacement silently found no match. The source was
   never mutated, the test ran against unmodified code, and its pass was
   meaningless.

Both are invisible when the check is performed by hand.

## The rule

Before a test is treated as evidence, break the behavior it covers and watch it
fail. Do not do this by hand.

```sh
npm run verify:teeth
```

`scripts/verify-teeth.mjs` takes a spec listing mutations, and for each one:

- requires the `find` anchor to occur **exactly once**, so a mutation cannot hit
  a site other than the intended one, and a moved anchor is reported as
  `ANCHOR-NOT-UNIQUE` rather than skipped
- applies the mutation, runs the test, and requires it to **fail**
- restores the file, whatever happened

A mutation the test survives is reported as `SURVIVED` and exits non-zero. That
means the test passes while the behavior is broken, which is the state both bugs
above were in.

The command also runs the test unmutated first. A mutation result means nothing
if the suite was already red.

## Choosing what to assert on

The recurring mistake is watching the wrong signal. Before writing an assertion,
find where the failure you care about actually surfaces:

| Failure | Where it surfaces | Not visible in |
| --- | --- | --- |
| Prewalk refuses to arm | `prewalk-audit` entries in the session, UI notice | `stderr`, exit code |
| Overlay routed to the wrong provider | which provider's `streamSimple` was called | the assistant message, which records the executor either way |
| Executor rejected from the chain | `armed.executor` in the audit record | the notice text alone |

`scripts/smoke-rpc-cross-provider.mjs` asserts against the audit trail for this
reason. Its first version asserted on `stderr` and passed against a build with
cross-provider routing removed.

## Layers

Unit tests with hand-built fakes prove resolution logic. They do not prove the
extension works, because the fake is shaped by the same assumptions as the code.
Three layers are load-bearing here:

- `test/executor-chain.test.ts` — pure resolution rules
- `test/executor-context.test.ts` and executor-focused extension tests — the
  request-time context watchdog and compaction retry boundary
- `scripts/smoke-rpc-cross-provider.mjs` — a real Pi process arms a real run
- `test/agent-loop.test.ts` — a real agent loop reaches the hand-off and the
  executor's own provider receives the request

The `api` bug passed the first layer and failed the second.
