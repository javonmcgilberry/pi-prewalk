# Prewalk in plain English

Start here if you want to know what Prewalk is, why it exists, and how it
differs from Oh My Pi. Prewalk lets one model get a coding task moving and
lets another model finish it in the same Pi conversation.

It is not a promise that the second model will be cheaper, faster, or better.
Those things depend on the models, the task, and the provider. This guide
separates what the code does from what would still need a paid benchmark to
prove.

## The three names you need

- **Pi** is the coding-agent application that owns the conversation, tools,
  model selection, provider connections, and session history.
- **Prewalk** is this standalone Pi extension. It uses Pi's public extension
  hooks to let a planner model prepare a coding task and then route later
  regular model turns to an executor model.
- **Oh My Pi (OMP)** is the upstream Pi-based project whose Prewalk behavior
  this extension follows where stock Pi exposes the necessary hooks. OMP owns
  more of its own session machinery than a standalone extension does.

In this guide, the **planner** is the model that first explores the repository
and starts the work. The **executor** is the model that takes over after the
first successful code change. A **provider** is the service or API that runs a
model, such as OpenAI, Anthropic, Google, or another Pi provider. A model's
**effort** is its requested reasoning or thinking level. A **context window**
is how much conversation and other input it can read in one request.

## Who this is for

Prewalk is for someone who wants to try a two-model coding workflow inside a
normal Pi session without installing a modified Pi or changing Pi's saved
planner setting. It is also for maintainers comparing this extension with OMP,
or checking whether a reported behavior matches OMP, comes from a stock-Pi
limitation, or is an intentional difference.

If you only want to use it, start with [the command and configuration section
in the main README](../README.md#use-it). If you want to understand the
architecture, read [the technical host-event guide](architecture/host-event-correlation.md)
after this page.

## What problem it solves

A coding task often has two expensive parts:

1. understanding the repository and deciding how to change it;
2. carrying out the change and checking the result.

Prewalk gives those jobs to two models without turning the first model's work
into a short plan that the second model has to rediscover. The planner reads
the repository, uses a checklist owned by this extension, and makes the first
successful mutation. The executor then receives the same conversation, the
surviving checklist, and the real change that already proved the approach.

That is why Prewalk keeps one conversation and one **trajectory**. Here,
trajectory means the actual path of a live coding session: the messages, tool
results, checklist, model calls, and edits that led to the next turn. A normal
plan handoff usually creates a document and asks a new model to start from
that document. Prewalk hands over the live path instead. The executor does not
have to read a postcard summary and guess which dead ends the planner already
tried.

This does not make the executor omniscient. It still receives a different
model's history, and a different provider may normalize that history. The
point is to avoid throwing away useful context before the executor gets a
turn.

## One run, from start to finish

A normal manual run works like this.

1. **Pi keeps its selected planner.** You select the planner in Pi and choose
   an executor in `prewalk.json`, or use the configured fallback chain.
2. **You start manually or turn on automatic startup.** `/prewalk run` starts
   the flow directly. Setting `enabled: true` in `prewalk.json` turns on
   automatic mode when a fresh top-level session starts. `/prewalk auto` does
   the same for only the current session. Prewalk still limits automatic runs
   to larger implementation requests.
3. **The planner gets a planning instruction.** In the normal top-level flow,
   it must use Prewalk's namespaced `prewalk_todo` checklist when that tool is
   active before handoff is possible. An independently configured implementation
   child whose tool list has no active todo tool may skip this gate, but it still
   needs positive mutation evidence. Prewalk does not consume another
   extension's todo list.
4. **The planner makes a real change.** A successful `edit`, `write`, direct
   or shell `apply_patch` can provide the positive evidence Prewalk needs. A
   narrowly configured integration can recognize a successful patch result too.
   A printed or quoted patch, failed or partial call, or guessed result does not
   count.
5. **The full turn finishes.** Handoff happens after the assistant turn, not
   halfway through parallel tool results. Before the executor's first request,
   Prewalk removes the planning-only instruction but keeps the conversation,
   checklist, usage, model identity, and stop reasons.
6. **The executor takes the next regular model turn.** Prewalk routes that
   request through a temporary provider overlay, a wrapper around the provider
   call. Pi still displays the planner as its selected model, while the
   provider call uses the executor.
7. **The route stays with the executor.** Later regular model turns continue there
   until you use `/prewalk release`, the run is cancelled, or the session is
   cleaned up. `/prewalk status` shows the route and the reason for a failure.
8. **Cleanup is explicit.** A failed pre-handoff run or `/prewalk cancel`
   releases the temporary route before another run can start. After handoff,
   `/prewalk release` returns the conversation to the planner without changing
   Pi's saved model. Closing Pi normally finalizes the run as `session-ended`.
   If recovery later finds an unfinished journal entry after an unclean or
   stale exit, that recovery is recorded as `interrupted`. Reopening starts on
   the planner and does not silently restore the route.

If the executor is unavailable, unauthorized, cannot provide the requested
thinking level, or is blocked by an unsupported compaction setting, Prewalk
stays unarmed and leaves the session on the planner. It does not lock the
session out just because the optional second model is unavailable.

## How the handoff differs from OMP

OMP controls the code that owns its session. Its Prewalk handoff can call a
built-in, temporary session model switch. In plain terms, OMP tells the session
itself, "for now, use this other model," and the rest of OMP's code follows that
switch.

A standalone extension running on stock Pi does not have that public
session-only switch. Pi's public `setModel()` changes the saved default, which
would affect future sessions. Prewalk therefore leaves the planner selected
and temporarily wraps Pi's provider `streamSimple` call for the active run.
That wrapper is the **provider overlay**: it changes which provider request
receives the turn without pretending that Pi's selected model changed.

This is a real limitation, not a cosmetic implementation detail. It explains
why OMP has stronger built-in integration for some model and compaction
behavior, while Prewalk can still provide the same basic planner-to-executor
flow without private Pi imports or a Pi patch. The temporary route is tied to
an exact run identity, and an ended route cannot send results into a replacement
run.

## Behavior at a glance

The detailed evidence appendix is the [Prewalk versus OMP behavior
matrix](https://github.com/javonmcgilberry/pi-prewalk/blob/main/docs/research/2026-08-07-omp-behavior-matrix.md).
It has source references and the reasons behind each classification. Research
files are not included in packed installs, so this guide summarizes the
important rows below in user-facing language.

### Starting and handing off

| # | Behavior | OMP | This extension | What it means in practice |
| --- | --- | --- | --- | --- |
| 1 | Handoff mechanism | Native, temporary session model switch | Run-scoped provider overlay; Pi's selected model stays the planner | The flow is the same, but stock Pi forces a different mechanism. |
| 2 | Saved default model | Not changed | Not changed | A Prewalk run does not rewrite Pi's saved model. |
| 2a | Persistent automatic startup | Opt-in `prewalk.enabled`, off by default, applied to fresh sessions | Opt-in `enabled` in `prewalk.json`, off by default, applied to fresh top-level sessions | Both remember the preference without silently restoring a prior executor route; this extension still runs its conservative admission check. |
| 3 | What starts handoff | First `edit` or `write` after the todo gate | First positively proven mutation after the gate; patch surfaces and narrowly configured integrations can count too | Prewalk waits for evidence that code actually changed. |
| 4 | Todo gate | Required | Required | Planning alone does not switch models. |
| 5 | Planning nudge | Injected once | Injected once | Both give the planner a hidden instruction to plan deeply. |
| 6 | Continuation nudge | Used when the planner stops too early | Used in the same situation | A text-only planning reply does not silently end the run. |
| 7 | Checklist at handoff | Kept | Kept | The executor receives the live checklist instead of a new plan document. |
| 8 | Planning text after handoff | Removed from the model's later context | Removed with a context filter and an exact outgoing filter | The executor is told to execute, not to keep planning. |

### Model routing and fallback

| # | Behavior | OMP | This extension | What it means in practice |
| --- | --- | --- | --- | --- |
| 9 | Planner and executor from different providers | Supported and the normal OMP path | Supported, including tests with real authenticated provider responses | The two models do not have to use the same service. |
| 10 | Planner and executor from different APIs | Supported | Supported at the shared routing boundary; one third-party transport has been exercised | Pi normalizes much of the history, but every provider's exact request format is not covered. |
| 11 | Default executor choice | A `smol` role resolved from a priority list | Configured executor plus inferred or explicit fallbacks | You can name the executor, or let Prewalk choose from models available in the session. |
| 12 | Fallback when an executor is unavailable | Walks its priority list | Walks the inferred or configured chain | Prewalk can try the next usable candidate. |
| 12b | How the fallback list is inferred | Built-in priority list | OMP `smol` patterns, resolved against models available in this Pi session; explicit `[]` disables inference | The patterns are a preference order, not an allowlist. |

### Context, compaction, and failure

| # | Behavior | OMP | This extension | What it means in practice |
| --- | --- | --- | --- | --- |
| 13 | Executor must have a context window at least as large as the planner | No such startup rule | No startup floor; a request-time size check protects the executor | A smaller executor can be configured, but requests can still be stopped safely. |
| 14 | Automatic compaction for executor work | Sized against the model OMP switched to | Uses Pi's configured safety reserve, waits for settlement, and reuses Pi's built-in compaction when it already ran | The extension works around the fact that Pi still thinks the planner is selected. |
| 14b | Overflow recovery | Native recovery covers the executor | A check before the request or a detected failed request can compact and retry; a completed over-window response can compact without replay | Unknown provider-specific overflow still may not recover automatically. |
| 15 | Same model and same effective effort | Graceful no-op with a notice | Graceful no-op with a notice | There is no point in routing a turn to an identical target at the same thinking level. |
| 16 | Effort-only downgrade on the same model | Supported | Supported | A lower requested effort can still be a useful handoff. |
| 17 | Missing or unauthorized executor | Leaves the session running and skips handoff | Stays unarmed, shows a notice, and leaves the planner running | An optional executor failure does not strand the session. |

### Children, status, and features

| # | Behavior | OMP | This extension | What it means in practice |
| --- | --- | --- | --- | --- |
| 18 | Child or subagent Prewalk | Supported through per-agent frontmatter and settings | Opt-in per agent under `children.agents`; off by default and independently loaded | A parent run does not silently rewrite child model settings. |
| 19 | Plan-yolo mode | Separate feature | Not implemented | This extension focuses on the guarded handoff flow. |
| 20 | Status line | Available | Available | Both show the active Prewalk state. |

Child-local Prewalk remains off by default. An independently configured child is
enabled with `children.agents.worker: true`, or with an object containing a
custom executor. `false` keeps that agent on its own model and tool slate. An
implementation child whose tool list has no active todo tool may hand off after
positively proven mutation. The parent does not supply that child configuration
or inherit its route policy. The older `experimentalChild` object is accepted
and normalized, but new configuration uses the simpler per-agent shape.

### Extras and deliberate differences

| # | Behavior | OMP | This extension | What it means in practice |
| --- | --- | --- | --- | --- |
| 21 | Manual release to the planner | Not present | `/prewalk release` | You can return to the planner after handoff without changing Pi's saved model. |
| 22 | Local cost analytics and receipts | Not present | Included | `/prewalk stats` shows recorded spend and a separate price-based estimate. |
| 23 | Provider ownership checks | Not needed by OMP's native switch | The overlay checks whether another extension replaced the provider route | Another extension cannot quietly replace the route underneath an active run. |
| 24 | Native Responses compaction | Supported | Refused when explicitly enabled with Pi Codex Conversion's own response-compaction hook | This protects the planning-context filter from hook-order surprises. |
| 25 | Model display names | Generic | Special cases `gpt-5.6-sol` and `luna` in notices/status | This is a display difference, not a routing capability. |
| 26 | Executor configuration wizard | No matching OMP wizard | `/prewalk configure` offers an in-place, fuzzy-searchable model picker plus child and analytics settings | Configuration is easier to inspect without editing JSON by hand. |

The matrix uses four kinds of difference: behavior that matches, behavior
forced by stock Pi's public API, behavior chosen by this extension, and a
feature that exists on only one side. A row marked as supported does not mean
every provider has been tested live.

## Where this extension goes further

These are concrete additions or stock-Pi adaptations, not a claim that the
extension is better at everything.

- It runs as a normal package through Pi's public `ExtensionAPI`. It does not
  patch Pi or import private agent-loop code.
- It can use explicit executor fallback settings, infer a useful chain from
  OMP's `smol` patterns, and offer cross-provider choices through
  `/prewalk configure`.
- It does not impose a startup rule that the executor's context window must be
  at least as large as the planner's. Instead, it checks each outgoing request
  and asks Pi's public compaction API for help when the agent has settled.
  That closes a practical gap, but it is not a replacement for every provider's
  native overflow recovery.
- It adds `/prewalk release`, local receipts, and a check that another
  extension has not replaced the temporary provider route. Those features make
  the route easier to stop, inspect, and protect.
- It accepts positively proven patch operations and narrowly scoped integrations
  in addition to the normal edit/write path. It never treats an
  unknown or merely printed result as a code change.

Those additions exist because stock Pi gives an extension different control
than OMP has. Some are useful on their own; none changes the basic one-run,
one-trajectory boundary.

## Where OMP has the edge

OMP controls the session code itself, so it has capabilities a standalone
extension cannot safely recreate through public hooks.

- Its built-in temporary model switch updates the session's model-tracking
  code in one place. Prewalk's overlay changes provider requests while Pi still
  thinks the planner is selected.
- Its compaction and context-overflow recovery are integrated with the model
  that actually owns the session. Prewalk can guard requests and use public
  compaction, but an unknown provider-specific overflow can still fall outside
  that path.
- Its child Prewalk settings and plan-yolo mode are built in. Prewalk's child
  path is disabled by default, requires independent child configuration, and
  exposes that policy through `/prewalk configure` and `/prewalk children`.
- It can use private session machinery that a package on stock Pi must not
  assume will remain available.

The extension reproduces the user-visible handoff flow where it can. The
matrix keeps the stock-Pi limits visible instead of hiding them.

## Safety, failure, and cleanup

Prewalk should fail back to the planner rather than leave a broken route in the
session.

- In the normal top-level flow, the namespaced `prewalk_todo` tool must be
  active and successfully called before handoff, along with positive mutation
  evidence. An independently configured implementation child whose tool list
  has no active todo tool may skip that gate, but it still needs positive
  mutation evidence. Failed, cancelled, partial, still-running, quoted, or
  dynamically assembled patches do not qualify.
- Missing authorization, invalid configuration, a todo conflict, an unusable
  executor, or unsupported native Responses compaction leaves the run unarmed
  or restores the planner.
- A failed provider turn is not replayed automatically when it might contain a
  partial tool call. Start a new safe attempt with `/prewalk run`.
- `/prewalk cancel` cleans up a pre-handoff route. `/prewalk release` is the
  supported way to return after handoff. Selecting another model cancels the
  current route without changing that new selection.
- The overlay uses a run ID and an epoch, which is a run-specific counter.
  Pi events do not carry those fields, so the facts layer records which run an
  event belonged to and rejects a delayed event from an old run instead of
  applying it to a replacement run. It records facts only; lifecycle,
  mutation, todo, analytics, and scheduling decisions stay with their existing
  owners.
- Child sessions keep their own local state. A parent does not pass down its
  executor, fallback list, thinking level, or route policy automatically.

The technical contract for that last part is in
[the host-event correlation guide](architecture/host-event-correlation.md).
It is written for maintainers, not as a second user manual.

## What has been tested

The repository keeps two kinds of evidence.

First, the [machine-checked OMP parity fixture](https://github.com/javonmcgilberry/pi-prewalk/blob/main/test/fixtures/omp-prewalk-parity.json)
pins an OMP revision and the hashes of the three copied prompt files. It lists
19 upstream scenarios and classifies each one as direct, adapted for stock Pi,
or excluded because the public API cannot provide the same fact. Four scenarios
are excluded, including OMP-only auto-mode and virtual-device details. Here,
**parity** means that a behavior matches the reference scenario. The parity
test checks the revision, prompt hashes, scenario count, classifications, and
the local test file for every non-excluded scenario.

Second, the extension's tests cover the actual flow: planning and todo gates,
mutation evidence, executor selection and fallbacks, model-clamping behavior,
provider overlays, compaction boundaries, child isolation, cleanup, analytics,
and host-event attribution. The host-event correlation suite covers exact,
stale, unowned, and unknown observations, retention, ordering, reset, discard,
and compaction suppression.

For the accepted host-event refactor, the correlation and extension suites
passed 149 focused tests. The docs milestone ran one slightly broader focused
command that added the parity test, bringing that run to 150: 32
host-event-correlation, 117 extension, and 1 parity. The full secret-free suite
passed 510 tests with one Docker-dependent integration skipped, and 7 of 7
agent-loop tests passed. Type checking, lint, link checks, package checks, and
LSP checks also passed. This documentation update does not rerun provider
canaries.

## What is still unverified

The repository is careful not to turn source inspection into a performance
claim.

- There is no completed paid benchmark in this repository. Analytics can show
  recorded provider spend and an `up to` price-based difference for comparable
  runs. That difference assumes the planner would have used the same number of
  tokens as the executor. A cheaper executor may need more turns, so the
  estimate is not a billing result or proof of savings.
- No claim is made about code quality, latency, or prompt-cache behavior from
  the model switch. Those need a reviewed task corpus and a cost-confirmed
  benchmark.
- Some OMP scenarios were checked against source but not run in a live OMP
  session. The parity fixture records which ones are adapted or excluded.
- Cross-provider history conversion was tested through Pi's shared
  normalization path and one third-party transport, not every provider or its
  exact request body sent to every provider.
- Provider-specific tokenizers and overflow formats may defeat the conservative
  request estimate. Stock Pi's built-in executor overflow recovery can still
  miss a response produced under the executor identity.

## Reading the evidence

Use this page for the user-facing explanation. Use the [current architecture
guide](architecture/host-event-correlation.md) when you need the exact event
ordering and ownership rules. Use the [source-level OMP matrix](https://github.com/javonmcgilberry/pi-prewalk/blob/main/docs/research/2026-08-07-omp-behavior-matrix.md)
when you need file references, source revisions, and the reasoning behind each
row. The matrix is an evidence appendix, not a setup guide.

The package includes this guide, the main README, the analytics guide, and the
host-event architecture guide. It omits the research appendix, tests, and
historical plans from packed installs.
