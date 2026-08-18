# Pi Prewalk

**Let the expensive model find the path. Let the fast model walk it.**

Prewalk starts a coding task on a strong planner model. The planner explores the repository, works through the problem, creates a checklist, and proves the approach with the first successful code edit. A cheaper or faster executor then continues from that same Pi conversation.

This is not traditional plan mode. The planning phase is the conversation itself.

## Why not hand the executor a plan document?

A plan document keeps the conclusion but loses much of the work that produced it: files read, tool results, rejected ideas, repository conventions, and decisions made along the way. The executor often has to read the same files and resolve the same details again.

```text
Traditional plan mode
strong model → explores the repo → writes plan.md
cheap model  → rereads the repo → reconstructs the details → implements

Prewalk
strong model → explores the repo → creates a checklist → makes the first edit
cheap model  → continues the same working trajectory → finishes and validates
```

The executor gets the conversation and tool history Pi can replay, the checklist, the explored context, and the working edit. It starts from an approach that has already touched the code instead of a summary of what might work.

Prewalk automates a switch you could make by hand. The checklist and first successful edit provide a repeatable handoff point: late enough for the planner to prove the direction, but early enough to avoid paying planner prices for the rest of the implementation.

This technique comes from Oh My Pi and is explained in the original [Stencil Prewalk post](https://stencil.so/blog/prewalk). This repository packages the core idea as a standalone Pi extension.

## Quick start

Install Prewalk:

```sh
pi install git:github.com/javonmcgilberry/pi-prewalk
```

Create `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/prewalk.json`:

```json
{
  "executor": {
    "provider": "openai-codex",
    "model": "gpt-5.6-luna",
    "reasoning": "low"
  }
}
```

Select a planner, wait for Pi to become idle, then run:

```text
/prewalk run
/prewalk status
```

That is the smallest valid config. [`prewalk.example.json`](prewalk.example.json) shows executor fallbacks, analytics, child agents, and all common settings. You can also use `/prewalk configure`; it keeps changes in a draft until you choose **Save changes**.

Automatic mode is off by default. Set `enabled` to `true` for automatic assessment in new sessions, or use `/prewalk auto` for the current session. Resumed sessions stay manual. `/reload` keeps the current session choice.

For local development:

```sh
git clone https://github.com/javonmcgilberry/pi-prewalk.git
cd pi-prewalk
npm install
pi install .
```

## A typical workflow

1. Put the task in the conversation with the planner selected. Once Pi is idle, run `/prewalk run`.
2. The planner investigates, creates the checklist, and makes the first qualifying code edit.
3. Prewalk routes the next turn to the executor. The executor finishes the checklist and runs validation.
4. Follow-up messages remain on the executor. When that task is done, run `/prewalk release` to return to the planner.
5. For another planning pass in the same conversation, run `/prewalk run` again. A common second pass is to have the planner review and simplify the implementation, then let the executor make the cleanup edits.

If automatic mode is enabled, step 5 does not need `/prewalk run`; after release, the next qualifying prompt is assessed automatically. Use `/prewalk status` whenever you are unsure which route is active.

## Local usage estimates

A local snapshot from **2026-08-13** contains 112 receipts, including 92 finished runs and 40 runs with enough data for a comparison. Those compared runs recorded **$197.89** in provider-reported cost. The ledger estimates **$831.06** if the planner had continued with the same observed token mix, a difference of **$647.26**.

One Sol → Luna session recorded **$1.47** in actual cost versus a **$12.15** planner-only estimate. That is an estimated **$10.68 difference (88%)** for that session.

These are real-usage estimates, not a control group or billing claim. They assume the planner would have used the executor's observed tokens at planner prices, which can overstate savings. This implementation has not yet completed a paid quality benchmark. The [Stencil post](https://stencil.so/blog/prewalk) has a controlled benchmark of the original technique.

## Commands

| Command | Purpose |
| --- | --- |
| `/prewalk run` | Start a manual run while Pi is idle. |
| `/prewalk auto` | Enable automatic admission for this session. |
| `/prewalk status` | Show the planner, executor, gate, route, and failure. |
| `/prewalk configure` | Configure startup, executor, children, and analytics. |
| `/prewalk children` | Inspect or change child policies. |
| `/prewalk cancel` | Cancel before handoff and disable automatic mode. |
| `/prewalk release` | Restore the planner after handoff. |
| `/prewalk stats` | View cost and model-switch estimates. |
| `/prewalk todos` | Show the current implementation checklist. |

Installing Prewalk does not add its tools to ordinary Pi turns. `prewalk_todo` and `prewalk_assess` enter the active tool list only while a manual run, automatic assessment, or opted-in child run is active. Prewalk removes them again after bypass, cancellation, failure, completion, or release. Enabling `/prewalk auto` by itself does not expose either tool.

## How the handoff works

1. The planner receives a hidden planning instruction and explores the repo.
2. It must successfully initialize the namespaced `prewalk_todo` checklist.
3. It must make a real code change. Successful `edit`, `write`, direct or shell `apply_patch`, and Code Mode patch results can count.
4. After the full assistant turn settles, Prewalk removes planning-only instructions and routes the next primary turn to the executor.

By default, Markdown-only changes do not trigger the switch. Configure this with `handoff.ignoreExtensions`; matching is case-insensitive, a mixed code-and-doc patch still counts, and `[]` makes any proven mutation count. If Prewalk cannot identify the changed paths, it treats the edit as the trigger rather than guessing.

Failed, cancelled, partial, still-running, printed, quoted, or dynamically assembled patch attempts do not trigger the handoff. Unknown tools do not count unless an integration translates their terminal result into positive mutation evidence. If the mutation itself is unclear, Prewalk stays on the planner.

Later primary turns stay on the executor, including after `/reload` in the same live session. In Prewalk status, `completed` means the first executor response completed successfully; it does not mean Prewalk detected that your task was finished. Use `/prewalk release` when the task is done. Release restores the planner, finalizes that run, and allows a new run in the same conversation. A new Pi session always starts on the planner and never restores an old executor route.

Pi continues to display the planner as the selected model while Prewalk routes requests to the executor. The receiving model gets the history Pi can replay, but signed reasoning is retained only for an exact model match. Cross-provider execution uses the executor provider's own resolved credentials; Prewalk never forwards a planner-resolved API key.

## Limits and safety

Prewalk is experimental and uses Pi's public extension APIs. The current test target is Pi **0.84.2**, but compatibility with every Pi version is not guaranteed. This standalone implementation has not completed a paid controlled benchmark, so the local figures below are estimates rather than measured quality or savings claims.

Prewalk respects Pi's active tool list, including `defaultTools`, and never turns a disabled tool back on. Before planning starts, the list must include a tool that can prove the first edit: `edit`, `write`, `apply_patch`, `bash`, `exec_command`, or Code Mode's `exec`. If it does not, Prewalk stops early and tells you what to enable. Its two tools ask providers to prefer strict JSON-schema arguments. Providers that do not support that option still use normal validation.

Requirements:

- An authorized executor with enough context window and output capacity.
- No other extension registered as `prewalk_todo`.
- Pi Codex Conversion native Responses compaction disabled when installed.

Prewalk checks planner and executor context pressure before provider requests. It uses each model's context window and Pi's effective `compaction.reserveTokens`, defaulting the reserve to 16,384 when Pi does not provide one. It can ask Pi to compact once; if pressure remains or compaction is unavailable, it restores the planner instead of looping. This estimate is not a tokenizer, provider serialization can differ, and prompt-cache reads may not survive a model switch.

Keep `compaction.responsesCompaction` set to `false` when Pi Codex Conversion is installed. The legacy top-level `responsesCompaction` setting is recognized too. Prewalk refuses to arm, including while restoring an active run, when native Responses compaction is explicitly enabled; otherwise hook order could compact planning-only context before Prewalk filters it.

An optional `executorFallbacks` array lists alternate executors in order. If omitted, Prewalk infers a chain from registered models and Oh My Pi's built-in `smol` preferences. An empty array disables inference. Candidates must be registered, authorized, able to produce output, and different from the planner at effective reasoning.

Prewalk uses a run-scoped provider route and rejects stale host events. It does not patch Pi, call `setModel()`, import private Pi modules, or change ordinary Pi turns. See the [plain-language guide](docs/prewalk-vs-omp.md) and [host-event architecture](docs/architecture/host-event-correlation.md) for the details.

## Child agents

Prewalk works in a parent session without `pi-subagents`. Install it for the full workflow: child agents can handle parallel research, review, and implementation while the parent keeps its main trajectory. An opted-in mutation-capable child gets its own namespaced `prewalk_todo` gate and model handoff.

```sh
pi install npm:pi-subagents
```

Prewalk does not discover, define, or launch child agents. It does not rewrite their models, thinking levels, fallback models, permissions, tools, scheduling, or descendants. The child launcher owns those decisions. A child executor override selects a route; it does not grant write access.

Child trajectories are separate. A child's checklist, mutation evidence, and executor route cannot arm the parent, and the parent's state cannot arm the child. Separate trajectories do not lock a shared checkout. Concurrent writers need launcher worktrees or explicit coordination.

Child Prewalk is off by default and is not enabled by the portable setup. A child must load this extension through its upstream `extensions` or `subagentOnlyExtensions` configuration, then be opted in under `children.agents`. Standard roles are off until configured:

| Role | Typical use |
| --- | --- |
| `scout` | Local codebase reconnaissance. |
| `researcher` | Web or documentation research. |
| `worker` | Implementation. |
| `reviewer` | Review and small fixes. |
| `oracle` | A non-editing second opinion. |
| `delegate` | General delegated work. |

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

Use `/prewalk children`, `/prewalk children on worker`, `/prewalk children off reviewer`, or `/prewalk children target specialist openai-codex/gpt-5.6-luna low`. The older `experimentalChild` shape is normalized for compatibility; new settings use `children`.

## Local analytics and privacy

`/prewalk stats` opens a dashboard with the current session first, followed by recent periods and sessions. Active runs show provider-recorded cost. A planning-only run means the session ended before switching models, not that usage is missing. Use `/prewalk stats task` for the whole task tree, including delegated work.

Analytics live under `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/prewalk/analytics`. Prewalk stores allowlisted run metadata, token counts, Pi-reported cost, pricing evidence, outcomes, and timestamps. It does not store prompts, responses, code, tool inputs or outputs, credentials, provider payloads, raw errors, or filesystem paths. `Cost` is provider-reported spend. The switching estimate uses finished runs with a model switch and enough pricing data; missing pricing or usage is named instead of invented. See the [analytics guide](docs/analytics.md) for receipt math, task-tree coverage, exports, resets, and benchmark imports.

## Failure and cleanup

- Selecting another Pi model cancels the current route without changing the new selection. After cancellation, the footer keeps the cancelled run visible and refreshes its selected model.
- A failed pre-handoff run or explicit cancellation releases the provider overlay before another run starts. After handoff, use `/prewalk release`.
- Planner/provider mismatch, missing authorization, invalid config, todo conflict, and unsupported native compaction fail before executor use.
- If an executor provider fails outside context pressure, Prewalk restores the planner, preserves the transcript and receipt, and does not replay a possibly partial tool turn automatically.
- Hidden planning prompts stay out of normal model context and compaction input. While a Prewalk run is active, its provider overlay checks planner and executor requests before transport; inactive Pi sessions are not wrapped.

Use `/prewalk status` for the stable failure reason. To start over, run `/prewalk cancel`, then `/prewalk run`.

## Development and paid paths

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

CI is secret-free and does not call paid providers. Compatibility jobs use a bounded temporary copy with checkout credentials disabled. Provider canaries and efficacy benchmarks are manual, approval-gated, and cost-confirmed. The authenticated canary makes real requests; read [`benchmark/README.md`](benchmark/README.md) before running either paid path.

```sh
npm run canary:provider -- \
  --confirm-provider-cost I_UNDERSTAND_PROVIDER_REQUESTS \
  --auth-file "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json" \
  --planner openai-codex/gpt-5.6-luna \
  --executor anthropic/claude-haiku-4-5
```

The canary stages those two credentials into an owner-only temporary profile, limits the run to `prewalk_todo`, `read`, `edit`, and `write`, and writes redacted evidence to `--evidence-dir`. Add `--extension /absolute/path/to/provider-extension.ts` for an extension provider. Use `--payload-inspection optional` when the transport lacks Pi's provider-payload hook; the evidence records that boundary instead of treating it as proof.

## Documentation and attribution

Start with [`Prewalk in plain English`](docs/prewalk-vs-omp.md). The [documentation index](docs/README.md) links the repository structure, analytics guide, host-event architecture, and optional benchmark. The source-level [OMP behavior matrix](https://github.com/javonmcgilberry/pi-prewalk/blob/main/docs/research/2026-08-07-omp-behavior-matrix.md) and older plans are engineering records, not setup promises.

The planning, continuation, and executor-checklist prompts are copied byte-for-byte from Oh My Pi revision `f559e7e9dc1e8818d5d8e15ace28da3d42f2457d`, from `packages/coding-agent/src/prompts/system/prewalk-{plan,continue,checklist}.md`, under the MIT license. At runtime, the planning prompt maps OMP's `todo` identifier to the stock-Pi `prewalk_todo` tool. The coordinator adapts Pi's public API. The machine-checked parity fixture uses a separate revision for scenario behavior. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
