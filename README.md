# Pi Prewalk

**Let the expensive model find the path. Let the fast model walk it.**

Prewalk asks a frontier model to explore the repository and prove its direction with the first successful code change. A cheaper or faster executor then picks up the same live Pi trajectory, with its context, checklist, assumptions, and working edit. It does not restart from a prose plan.

Pi still shows the planner as the selected model. After handoff, Prewalk routes primary turns through a temporary provider overlay until you release it, cancel the run, or close the session. It uses Pi's public extension API. It does not patch Pi, call `setModel()`, import private Pi modules, or hide a second model behind a fake router.

Read [`Prewalk in plain English`](docs/prewalk-vs-omp.md) for a one-run walkthrough and the practical differences from OMP.

## Quick start

Install Prewalk and the recommended child-agent launcher:

```sh
pi install git:github.com/javonmcgilberry/pi-prewalk
pi install npm:pi-subagents
```

Prewalk works without `pi-subagents`, but install the unmodified upstream package for the full workflow. Its child agents make parallel research, review, and implementation practical. The launcher still owns child definitions, tools, permissions, scheduling, and filesystem isolation. Prewalk does not launch children or change those decisions.

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

Select a planner, wait for Pi to become idle, then run:

```text
/prewalk run
/prewalk status
```

The config is strict: unknown fields fail closed. In an interactive terminal, `/prewalk configure` keeps edits in a draft and writes nothing until you choose **Save changes**. `enabled` is `false` when omitted. Set it to `true` for automatic evaluation in `startup`, `new`, and `fork` sessions; `resume` stays manual. `/prewalk auto` and `/prewalk cancel` override that default for the current session, and `/reload` keeps the choice.

For local development:

```sh
git clone https://github.com/javonmcgilberry/pi-prewalk.git
cd pi-prewalk
npm install
pi install .
```

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

A normal plan produces prose, then the implementer starts at a new seam and rereads the repository. Prewalk keeps one trajectory:

1. The planner receives a hidden planning instruction and explores the repo.
2. It must successfully initialize the namespaced `prewalk_todo` checklist.
3. It must make a real code change. Successful `edit`, `write`, direct or shell `apply_patch`, and Code Mode patch results count.
4. After the full assistant turn settles, Prewalk removes planning-only instructions and routes the next primary turn to the executor.

Failed, cancelled, partial, still-running, printed, quoted, or dynamically assembled patch attempts do not trigger the handoff. Unknown tools do not count unless an integration translates their terminal result into positive mutation evidence. If the result is unclear, Prewalk stays on the planner.

The executor inherits the transcript, checklist, explored context, and edit that proved the approach. Later primary turns stay on the executor, including after `/reload` in the same live session. `/prewalk release` restores the planner in that transcript. A new Pi session starts on the planner and never restores an old executor route.

Pi keeps the planner selected while the executor routes requests. A handoff replays history for the receiving model; signed reasoning is retained only for an exact model match. Cross-provider execution uses the executor provider's resolved credentials. A planner-resolved API key is never forwarded, though a distinct request-level override remains available.

## Limits and safety

Prewalk is experimental and uses Pi's current public extension APIs. It does not promise compatibility with specific Pi versions. There is no completed paid benchmark, so these docs make no claim about measured quality or savings.

Requirements:

- An authorized executor with enough context window and output capacity.
- No other extension registered as `prewalk_todo`.
- Pi Codex Conversion native Responses compaction disabled when installed.

During an active run, Prewalk estimates each primary planner request before transport using the planner's context window and Pi's effective `compaction.reserveTokens` setting. When the request is too large, Prewalk stops it before the provider call and waits for the agent to settle. It then accepts a compaction Pi already completed or calls Pi's public compactor. Planning resumes once from the compacted context.

The same guard protects executor requests, including executors with a smaller context window. The reserve defaults to 16,384 when Pi does not supply one. With automatic compaction disabled, failed or cancelled compaction, or a second unchanged pressure result, Prewalk fails closed and restores the planner instead of looping. The estimate is not a tokenizer; provider serialization can differ, and prompt-cache reads may not survive a model switch. These checks exist only while Prewalk owns an active route. They do not patch Pi or change ordinary Pi turns. See the [plain-language guide](docs/prewalk-vs-omp.md) and [host-event architecture](docs/architecture/host-event-correlation.md).

Keep `compaction.responsesCompaction` set to `false` when Pi Codex Conversion is installed. The legacy top-level `responsesCompaction` setting is recognized too. Prewalk refuses to arm, including while restoring an active run, when native Responses compaction is explicitly enabled; otherwise hook order could compact planning-only context before Prewalk filters it.

An optional `executorFallbacks` array lists alternate executors in order. If the field is omitted, Prewalk infers a chain from registered models and Oh My Pi's built-in `smol` preference patterns. An explicit empty array disables inference; a non-empty array is used exactly as written. Candidates must be registered, authorized, able to produce output, and different from the current model at effective reasoning. If none qualifies, Prewalk stays on the planner and names the candidates it skipped.

Pi's public host events do not carry a stable Prewalk run identity. A small facts-only layer records ownership, rejects stale observations, and never treats `apply/unknown` as proof of run ownership or mutation. The orchestration, mutation, analytics, and compaction modules decide policy. See the [host-event architecture](docs/architecture/host-event-correlation.md). `TemporaryModelRuntime` remains a replaceable provider-routing adapter with a run-scoped lease; it is not correlation policy.

## Child agents

Prewalk works in a parent session without `pi-subagents`. Install it for the full workflow: child agents can handle parallel research, review, and implementation while the parent keeps its main trajectory. An opted-in mutation-capable child gets its own namespaced `prewalk_todo` gate and model handoff.

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

## Local results (estimate, not a benchmark)

A local ledger snapshot from **2026-08-13** contains 112 receipts, including 92 finished runs and 40 compared runs. Those compared runs recorded **$197.89** in cost. The ledger estimates a **$647.26 difference** against **$831.06** if the starting planner had continued.

One recent completed Sol → Luna session recorded **$1.47** actual cost versus a **$12.15** planner-only estimate: an estimated **$10.68 difference (88%)**. These figures reprice the observed token mix at planner rates and assume the planner would have used those same tokens. They are not measured savings, a control run, or a billing statement, and they can overstate savings. Your ledger will differ.

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
