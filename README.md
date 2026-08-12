# Pi Prewalk

Prewalk lets one model plan a coding task and another model finish it without
starting over. The planner reads the repo, writes the todo list, and makes the
first successful code change. When that turn ends, the configured executor
takes over the same conversation.

Pi still shows and saves the planner as the selected model. After handoff,
Prewalk keeps routing primary turns to the executor until explicit release or
terminal session cleanup. The selected planner remains underneath the overlay.

This project reproduces Oh My Pi's observable Prewalk flow with stock Pi's
public extension APIs. If you want the plain-language version first, read
[`Prewalk in plain English`](docs/prewalk-vs-omp.md). It explains the two-model
flow, the stock-Pi limits, and the places where OMP has more built-in support.

Prewalk does not patch Pi, import private Pi modules, call `setModel()`, or
hide a second model behind a fake router model.

## Repository layout

- `extensions/prewalk.ts` is the single Pi package entrypoint declared by
  `package.json`. Pi packages conventionally keep host-facing entrypoints under
  `extensions/`; the manifest names the file explicitly, so the directory is an
  integration boundary rather than a collection of independently loaded
  extensions.
- `src/pi/` contains the stock-Pi adapter and composition modules. `src/orchestration/`
  owns the one-run lifecycle, `src/turn/` owns todo and mutation proof, and
  `src/executor/` owns routing, leases, and context pressure.
- `src/session/` owns audit and reload recovery. `src/analytics/` owns durable
  journals, receipts, accounting, reports, dashboards, and child evidence.
  `src/config/` owns the config file and wizard; `src/ui/` owns status text.
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

### Run isolation for host events

Pi's public events do not carry a stable Prewalk run identity. Prewalk therefore
uses a small facts-only layer for agent, message, tool, and compaction events.
Claim and capture events store an ownership fact. They use the current run ID
and epoch, or an explicit-unowned marker when no earlier retained fact applies.
Only ordinary message and tool queries, and an eligible unsuppressed unpaired
terminal compaction, may be genuinely unknown and return `apply/unknown`.
Unknown `agent-end` is ignored. Under valid input, `message-start`,
`tool-claim`, `agent-start`, and `agent-settled` do not produce ordinary
unknown. The layer tells the extension to `apply` or `ignore` the observation.
The orchestration, turn-proof, analytics, and compaction modules still make the
actual decisions. The Pi adapter only translates host events and supplies host
capabilities.

For the permitted query and compaction cases, `apply/unknown` means no retained
fact identifies the run. It proves neither current-run ownership nor a mutation,
and the observation still has to pass the existing checks before it can change
anything. One Prewalk run remains one trajectory inside one Pi session.
Child runs keep their own local extension state, and this seam does not rewrite
child launches or schedule work.
`TemporaryModelRuntime` remains a replaceable provider-routing adapter rather
than part of correlation policy.

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
Cross-provider executor requests use the executor provider's resolved
credentials; a planner-resolved API key is never forwarded, while a distinct
request-level override remains available.

Top-level Prewalk keeps `prewalk_todo` available for the full session. An
opted-in mutation-capable child receives the same namespaced tool for its own
run. Calls outside an active Prewalk run fail without changing the checklist.
During a run, the hidden planning and executor prompts explain how to use it.

An optional `executorFallbacks` array lists alternates to try in order when the
primary executor is unavailable. If the field is omitted, Prewalk infers an
ordered chain from Oh My Pi's built-in `smol` preference patterns and the models
registered in the current Pi session. An explicit empty array disables that
inference; a non-empty array is used exactly as written.

```json
{
  "enabled": false,
  "executor": { "provider": "openai-codex", "model": "gpt-5.6-luna", "reasoning": "low" },
  "executorFallbacks": [
    { "provider": "google", "model": "gemini-3.5-flash", "reasoning": "low" }
  ]
}
```

Prewalk takes the first candidate that is registered, authorized, has output
capacity, and is not the model already running at the same effective reasoning
level after Pi clamps the requested level to that model's supported levels. When
none qualifies it stays unarmed and names each candidate it passed over, leaving
the session on its planner instead of failing the run.

A handoff to a different model always replays history without that model's own
reasoning signatures, because Pi keeps signed reasoning only for an exact model
match. That applies equally to the same-provider default pair, so a
cross-provider pair does not lose anything extra.

The executor may have a smaller context window than the planner. Pi still keeps
the planner selected, so Prewalk adds a request-time watchdog using Pi's
effective `compaction.reserveTokens` setting (16,384 when it is not configured).
It prevents an oversized executor request from reaching the provider, triggers
Pi's public compaction API after the agent settles, and retries the hidden
executor checklist once when the blocked or failed request needs a replay. A
preflight pause stays hidden while compaction runs; it is not reported as an
executor error. If Pi's own compaction already handled the turn, Prewalk reuses
that result instead of starting a second compaction. When automatic compaction
is disabled, Prewalk fails closed rather than issuing an oversized request. A
completed over-window response is compacted without duplicating its answer; if
the executor is still oversized after that retry, Prewalk fails safely instead
of looping. The
[plain-language Prewalk and OMP guide](docs/prewalk-vs-omp.md) explains what
this means in practice and which limits remain. The source-level [OMP behavior
matrix](https://github.com/javonmcgilberry/pi-prewalk/blob/main/docs/research/2026-08-07-omp-behavior-matrix.md)
is kept as an evidence appendix in the repository and omitted from packed
installs.

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
  "enabled": false,
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

`enabled` controls how a top-level session starts and is `false` when omitted.
Set it to `true`, or toggle **Automatic startup** in `/prewalk configure`.
Prewalk then starts in automatic mode for `startup`, `new`, and `fork`
sessions. It still starts manually for `resume`.

The config is strict. Unknown fields fail closed. In an interactive terminal,
`/prewalk configure` opens one in-place settings menu and keeps every change in a draft.
Nothing is written until you review the draft and choose **Save changes**. Press
`?` for help with child-agent and analytics settings.

The model picker works like Pi's: start typing any part of a provider, model
name, or model ID, move with the arrow keys, and press Enter to choose. Escape
backs up one screen. From the overview, it closes an unchanged draft and asks
before discarding a changed one. Printable letters are never exit shortcuts.
In non-interactive modes, the command uses shorter step-by-step prompts. It
never stores or changes the planner.

## Use it

| Command | What it does |
| --- | --- |
| `/prewalk run` | Start a manual run while Pi is idle |
| `/prewalk auto` | Enable conservative automatic admission for this session |
| `/prewalk status` | Show the current planner, executor, gate, route, and failure |
| `/prewalk configure` | Configure automatic startup, the executor, child agents, and analytics |
| `/prewalk children` | Show child-agent settings; use `on`, `off`, or `target` to change one |
| `/prewalk cancel` | Cancel a pre-handoff run and disable automatic mode |
| `/prewalk release` | Restore the selected planner after handoff without re-arming |
| `/prewalk stats` | Show what you spent and what switching models saved |
| `/prewalk todos` | Show the current Prewalk implementation checklist |
| `/prewalk help` | Show every command and reset rule |

Manual mode is the simplest place to start:

1. Select the planner in Pi.
2. Wait for any active agent turn to finish, then run `/prewalk run`.
3. Let the planner inspect the repo, create the todo list, and begin the change.
4. Check `/prewalk status` if you want to see which model owns the next turn.

After handoff, later turns stay on the executor, including after `/reload` in
the same live Pi session and when the planner and executor use different
providers. `/prewalk release` restores the planner in the same transcript.
Closing and reopening Pi starts on the planner. With automatic startup enabled,
the fresh session is ready to evaluate the next request, but it never restores
an old executor route. An unfinished receipt from the old session is recorded
as interrupted.

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

This is a small, source-owned hook. A `MutationEvidenceAdapter` names one
top-level tool and supplies a pure function that may classify its successful
terminal result as `edit`, `write`, or `apply_patch`. Prewalk keeps the host's
real tool-call identity and checks its built-in tools first, so an adapter
cannot override a failed known operation, inspect a different tool's result, or
invent trigger provenance. No RepoPrompt-specific adapter ships with this
package.

The handoff happens after the full assistant turn. Parallel tool results cannot
race it. Before the executor's first request, Prewalk removes planning-only
instructions, keeps the executor checklist, and leaves the real transcript,
todo state, usage, model identity, and stop reasons intact.

## Automatic mode

OMP treats automatic startup as an opt-in. This extension now does the same:
`enabled` is `false` by default, and `enabled: true` makes `startup`, `new`, and
`fork` sessions ready to evaluate the next request automatically. A `resume`
session stays manual. The setting chooses the initial mode; it does not skip
Prewalk's admission or handoff checks.

`/prewalk auto` applies only to the current live Pi session. A deterministic
admission check rejects small, research-only, operational, and unclear requests.
Larger implementation work gets one read-only assessment turn before Prewalk
decides whether to arm the full flow.

Typing exactly `stop` or `cancel` closes the current task but leaves automatic
mode ready for another task. `/prewalk cancel` also disables automatic mode.
`/prewalk auto` and `/prewalk cancel` override the saved default only for the
current session. `/reload` keeps that choice. A changed `enabled` value takes
effect on the next fresh session.

## Optional integrations

Prewalk works without pi-subagents, Context Mode, or Pi Codex Conversion.

- Context Mode and equivalent patch tools can participate when they provide
  positive mutation evidence.
- pi-subagents remains independent. Prewalk does not rewrite child models,
  thinking levels, fallback models, scheduled launches, or nested descendants.
- Pi Codex Conversion can wrap the same public provider stream. Keep
  `compaction.responsesCompaction` set to `false` (the legacy top-level
  `responsesCompaction` setting is recognized too). Prewalk refuses to arm,
  including when restoring an active run, when native Responses compaction is
  explicitly enabled because hook order could otherwise compact planning-only
  context before Prewalk filters it.

Guessed mutation results are deliberately unsupported: Prewalk hands off only on
a positively proven code mutation.

### Context limits and compaction

Prewalk removes its planning-only prompt before handoff and from the text Pi
sends to its summarizer. Pi still sizes its own automatic compaction against the
selected planner, so Prewalk supplements it for the executor: the overlay
conservatively estimates the outgoing context, blocks a request above the
executor's reserve, and calls public `ctx.compact()` after the agent settles
when a replay is needed. A completed response may compact without a retry, so
the answer is not duplicated. If Pi already compacted the turn, Prewalk uses
that result instead of starting another compaction. A second unchanged pressure
failure, or failed/cancelled compaction, leaves the session on the planner
instead of looping. The estimate is not a tokenizer, so provider-specific
serialization can still differ. Prompt-cache reads also do not necessarily
survive a model/provider switch; the executor receives the history, but its
provider may charge those input tokens as a cache miss.

The temporary model compatibility layer is isolated in
`src/executor/temporary-runtime.ts`. Prewalk owns the durable handoff state and
checklist policy; the stock-Pi runtime owns the provider overlay and its
run-scoped lease. A disposed lease
cannot report provider drift or stream results into a replacement run. This
keeps a future Pi-native session-local model switch replaceable without moving
Prewalk's mutation, todo, audit, or recovery semantics into the adapter.

### Child-local Prewalk

Child-local Prewalk is disabled by default and is not enabled by the portable
setup. A child must load this extension explicitly through its upstream
`extensions` or `subagentOnlyExtensions` configuration. Each child agent is
then opted in separately under `children.agents`; a boolean `true` uses the
main executor, `false` leaves that child alone, and an object selects a custom
executor. The standard built-in roles are off by default. Review and planning
children stay off unless you explicitly turn them on, and descendants do not
inherit a parent target.

Prewalk starts with the standard pi-subagents built-in role names ready to
configure, all off by default. If pi-subagents is installed, those names are
available immediately; otherwise the entries stay inert until another
launcher supplies matching children:

| Agent | Use it when you want... |
| --- | --- |
| `scout` | Fast local codebase recon: relevant files, entry points, data flow, risks. |
| `researcher` | Web/docs research with sources and a concise research brief. |
| `worker` | Implementation work. Edits files, validates, escalates unapproved decisions instead of guessing. |
| `reviewer` | Code review and small fixes against the task/plan, tests, edge cases, and simplicity. |
| `oracle` | A second opinion before acting that challenges assumptions without editing. |
| `delegate` | A lightweight general delegate that behaves close to the parent session. |

Use `scout` before you understand the code, `researcher` before you trust
external facts, `worker` to implement, `reviewer` to check, and `oracle` when
the decision itself feels risky. These are launcher-owned roles; Prewalk only
stores the policy for each name.

Prewalk does not discover, define, or launch child agents. The keys under
`children.agents` are a manually maintained allowlist of exact runtime names
owned by the child launcher. With pi-subagents, install the recommended
launcher with `pi install npm:pi-subagents`, then enter the agent's exact
frontmatter `name` in `/prewalk configure`. Without a child launcher, these
entries are harmless policy records and remain off; Prewalk itself still works
normally in the parent session. Prewalk intentionally does not scan another
extension's agent files or duplicate its discovery rules.

An opted-in child that has a mutation-capable tool slate receives its own
namespaced `prewalk_todo` tool even when the launcher did not provide one. The
child must successfully initialize that local checklist before its first
positively proven mutation can trigger its handoff. The parent and child have
separate run identity, todo state, mutation evidence, and executor routes: a
child result or edit never triggers the parent, and the parent’s checklist
never satisfies the child. Unconfigured, disabled, read-only, equal-target,
and unavailable-executor children keep the launcher’s supplied tools and do
not gain this tool.

`worker` and a deliberately configured `delegate` are the usual implementation
choices. `scout`, `researcher`, `reviewer`, and `oracle` are commonly
reconnaissance, research, review, or advice roles; a launcher may give them
write tools, but tool capability alone does not make them suitable
implementation agents. Choose those roles deliberately.

The child executor object selects only that child’s model route. It does not
grant write tools, change the launcher’s permissions, or make Prewalk own
child scheduling. Foreground child calls usually block the parent while they
run, but background children can overlap the parent or one another. If those
runs write, use launcher-provided worktree isolation or coordinate ownership
explicitly; Prewalk keeps trajectories separate but does not serialize a
shared checkout.

```json
{
  "children": {
    "agents": {
      "worker": true,
      "reviewer": false,
      "specialist": {
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

You can inspect or change this without editing JSON:

```text
/prewalk children
/prewalk children on worker
/prewalk children off reviewer
/prewalk children target specialist openai-codex/gpt-5.6-luna low
```

The older `experimentalChild` shape is read and normalized for compatibility,
but new settings use `children`. Loading the extension alone does not add tools
to an unconfigured, disabled, read-only, or planning child. `/prewalk status`
says why a loaded child is disabled or unavailable.

## Local analytics

Analytics views use Pi session titles from current chat logs or private
backfill metadata when available, but receipts remain limited to their existing
allowlisted metadata. Generated session summaries are not stored in Prewalk
analytics.

In TUI mode, `/prewalk stats` opens an interactive dashboard with the exact
current Pi session first, followed by this week, this month, all time, and four
recent sessions. When older sessions exist, `See N more sessions` opens the
full newest-first history. Use the arrow keys to select, Page Up and Page Down
to move through longer history, Enter to open, `?` to explain the numbers, `R`
to refresh, and Escape to go back or close. The dashboard uses session titles
first and keeps stable IDs in details. It does not fold delegated child
sessions into the current-session section; use `/prewalk stats task` for the
whole task tree. Active runs show provider-recorded cost only. A planning-only
run is shown as a run that finished before switching models, not as missing
usage.

Analytics are enabled by default and stay under
`${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/prewalk/analytics`. Prewalk stores
allowlisted run metadata, token counts, Pi-reported cost, pricing evidence,
outcomes, and timestamps. It does not store prompts, responses, code, tool
inputs or outputs, credentials, provider payloads, raw errors, or filesystem
paths.

`Total paid` is provider-reported cost captured for the run. It can include
planner, executor, helper, and compaction calls. `Estimate based on` names the
part of finished spending with enough evidence for a comparison. The details
screen then shows one equation: estimated cost without switching minus what
the comparable work actually cost equals the estimated cost change. It is not
a separate planner-only run, a billing statement, or measured savings.
Missing pricing or usage is named directly; Prewalk does not invent a rate.

Total paid and the estimated cost change can cover different runs, so dividing
one by the other understates the result. Total paid counts every run; the
difference covers only comparable ones. Each comparison says exactly how much
finished spending the estimate is based on.

The change is shown as `up to` because it is an estimate. This is the most the
recorded token mix suggests you may have saved, not a measured amount. The math
assumes the planner would have used the same tokens the executor did. A cheaper
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

Start with [`Prewalk in plain English`](docs/prewalk-vs-omp.md) for the who,
what, why, and one-run walkthrough. [`docs/README.md`](docs/README.md) then
lists the main README, repository structure, analytics guide, current
host-event architecture, and optional benchmark. The source-level OMP matrix and older plans remain separate
engineering records, not setup instructions or promises about current behavior.

## Attribution

The planning, continuation, and executor-checklist prompt assets are copied
byte-for-byte from Oh My Pi revision
`f559e7e9dc1e8818d5d8e15ace28da3d42f2457d` from
`packages/coding-agent/src/prompts/system/prewalk-{plan,continue,checklist}.md`
under the MIT license. At runtime, the planning prompt maps OMP's canonical
`todo` identifier to the stock-Pi adaptation's namespaced `prewalk_todo` tool.
The coordinator adapts the stock-Pi public API. The machine-checked parity
fixture uses a separate revision for its scenario behavior. That revision is not
the source revision for the copied prompt bytes.
See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
