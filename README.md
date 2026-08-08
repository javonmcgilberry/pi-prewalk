# Pi Prewalk

Prewalk lets one model plan a coding task and another model finish it without
starting over. The planner reads the repo, writes the todo list, and makes the
first successful code change. When that turn ends, the configured executor
takes over the same conversation.

Pi still shows and saves the planner as the selected model. After handoff,
Prewalk keeps routing primary turns to the executor until explicit release or
terminal session cleanup. The selected planner remains underneath the overlay.

This project reproduces Oh My Pi's observable Prewalk flow with stock Pi's
public extension APIs. It does not patch Pi, import private Pi modules, call
`setModel()`, or hide a second model behind a fake router model.

## Repository layout

- `extensions/prewalk.ts` is the single Pi package entrypoint declared by
  `package.json`. Pi packages conventionally keep host-facing entrypoints under
  `extensions/`; the manifest names the file explicitly, so the directory is an
  integration boundary rather than a collection of independently loaded
  extensions.
- `src/` contains the coordinator, provider overlay, analytics, mutation, and
  status implementation used by that entrypoint.
- `prompts/` contains the attributed Prewalk prompts.
- `benchmark/extensions/` contains Pi-loadable extensions used only by the
  opt-in benchmark harness. They are never auto-loaded in normal sessions.
- `scripts/`, `test/`, and `docs/` contain development and verification
  support.

At runtime Pi reads the `pi.extensions` manifest entry and invokes the default
export from `extensions/prewalk.ts` with its public `ExtensionAPI`. Prewalk then
communicates through registered commands, tools, events, session entries, and a
temporary provider-registry overlay; it does not patch Pi's agent loop or
change the selected planner model.

## Status

Prewalk is experimental. It uses Pi's current public extension APIs and does
not block specific Pi versions. The benchmark pins its development runtime so
runs can be compared, but that pin does not limit normal use. The repository
does not contain a completed paid benchmark, so it makes no claim about measured
savings or quality.

## Requirements

- An authorized executor with a usable context window and output capacity. It
  may be smaller than the planner; Prewalk estimates each executor request and
  compacts before sending one that crosses the executor's reserve
- No other extension registered as `prewalk_todo`
- Pi Codex Conversion native Responses compaction disabled when that extension
  is installed

The default pair is OpenAI Codex Sol as planner and Luna as executor. The
planner is whichever model Pi has selected, and the executor may sit on a
different provider and Pi API. Pi normalizes replayed history for whichever
model receives a request, so a cross-provider pair such as Anthropic Opus to
Google Gemini Flash routes through each model's own provider stream.

Prewalk keeps `prewalk_todo` available for the full session. Calls outside an
active Prewalk run fail without changing the checklist. During a run, the
hidden planning and executor prompts explain how to use it.

An optional `executorFallbacks` array lists alternates to try in order when the
primary executor is unavailable. If the field is omitted, Prewalk infers an
ordered chain from Oh My Pi's built-in `smol` preference patterns and the models
registered in the current Pi session. An explicit empty array disables that
inference; a non-empty array is used exactly as written.

```json
{
  "executor": { "provider": "openai-codex", "model": "gpt-5.6-luna", "reasoning": "low" },
  "executorFallbacks": [
    { "provider": "google", "model": "gemini-3.5-flash", "reasoning": "low" }
  ]
}
```

Prewalk takes the first candidate that is registered, authorized, has output
capacity, and is not the model already running at the same reasoning level.
When none qualifies it stays unarmed and names each candidate it passed over,
leaving the session on its planner instead of failing the run.

A handoff to a different model always replays history without that model's own
reasoning signatures, because Pi keeps signed reasoning only for an exact model
match. That applies equally to the same-provider default pair, so a
cross-provider pair does not lose anything extra.

The executor may have a smaller context window than the planner. Pi still keeps
the planner selected, so Prewalk adds a request-time watchdog using stock Pi's
default 16,384-token compaction reserve. It prevents an oversized executor
request from reaching the provider, triggers Pi's public compaction API, and
retries the hidden executor checklist once when the blocked or failed request
needs a replay. A completed over-window response is compacted without
duplicating its answer; if the executor is still oversized after that retry,
Prewalk fails safely instead of looping. The behavior matrix records the
remaining limits of this public-API implementation:
`docs/research/2026-08-07-omp-behavior-matrix.md`.

## Why Prewalk is not plan mode

Prewalk is informed by [Stencil's explanation of the frontier-model
tradeoff](https://stencil.so/blog/prewalk), but it is not a conventional
"large model writes a plan, small model implements it" pipeline.

Plan mode creates a prose artifact and starts the executor at a new seam. The
executor must reread the repository, reconstruct the planner's assumptions, and
translate a postcard into edits. The expensive repository reading therefore
happens twice, and the plan does not carry the dead ends, tested hypotheses, or
working context that produced it.

Prewalk keeps one live Pi session. The planner receives a hidden planning
instruction, explores the repository, records a bounded checklist with
Prewalk's namespaced `prewalk_todo` tool, and lands the first successful edit.
Only then does the provider overlay route the next primary turn to the executor. The executor inherits the same conversation,
the surviving todo state, the explored context, and a real edit that already
demonstrated the approach. Prewalk removes the planning instruction before the
handoff, so the executor is not still being told to plan.

That is the important distinction: Prewalk transfers a **trajectory**, not a
plan document. Its benefit is not merely a cheaper model name in analytics; the
session's routing, prompt visibility, todo gate, provider overlay, and handoff
point all change. The frontier model pays for the difficult orientation once,
while the executor continues from a code-tested state instead of beginning as a
second reader.

## Install

Install the GitHub package:

The package name in `package.json` is provisional while the public npm scope
and product name are being finalized. Git installation is the supported public
consumer path for now; do not infer the eventual registry name from the local
placeholder.

```sh
pi install git:github.com/javonmcgilberry/pi-prewalk
```

For local development:

```sh
git clone https://github.com/javonmcgilberry/pi-prewalk.git
cd pi-prewalk
npm install
pi install .
```

Create `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/prewalk.json`:

```json
{
  "executor": {
    "provider": "openai-codex",
    "model": "gpt-5.6-luna",
    "reasoning": "low"
  },
  "analytics": {
    "enabled": true,
    "catalogFallbackEnabled": false,
    "recentReceiptCount": 10,
    "schemaVersion": 1
  }
}
```

The config is strict. Unknown fields fail closed. `/prewalk configure` writes a
valid config atomically and shows executor models with usable output capacity;
the executor can have a smaller context window because the watchdog protects
its requests. It never stores or changes the planner.

## Use it

| Command | What it does |
| --- | --- |
| `/prewalk run` | Start a manual run |
| `/prewalk auto` | Enable conservative automatic admission for this session |
| `/prewalk status` | Show the current planner, executor, gate, route, and failure |
| `/prewalk configure` | Choose the executor and analytics settings |
| `/prewalk cancel` | Cancel a pre-handoff run and disable automatic mode |
| `/prewalk release` | Restore the selected planner after handoff without re-arming |
| `/prewalk stats` | Show what you spent and what switching models saved |
| `/prewalk todos` | Show the current Prewalk implementation checklist |
| `/prewalk help` | Show every command and reset rule |

Manual mode is the simplest place to start:

1. Select the planner in Pi.
2. Run `/prewalk run`.
3. Let the planner inspect the repo, create the todo list, and begin the change.
4. Check `/prewalk status` if you want to see which model owns the next turn.

After handoff, later turns stay on the executor, including after `/reload` in
the same live Pi session and when the planner and executor use different
providers. `/prewalk release` restores the planner in the same transcript.
Closing and reopening Pi starts on the planner; an old unfinished
receipt is recorded as interrupted rather than silently restoring the route.

If an executor provider fails for a reason other than context pressure, Prewalk
restores the planner, preserves the transcript and analytics receipt, and keeps
the failure visible in `/prewalk status`. It does not replay a possibly partial
tool turn automatically; use `/prewalk run` to start a new safe attempt.

## What triggers the handoff

The `prewalk_todo` tool must succeed first. Prewalk never consumes another
extension's `todo` state. During a Prewalk run it temporarily hides an active
foreign `todo`, then restores the exact original tool slate when the Prewalk
lifecycle is released, cancelled, completed, or fails. Outside that lifecycle,
general-purpose todo extensions remain available. Prewalk then waits for positive proof that code changed.
Successful `edit`, `write`, direct or shell `apply_patch`, and Code
Mode patch results count. Failed, cancelled, partial, still-running, printed,
quoted, or dynamically assembled patch attempts do not.

Unknown tools do not count unless an optional integration translates their
terminal result into the same positive mutation evidence. If the result is
unclear, Prewalk stays with the planner.

The handoff happens after the full assistant turn. Parallel tool results cannot
race it. Before the executor's first request, Prewalk removes planning-only
instructions, keeps the executor checklist, and leaves the real transcript,
todo state, usage, model identity, and stop reasons intact.

## Automatic mode

`/prewalk auto` applies only to the current live Pi session. A deterministic
admission check rejects small, research-only, operational, and unclear requests.
Larger implementation work gets one read-only assessment turn before Prewalk
decides whether to arm the full flow.

Typing exactly `stop` or `cancel` closes the current task but leaves automatic
mode ready for another task. `/prewalk cancel` also disables automatic mode.
New, resumed, and forked sessions start in manual mode. `/reload` keeps automatic
readiness only for the same session.

## Optional integrations

Prewalk works without pi-subagents, Context Mode, or Pi Codex Conversion.

- Context Mode and equivalent patch tools can participate when they provide
  positive mutation evidence.
- pi-subagents remains independent. Prewalk does not rewrite child models,
  thinking levels, fallback models, scheduled launches, or nested descendants.
- Pi Codex Conversion can wrap the same public provider stream. Keep
  `compaction.responsesCompaction` set to `false`. Prewalk refuses to arm when
  native Responses compaction is explicitly enabled because hook order could
  otherwise compact planning-only context before Prewalk filters it.

Guessed mutation results are deliberately unsupported: Prewalk hands off only on
a positively proven code mutation.

### Context limits and compaction

Prewalk removes its planning-only prompt before handoff and from the text Pi
sends to its summarizer. Pi still sizes its own automatic compaction against the
selected planner, so Prewalk supplements it for the executor: the overlay
estimates the exact outgoing context, blocks a request above the executor's
reserve, and the turn boundary calls public `ctx.compact()` before retrying the
checklist once when a replay is needed. A completed response may compact without
a retry, so the answer is not duplicated. A second unchanged pressure failure,
or failed/cancelled compaction, leaves the session on the planner instead of
looping. This protection does not mean that prompt-cache reads survive a
model/provider switch; the executor receives the history, but its provider may
charge those input tokens as a cache miss.

### Experimental child-local Prewalk

Child-local Prewalk is disabled by default and is not enabled by the portable
setup. A child must load this extension explicitly through its upstream
`extensions` or `subagentOnlyExtensions` configuration and must have a matching
entry under `experimentalChild.agents`. Read-only, plan-mode, unconfigured,
equal-target, and unavailable-target children stay on their independently
resolved profile. Descendants do not inherit a parent target.

```json
{
  "experimentalChild": {
    "enabled": false,
    "agents": {
      "worker": {
        "mode": "implementation",
        "executor": {
          "provider": "openai-codex",
          "model": "gpt-5.6-luna",
          "reasoning": "low"
        }
      }
    }
  }
}
```

This path has no efficacy or savings claim. `/prewalk status` reports why a
loaded child is disabled or unavailable.

## Local analytics

Analytics views use Pi session titles from current chat logs or private
backfill metadata when available, but receipts remain limited to their existing
allowlisted metadata. Generated session summaries are not stored in Prewalk
analytics.

In TUI mode, `/prewalk stats` opens an interactive dashboard with the exact
current Pi session first, followed by this week, this month, all time, and
recent sessions. Use the arrow keys, Enter, `?`, `R`, and Escape to navigate it.
The dashboard uses session titles first and keeps stable IDs in details. It
does not fold delegated child sessions into the current-session section; use
`/prewalk stats task` for the whole task tree. Active runs show recorded spend
only. Finished runs compare planner + executor call cost with the price of the
same recorded tokens at planner rates. A planning-only run is shown as a run
that finished before handoff, not as missing usage.

Analytics are enabled by default and stay under
`${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/prewalk/analytics`. Prewalk stores
allowlisted run metadata, token counts, Pi-reported cost, pricing evidence,
outcomes, and timestamps. It does not store prompts, responses, code, tool
inputs or outputs, credentials, provider payloads, raw errors, or filesystem
paths.

Recorded spend is provider-reported cost captured for the run. It can include
planner, executor, helper, and compaction calls. An estimated difference is a
price-based comparison: the planner-only estimate for the recorded primary
tokens minus Prewalk's planner and executor primary-call cost. It is not a
separate planner-only run, a billing statement, or a measured benchmark.
Missing pricing or usage is named directly; Prewalk does not invent a rate.

Recorded spend and the estimated difference cover different runs, so dividing
one by the other understates the result. Recorded spend counts every run;
the difference covers only comparable ones. Each comparison reports the spend
it covers, and that is the figure to read the difference against.

The difference is shown as `up to` because it is an upper bound. It assumes the
planner would have used the same tokens the executor did, while a cheaper
executor often needs more turns, each repriced at planner rates. Only an
accepted benchmark report, labelled `verified`, measures the difference.

A run that was released, ended with its session, or was interrupted is still
compared when it recorded executor usage and pricing. Receipts store the rates
they were priced with, so a receipt can be repriced later instead of becoming
permanently uncomparable. An unfinished journal left behind by a session that
exited uncleanly is finalized by its own session at startup, or by another
session once it has been untouched for twenty-four hours. If that wait is wrong
and the idle session returns, the owning session reclaims the run; recovery is
only ever replaced by a receipt holding strictly more evidence.
Direct and nested pi-subagents costs are accepted only from terminal public
result details and counted once. Async or detached work without terminal public
evidence remains pending or incomplete.
See [the analytics guide](docs/analytics.md) for receipt math, task-tree coverage,
exports, resets, and benchmark imports.

## Failure and cleanup rules

- Selecting another Pi model cancels the current route without changing the new
  selection.
- A failed pre-handoff run or explicit cancellation releases the provider
  overlay before another run can start. After handoff, use `/prewalk release`.
- A planner/provider mismatch, missing authorization, invalid config, todo
  conflict, or unsupported native compaction fails before the executor is used.
- Hidden planning prompts stay out of normal model context and compaction input;
  mid-turn threshold enforcement remains a Pi-core responsibility.

Use `/prewalk status` for the stable failure reason. To start over, run
`/prewalk cancel` and then `/prewalk run`.

## Development

Routine checks do not make provider requests:

```sh
npm run lint
npm run typecheck
npm test
npm run test:agent-loop
npm run smoke:rpc
npm run check:links
npm run pack:dry-run
```

The Agent-loop tests use stock Pi's exported session factory. The dedicated
Conversion test checks provider-wrapper composition. The RPC smoke test loads
stock Pi only and confirms that status,
cancellation, reload, settings, and the selected planner remain stable.

Normal CI is secret-free and never calls paid providers. Scheduled compatibility
jobs discover the full npm stable-version list, run candidates in a bounded
temporary copy with checkout credentials disabled, and publish schema-validated
artifacts. A separate trusted reporter owns the rolling compatibility ledger and
deduplicated failure issues. The OMP drift workflow is report-only and never
updates prompts, fixtures, runtime code, or package pins. Provider canaries and
efficacy benchmarks remain manual, approval-gated, and cost-confirmed.

The authenticated canary does make real provider requests and requires an
explicit cost confirmation. The directional benchmark is also opt-in and is
blocked until its public task corpus is reviewed and frozen. Read
[`benchmark/README.md`](benchmark/README.md) before running either paid path.

The provider canary accepts any configured planner and executor in
`provider/model` form. For example:

```sh
npm run canary:provider -- \
  --confirm-provider-cost I_UNDERSTAND_PROVIDER_REQUESTS \
  --auth-file "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json" \
  --planner openai-codex/gpt-5.6-luna \
  --executor anthropic/claude-haiku-4-5
```

It stages only those two provider credentials into an owner-only temporary
profile, limits the live run to `prewalk_todo`, `read`, `edit`, and `write`, and
writes redacted evidence to `--evidence-dir`. Add `--extension
/absolute/path/to/provider-extension.ts` for a provider supplied by an
extension. Use `--payload-inspection optional` when that transport does not
expose Pi's provider-payload hook; the evidence records that boundary instead
of treating it as proof that the payload was inspected.

## Documentation

[`docs/README.md`](docs/README.md) separates current user documentation from
historical plans and research. Plans explain how the project got here; they are
not install instructions or promises about current behavior.

## Attribution

The planning, continuation, and executor-checklist prompt assets are copied
byte-for-byte from Oh My Pi revision
`f559e7e9dc1e8818d5d8e15ace28da3d42f2457d` from
`packages/coding-agent/src/prompts/system/prewalk-{plan,continue,checklist}.md`
under the MIT license. At runtime, the planning prompt maps OMP's canonical
`todo` identifier to the stock-Pi adaptation's namespaced `prewalk_todo` tool.
The coordinator remains a stock-Pi public-API adaptation.
See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
