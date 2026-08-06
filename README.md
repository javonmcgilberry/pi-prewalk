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

Prewalk is experimental. Its efficacy benchmark remains frozen to stock Pi
0.82.1 and Pi Codex Conversion 3.0.3. Rolling compatibility checks evaluate
new stable Pi releases separately. The repository does not
contain a completed paid benchmark, so it makes no claim about measured savings
or quality for this implementation.

## Requirements

- Pi 0.82.1 or 0.83.0
- Two authorized models on the same provider and Pi API
- No other extension registered as `prewalk_todo`
- Pi Codex Conversion native Responses compaction disabled when that extension
  is installed

The default pair is OpenAI Codex Sol as planner and Luna as executor. Other
same-provider pairs, such as Opus and Sonnet, work through Pi's normal provider
stream.

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
valid config atomically and only shows executor models compatible with Pi's
currently selected planner. It never stores or changes the planner.

## Use it

| Command | What it does |
| --- | --- |
| `/prewalk run` | Start a manual run |
| `/prewalk auto` | Enable conservative automatic admission for this session |
| `/prewalk status` | Show the current planner, executor, gate, route, and failure |
| `/prewalk configure` | Choose the executor and analytics settings |
| `/prewalk cancel` | Cancel a pre-handoff run and disable automatic mode |
| `/prewalk release` | Restore the selected planner after handoff without re-arming |
| `/prewalk stats` | Show local usage and savings receipts |
| `/prewalk todos` | Show the current Prewalk implementation checklist |
| `/prewalk help` | Show every command and reset rule |

Manual mode is the simplest place to start:

1. Select the planner in Pi.
2. Run `/prewalk run`.
3. Let the planner inspect the repo, create the todo list, and begin the change.
4. Check `/prewalk status` if you want to see which model owns the next turn.

After handoff, later turns stay on the executor, including after `/reload` in
the same live Pi session. `/prewalk release` restores the planner in the same
transcript. Closing and reopening Pi starts on the planner; an old unfinished
receipt is recorded as interrupted rather than silently restoring the route.

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

Cross-provider routing and guessed mutation results are deliberately unsupported.

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

Analytics are enabled by default and stay under
`${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/prewalk/analytics`. Prewalk stores
allowlisted run metadata, token counts, Pi-reported cost, pricing evidence,
outcomes, and timestamps. It does not store prompts, responses, code, tool
inputs or outputs, credentials, provider payloads, raw errors, or filesystem
paths.

Savings are a labeled planner-only counterfactual, not a billing statement.
Missing pricing evidence stays `unavailable`; Prewalk does not invent a rate.
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
- Hidden planning prompts stay out of normal model context and compaction input.

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
