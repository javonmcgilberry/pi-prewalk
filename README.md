# Pi Prewalk

Prewalk lets the model already active in Pi plan an implementation, records a
bounded checkpoint, permits the first successful built-in `edit` or `write`, and
then switches the same live `AgentSession` to an explicitly configured target.
The target sees the checkpoint and mutation result and owns Pi's natural next
model request. No process boundary or transcript break is involved.

The package is intentionally stricter than literal Oh My Pi behavior: the
checkpoint is always required, hidden planning guidance is never saved, target
and privacy readiness are checked before mutation, and ordinary chat or
read-only work does not receive an extra model request.

## Runtime behavior

Automatic mode arms once for trusted `startup` and `new` sessions. It does not
call a model merely to classify the task. A successful built-in `read`, `grep`,
`find`, or `ls` result activates conditional guidance in the continuation Pi was
already going to make. A direct `edit` or `write` before the checkpoint is
blocked, and that normal tool error gives the planner a continuation in which to
recover.

The projected guidance preserves the user's intent:

- implementation work must call `prewalk_checkpoint` with 5-9 ordered,
  non-empty implementation and verification items before mutation;
- read-only or no-change work finishes normally without a checkpoint or edit;
- after checkpoint acceptance, exactly one built-in `edit` or `write` is
  reserved;
- failed or cancelled mutations do not switch models;
- after the successful mutation result is persisted, the `turn_end` hook applies
  the target model and thinking level together before the next request.

Manual `/prewalk` or `/prewalk run` arms the same workflow immediately without
queuing a request. The target remains active for the current `AgentSession`,
including an extension-only reload. A fresh Pi process, new/replacement session,
resume/session switch, or fork reconstructs ordinary Pi selection because the
handoff writes no model or thinking selection entry. A conventional `/model`,
keyboard cycle, or thinking-level change still follows Pi's normal persistence
behavior and supersedes the live target.

The handoff itself does not change Pi's saved provider, model, or thinking
defaults.

## Supported host

The extension requires the public
`pi.setSessionModelAndThinkingLevel()` host operation added by this package's
reviewed Pi patch.

The initial updater supports **only**:

- `@earendil-works/pi-coding-agent` **0.82.1**;
- official source commit
  [`b4f293684bba718d59cc1157679bcf6157b3a7f5`](https://github.com/earendil-works/pi/commit/b4f293684bba718d59cc1157679bcf6157b3a7f5);
- macOS `darwin/arm64`;
- the detected npm-global layout whose `pi` executable resolves to
  `@earendil-works/pi-coding-agent/dist/cli.js`.

Another Pi version, platform, architecture, package manager, executable layout,
or source shape is unsupported and is refused before installation mutation.
There is no compiled-file surgery, settings restoration trick, provider proxy,
or runtime monkey patch.

## Install from this checkout

Install dependencies first:

```sh
git clone https://github.com/javonmcgilberry/pi-prewalk.git
cd pi-prewalk
npm install
```

Inspect the detected host, apply the reviewed source patch, then install the Pi
package extension:

```sh
node updater/cli.mjs status
node updater/cli.mjs update
pi install .
```

When the package's bin is installed on `PATH`, use the equivalent
`prewalk-update-pi status` and `prewalk-update-pi update` commands. Use the exact
package source shown by `pi list` for later removal. A one-run extension trial
with `pi -e ./extensions/prewalk.ts` is possible only after the compatible host
patch is active.

The updater is intentionally fail-closed. Do not replace its manifest commands,
digests, or source inputs when a gate fails.

## Configure

In Pi, select the exact target and requested thinking level:

```text
/prewalk configure openai-codex/gpt-5.6-luna low
```

Configuration proves only that the model resolves in Pi's registry and that the
provider has complete configured authentication. It does not send a provider
request and therefore cannot prove that credentials are fresh or will be
accepted. The host repeats configured-auth validation during handoff. A later
credential rejection disarms the run, reports the failure after the mutation,
and never retries that handoff automatically.

For a target with a different provider, add the flag and confirm the
disclosure prompt:

```text
/prewalk configure anthropic/claude-sonnet-4-5 low --allow-cross-provider
```

Cross-provider consent is bound to hashes of the effective planner and target
recipients, including normalized endpoint/API identity, selected target, and the
host's stable registered stream implementation ID. Built-in IDs are derived from
the Pi package version and API. A custom `streamSimple` registration must declare
`streamImplementationId`; otherwise cross-provider Prewalk fails closed.
Reconfiguration or an endpoint/registration/implementation/target change
invalidates old consent. The target receives the persisted conversation,
checkpoint, tool arguments, and tool results.

`prewalk.json` is stored under `PI_CODING_AGENT_DIR` (normally
`~/.pi/agent`). Its strict schema is:

```json
{
  "enabled": true,
  "target": "openai-codex/gpt-5.6-luna",
  "thinkingLevel": "low",
  "crossProviderPairs": []
}
```

`crossProviderPairs` contains hashes written only after explicit confirmation;
do not copy entries between endpoints. Unknown fields and malformed values are
rejected. Unsupported thinking levels are clamped to the target's effective
level when configuration is saved.

## Commands

- `/prewalk` or `/prewalk run` — manually arm the workflow without adding a
  model request
- `/prewalk status` — show configuration and the live coordinator phase
- `/prewalk cancel` — clear the current checkpoint, projection, and mutation
  reservation
- `/prewalk enable` / `/prewalk disable` — toggle future automatic arming
- `/prewalk configure provider/model thinking [--allow-cross-provider]` —
  replace strict target configuration

Settlement before a successful handoff, cancellation, compaction, session tree
navigation, resume/session switch, fork, new session, extension shutdown, and
handoff failure clear stale coordinator state. Hidden guidance exists only in
the outgoing `context` projection and is absent from session JSONL, compaction,
replacement-session history, and the target's context.

Only Pi's typed built-in `edit` and `write` calls qualify as mutations. Shell
commands and similarly named custom tools do not qualify. Parallel mutation
attempts are blocked; already-running unrelated tools cannot be rolled back.

## Updater operations

Run `prewalk-update-pi help` (or `node updater/cli.mjs help` from the checkout)
for the installed command surface:

- `status` reports supported unpatched, supported patched, unsupported, damaged,
  or recovery-required state. Like every mode, it first acquires the
  per-installation lock and completes or refuses any recorded recovery.
- `update` downloads the pinned official source archive and official 0.82.1 npm
  package used for generated provider data, verifies every reviewed integrity
  and source digest, safely extracts into fresh owned directories, applies the
  reviewed patch, runs the manifest's focused tests/build/pack/install/RPC
  gates, and validates a same-filesystem staged candidate before commit.
- `migrate` preserves valid `enabled`, target, effective thinking, and recipient
  consent. It drops transient legacy state and removes package records or loose
  files only when the manifest positively identifies their source or hash.
  Modified, ambiguous, or unreviewed files are retained and reported. Candidate
  package sources and loose extension paths are discovered without treating
  their names as removal authority. If any candidate remains unidentified,
  migration returns `migration-review-required` rather than claiming success.
  The initial manifest intentionally contains no legacy package-source or
  loose-file hash allowlist, so it preserves and reports such artifacts until
  reviewed identifiers are added.
- `uninstall` (alias `restore`) restores a validated retained official backup or
  rebuilds verified official unpatched 0.82.1 through the same staging path. It
  never substitutes a newer release. If restoration cannot be proven, the
  current known-good package is retained.
- `recovery-report` recovers an interrupted transaction when the durable journal
  proves ownership, or reports a clean state.

The updater holds a per-installation lock through recovery or update, records a
PID and unguessable owner nonce, and safely reclaims a dead owner's inode before
journal inspection. It writes and fsyncs a phase journal before filesystem
swaps, keeps a validated backup, and validates post-swap state. Handled failures roll back immediately. An abrupt
process or machine stop between renames can temporarily make `pi` unavailable;
the next updater invocation must recover the journal before doing anything else.
Unknown/corrupt journals preserve all evidence and stop with
`recovery-required` guidance.

A matching attestation and deterministic installed-package tree hash make repeat
`update` a verified no-op. The tree covers every file and symlink under the
installed package root, including package-owned `node_modules` dependency bytes.
It does not cross the package-root boundary to hash unrelated hoisted or global
sibling packages. The attestation is stored beside, not inside, the package. Source drift, unsafe archive entries, patch conflicts, test/build/package
failures, permission/topology problems, or failed recovery never trigger an
optimistic fallback.

## Verification

Routine, non-billable checks:

```sh
npm run typecheck
npm test
npm run smoke:rpc
npm pack --dry-run
```

`smoke:rpc` creates isolated temporary agent/session roots and a synthetic
no-network provider. It proves one process and session, atomic target selection,
extension-reload retention, ordinary selection in a replacement/fresh session,
byte-identical settings, no persisted model/thinking selection, and cleanup.
It never reads the normal agent profile or makes a provider request.

### Release-only provider canary

`canary:provider` is **not** a routine test. It sends real planner and target
requests and can incur cost or disclose the isolated test transcript to both
providers. It requires an exact opt-in token, explicit models, configured auth
input, and exact recipient consent for a cross-provider run. It mutates only a
bounded temporary fixture, aborts on unexpected tool paths, and inspects the
final `before_provider_request` payload to prove hidden planning guidance is
absent.

Example shape (replace every quoted model/path value deliberately):

```sh
npm run canary:provider -- \
  --confirm-provider-cost I_UNDERSTAND_PROVIDER_REQUESTS \
  --planner "provider/planner-model" \
  --target "provider/target-model" \
  --thinking low \
  --pi "$(command -v pi)" \
  --auth-file "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json" \
  --evidence-dir .prewalk-canary-evidence
```

For a cross-provider canary, also pass
`--consent "<planner-fingerprint>-><target-fingerprint>"` using the exact pair
created for that runtime; consent from another registration, endpoint, API, or
target is rejected. Custom models require an explicit `--models-file` copied
into the isolated profile.

Evidence contains only model labels, request/checkpoint/mutation counts,
assertion labels, outcome, and expiry—never credentials, full transcript,
settings contents, or absolute host paths. Symlinked or foreign-owned evidence
directories are rejected before cleanup or write. The evidence directory is mode
`0700`, files are `0600`, retention defaults to 24 hours, and values above 168
hours are rejected. Each canary run prunes expired owned evidence; remove the
directory after review if earlier cleanup is desired.

This release canary has not been run merely because installation, update,
configuration, or routine verification succeeded.

## Remove or restore

Restore official Pi before removing the extension package:

```sh
prewalk-update-pi uninstall
pi remove .
```

Use `node updater/cli.mjs uninstall` from a checkout when the bin is not on
`PATH`, and replace `.` in `pi remove` with the exact source printed by
`pi list`. Restoration does not delete operator configuration or ambiguous
loose files.

Optional configuration cleanup:

```sh
rm "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/prewalk.json"
```

## Attribution

The behavior and planning flow are adapted from Oh My Pi's Prewalk under the
MIT license in [`LICENSE`](./LICENSE).
