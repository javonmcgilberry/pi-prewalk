# Prewalk Harness Portability Research

**Research date:** 2026-08-12  
**Harnesses:** Claude Code, OpenAI Codex, Cursor, and OpenCode  
**Purpose:** determine whether Prewalk can become a portable planner-to-executor orchestration engine without becoming glorified plan mode.

## Executive conclusion

Portable Prewalk is viable, but not as one uniform plugin API.

All four harnesses can preserve a vendor-native conversation across a planner request and a later executor request. That is the minimum fact that makes portability credible: the executor can continue a durable session, thread, or agent containing the planner's prompts, tool calls, tool results, and code-changing work instead of receiving only a prose summary.

The harnesses differ sharply in how Prewalk can control that trajectory:

- Claude Code exposes the strongest documented same-session control through the Agent SDK, including a long-lived client, hooks, tool events, and live model setters. Its largest open-source product constraint is authentication policy: an unapproved third-party product cannot offer Claude.ai login or route users' Free, Pro, or Max credentials.
- Codex exposes rich thread and turn control through its Python SDK and app-server protocol, including per-turn models, events, steering, interruption, resume, and fork. Direct app-server use is explicitly experimental and unsupported for production workloads, so a production adapter must prefer supported SDK surfaces and isolate protocol-dependent features.
- Cursor's TypeScript SDK now supports a durable Agent, per-send model selection, streamed lifecycle and tool events, and resume. It can support a strong turn-boundary handoff, but it does not expose provider interception or arbitrary context-message removal.
- OpenCode's stable SDK supports controller-driven sequential prompts with model selection in one session. Its V2 design adds explicit session model switching and durable events, but the relevant V2 contract is experimental and unshipped as of this research date.

The right product shape is therefore:

1. one strict host-neutral Prewalk behavior contract;
2. capability-based adapters that prove which behaviors they can guarantee;
3. an optional Prewalk-controlled session for the strongest shared trajectory;
4. a simpler in-harness or bridge mode where useful;
5. visible fidelity labels that never present a summarized fresh-agent handoff as equivalent to shared trajectory.

This evidence supports extracting a portable core, but not by moving Pi-shaped interfaces into a new package first. The safer next implementation sequence is to characterize the neutral behavior contract, perform one narrow non-Pi contract proof, and let that proof determine the final extraction boundary.

## What “shared trajectory” means

The defining value of Prewalk is not that one model writes a plan and another model reads it.

A shared trajectory preserves the vendor-native conversation container and its working history across the handoff. Depending on the harness, that includes:

- user and hidden instructions;
- repository exploration;
- model responses and reasoning-visible artifacts;
- tool calls and tool results;
- approvals and denials;
- the todo or work-state gate;
- the first successful code mutation;
- compaction or checkpoint state;
- the session, thread, or agent identity used for later requests.

A summary sent to a fresh agent may still produce good code, but it is a deliberately lossy bridge. It does not inherit the exact ordering, tool/result pairs, pending state, hidden context, provider metadata, or runtime ownership unless those facts are separately serialized and restored. If a bridge restores all of that state, it has become a replay protocol rather than a simple summary handoff.

## Portable behavior contract

The following behaviors provide the highest value from the current Pi implementation and should form the cross-harness grading standard.

| ID | Behavior | Why it matters | Exactness rule |
| --- | --- | --- | --- |
| B1 | One durable trajectory | Prevents the executor from rereading the repo and reconstructing planner intent from a postcard | The same vendor-native session, thread, or agent continues after handoff |
| B2 | Planner guidance | Makes the strong model explore, establish work state, and prove the direction before yielding | Guidance is attributable to the exact run; hidden removal is preferred but not universally available |
| B3 | Namespaced work-state gate | Prevents premature handoff and gives the executor an explicit remaining-work contract | State must be run-scoped and cannot be satisfied by another session or child |
| B4 | Positive mutation proof | Ensures the planner tested the approach in code rather than only writing a plan | A successful tool event alone is insufficient when the host cannot prove a persisted filesystem change |
| B5 | Settled-turn handoff | Avoids changing owners while the planner still has in-flight tools, text, or callbacks | The planner turn must reach a host-confirmed terminal boundary |
| B6 | Executor route control | Makes the next primary model request use the intended executor | Requested and observed model identity must agree or the adapter fails closed |
| B7 | Context honesty | Prevents planner-only guidance from silently misleading the executor | Remove it when supported; otherwise retain it visibly and downgrade fidelity |
| B8 | Resume and compaction continuity | Preserves the trajectory across context pressure and process restart | Adapter-owned state and vendor session state must reconcile without fabricating continuity |
| B9 | Exact cleanup and recovery | Prevents stale events or routes from affecting a later run | Failure, cancellation, interruption, and replacement are tied to exact run identity |
| B10 | Evidence-bound analytics | Measures whether the paradigm saves cost without turning estimates into facts | Record observed vendor usage separately from counterfactual savings |

## Fidelity vocabulary

| Grade | Meaning | Required disclosure |
| --- | --- | --- |
| Native | Prewalk participates in the harness's active loop and preserves the same trajectory with enforceable route and lifecycle ownership | Name any remaining host limitation, such as context filtering or provider normalization |
| Controlled | Prewalk launches or drives one vendor-native session and performs a settled-turn model handoff inside it | Explain that Prewalk owns this task's controller process, not the user's other harness sessions |
| Resumed | Prewalk ends one process or run and resumes the same vendor conversation with another model | Explain the process boundary and any unverified replay, model, or prompt-cleanup behavior |
| Bridged | The executor receives selected state or a summary in a separate context | State plainly that this is not shared trajectory |
| Unsupported | The adapter cannot prove the minimum claimed behavior safely | Refuse or fall back without presenting the result as Prewalk-equivalent |

These labels describe behavior, not quality scores. A controlled adapter can preserve more useful trajectory than a nominally native plugin that cannot control the next model request.

## Cross-harness behavioral matrix

“Yes” means the public documented surface supports the behavior. “Partial” means Prewalk can approximate it with controller-owned state or a process boundary. “No” means no supported public contract was found. Experimental capabilities are marked separately.

| Capability | Claude Code Agent SDK | Codex Python SDK / app-server | Cursor TypeScript SDK | OpenCode stable SDK / V2 |
| --- | --- | --- | --- | --- |
| Durable vendor conversation | Yes | Yes | Yes | Yes |
| Planner and executor share stored history | Yes | Yes | Yes | Yes |
| Model choice between settled requests | Yes | Yes | Yes | Yes |
| Change model during an already-running turn | SDK setter can affect later calls, but Prewalk should switch at a boundary | No portable guarantee; use the next turn | No provider interception | V2 explicitly applies at a safe provider-turn boundary |
| Stream model, tool, and lifecycle events | Yes | Yes | Yes | Stable events exist; richer V2 stream is experimental |
| Namespaced todo tool | Custom tool / MCP | Dynamic tool or MCP depending on surface | Custom tool / MCP | Plugin tool / MCP |
| Positive mutation proof | Hooks plus filesystem verification | Item events plus filesystem verification | Tool events plus filesystem verification | Tool events plus filesystem verification |
| Confirmed turn terminal | Yes | Yes | Yes | Yes; V2 improves durable event detail |
| Resume same trajectory | Yes | Yes | Yes | Yes |
| Fork same trajectory | Yes | Yes | Not a core same-Agent requirement; new Agent is separate | Stable session fork is available |
| Arbitrary outgoing-context rewrite | No general guarantee | No general guarantee | No | No; V2 context is message-only, not the complete provider request |
| Remove planner-only history atomically | No general message-redaction contract | No general message-redaction contract | No | No stable complete-context rewrite contract |
| Observe or influence compaction | Hooks and boundaries, but Claude owns compaction | Manual operations exist; replay guarantees are limited | Opaque to the SDK beyond observed state | Stable compaction exists; V2 context/history distinguishes projected and durable state |
| Reuse ordinary user subscription in a distributable OSS adapter | Restricted: unapproved products cannot route Claude.ai plan credentials | Yes through Codex-managed ChatGPT auth, subject to plan limits | Yes through Cursor's own account and allowances | Reuses user-configured providers; each provider's terms apply |
| Public production-stable control surface | Agent SDK is documented; auth policy constrains product use | Python SDK is preferred; direct app-server is experimental and unsupported for production | TypeScript SDK is documented; payloads and closed internals remain version-sensitive | Stable SDK exists; strongest V2 controls are experimental and unshipped |
| Best current grade | Controlled, high fidelity | Controlled, high fidelity with stability caveats | Controlled, high fidelity at turn boundaries | Controlled, medium-high on stable SDK; high-potential V2 preview |

## Harness findings

### Claude Code

#### What is possible

The Agent SDK provides the most direct documented expression of Prewalk's desired flow. Python's `ClaudeSDKClient` maintains one conversation across exchanges and exposes `set_model()`. TypeScript's streaming `Query` exposes `setModel()`. Sessions contain prompts, tool calls, tool results, and responses, and can be resumed or forked.

A controller can therefore:

1. start one Claude session on the planner;
2. inject planner guidance and a namespaced todo tool;
3. observe tool and hook events;
4. verify a successful code mutation;
5. wait for a settled boundary;
6. switch the session model;
7. continue the same session as executor.

This is substantially better than invoking independent `claude -p` processes and passing a summary.

#### What is not guaranteed

- The SDK does not provide a general arbitrary-history deletion contract.
- Hook output and model changes can affect prompt caching and context behavior.
- A model setter is not a substitute for exact run attribution, filesystem verification, or terminal-event reconciliation.
- Normal `claude -p` process chaining is a weaker bridge than a long-lived streaming SDK client.

#### Authentication and distribution

Anthropic separates usage metering from product authorization. Its current Help Center notice says Agent SDK, `claude -p`, and third-party app usage still draw from a subscriber's normal usage limits because a proposed June 2026 credit split was paused. Its legal and SDK guidance also says unapproved third-party developers must not offer Claude.ai login or route Free, Pro, or Max credentials on behalf of users.

Consequences for an open-source adapter:

- a local owner using their own configured Claude environment is technically distinct from a product redistributing subscription access;
- that distinction is not a blanket legal safe harbor;
- a broadly distributed adapter should default to Claude Console API keys or supported cloud credentials unless Anthropic approves another flow;
- Prewalk must not copy, parse, or broker Claude OAuth credentials.

#### Current assessment

**Trajectory fidelity:** strongest.  
**Open-source distribution fit:** constrained by authentication policy.  
**Recommended mode:** optional controlled session through the Agent SDK; in-tool hooks alone are a degraded mode.

### OpenAI Codex

#### What is possible

Codex models a thread containing multiple turns and persisted items used as future context. The Python SDK exposes persistent threads, per-turn model choices, streamed notifications, approvals, and turn handles. App-server adds rich lifecycle control including start, resume, fork, read, list, steer, interrupt, compaction, and account operations.

A controller can keep one Codex thread, run the planner in one turn, wait for terminal events, verify work state and mutation, then start the executor as a later turn with another model.

Codex-managed ChatGPT authentication can reuse a user's Codex entitlement and limits. API-key use remains separately billed through the OpenAI Platform.

#### What is not guaranteed

- Direct `codex app-server` and its WebSocket transport are explicitly experimental and unsupported for production workloads.
- Persisted item projections and replay are not documented as lossless across versions.
- Injection appends items; it is not arbitrary context replacement.
- No general supported operation atomically removes a hidden planner prompt from all future model-visible context.
- Arbitrary cross-provider switching inside one Codex thread is not the product contract.

#### Current assessment

**Trajectory fidelity:** very strong.  
**Open-source distribution fit:** strong local authentication story.  
**Production readiness:** use the supported Python SDK where possible; isolate and version-gate app-server-only features.  
**Recommended mode:** controlled same-thread adapter, with a lower-grade `codex exec --json` fallback.

### Cursor

#### What is possible

Cursor's TypeScript SDK defines an Agent as a durable container that retains conversation state across multiple `send()` calls. Each send can select a model for that run, the model becomes sticky, and `run.stream()` emits assistant, reasoning, tool, usage, request, and status events. `Agent.resume()` reattaches after process restart.

This supports a clean controller pattern: planner send, settled terminal result, mutation verification, executor send on the same Agent.

#### What is not guaranteed

- The SDK is an agent runtime rather than a raw model-router API.
- No documented public SDK seam intercepts the provider request or replaces arbitrary prior context messages.
- Planner guidance remains part of the conversation unless Cursor itself compacts or transforms it.
- Tool argument and result payloads can change; positive mutation proof needs filesystem confirmation.
- Closed internals prevent independent verification of provider request assembly and compaction.

#### Current assessment

**Trajectory fidelity:** strong at completed-run boundaries.  
**Open-source distribution fit:** practical, but tied to a closed vendor runtime and account allowances.  
**Recommended mode:** controlled same-Agent adapter; plugin/hook-only support should be labeled low fidelity.

### OpenCode

#### What is possible now

The stable SDK exposes sessions, prompts, message history, abort, fork, events, provider catalogs, and per-prompt model selection. A controller can run a planner prompt and an executor prompt in the same durable session.

OpenCode's plugin surface is especially useful for tools and events, and its MIT license makes it the easiest harness to inspect, test, and distribute alongside.

#### V2 direction

The current V2 design adds explicit `session.switchModel`, projected context, durable history, and replayable session events. The specification states that model selection is provider-turn scoped and applies at a safe boundary rather than restarting the active turn.

V2 also makes an important limitation explicit: projected session context is message-only and does not represent the complete provider request. Complete outgoing-context replacement remains an open design area.

#### What is not guaranteed

- The relevant V2 session and `session.next.*` event contracts are experimental and unshipped.
- Stable plugin hooks do not guarantee an in-flight model replacement inside a running planner turn.
- Cross-model replay normalizes provider-specific metadata.
- Compaction preserves semantic continuity but is intentionally lossy for active context.

#### Current assessment

**Trajectory fidelity:** good through a stable SDK controller; potentially excellent when V2 stabilizes.  
**Open-source distribution fit:** strongest.  
**Production readiness:** stable controller features are usable; V2 must remain a preview until released and compatibility-tested.  
**Recommended mode:** controlled same-session adapter; do not make an unreleased V2 contract the first production dependency.

## Rankings

There is no honest single ranking because the best trajectory surface is not the same as the best open-source distribution surface.

### Shared-trajectory control

1. **Claude Code Agent SDK** — closest documented control to the desired same-session model handoff.
2. **Codex Python SDK plus isolated app-server capabilities** — excellent thread and lifecycle control, reduced by production-support caveats.
3. **Cursor TypeScript SDK** — strong same-Agent, per-run handoff without provider or context interception.
4. **OpenCode stable SDK** — credible same-session controller; V2 could move it upward after release.

### Open-source distribution fit

1. **OpenCode** — MIT, inspectable source, plugin and SDK distribution, user-configured providers.
2. **Codex** — open source, strong local ChatGPT authentication reuse, but moving protocols.
3. **Cursor** — documented SDK and simple account reuse, but closed runtime internals.
4. **Claude Code** — technically strongest but materially constrained for unapproved products using Claude subscription authentication.

### Production-readiness confidence for a first proof

1. **Cursor TypeScript SDK** — documented durable Agent and per-send model surface with a narrow controller shape.
2. **Claude Agent SDK with API or supported cloud credentials** — strong control, but authentication policy must be settled before distribution.
3. **Codex Python SDK** — promising and supported as an SDK; avoid making direct app-server production support an unstated dependency.
4. **OpenCode stable SDK** — feasible, while the most attractive V2 behavior remains unshipped.

These rankings are inputs, not a commitment to the first adapter. A prototype choice should follow the exact question being tested:

- test maximum trajectory control with Claude Code;
- test mainstream subscription reuse and thread orchestration with Codex;
- test the simplest documented turn-boundary controller with Cursor;
- test an inspectable, vendor-neutral adapter boundary with OpenCode.

## Product architecture implications

### Use a strict core and asymmetric adapters

The portable core should own host-neutral policy and facts:

- admission and phase state;
- work-state/todo semantics;
- positive mutation evidence;
- settled-turn readiness;
- handoff eligibility;
- exact run identity and cleanup;
- receipts and analytics semantics;
- capability and fidelity evaluation.

Adapters should own host mechanics:

- session/thread/agent lifecycle;
- event translation and attribution evidence;
- tool registration and observation;
- model selection and observed identity;
- transcript projection;
- resume, fork, and compaction hooks;
- authentication capability reporting;
- vendor-specific usage facts.

The core must not assume Pi event names, a provider registry, arbitrary message filtering, or a single meaning of “turn.”

### Prefer capability evidence over harness names

An adapter should advertise capabilities such as durable-session continuation, terminal-event confidence, route control, context redaction, compaction observation, and usage accounting. Prewalk should derive the fidelity grade from proven capabilities rather than a hard-coded vendor rating.

Capabilities with uncertain runtime behavior require a startup or per-version canary. A configured model name is not proof that the provider served it.

### Keep controlled sessions isolated

The strongest mode may ask a user to start one task through Prewalk so it can own the controller lifecycle. That must not turn Prewalk into a permanent replacement shell.

A controlled session should:

- reuse the user's existing project configuration, tools, permissions, and credentials only through supported harness mechanisms;
- isolate its state and child process ownership to one task;
- leave unrelated Claude Code, Codex, Cursor, or OpenCode sessions untouched;
- never rewrite global harness settings to maintain control;
- expose the underlying harness session identity for recovery and inspection;
- let the user interrupt, resume, or leave the Prewalk flow without losing repository control.

The in-harness experience remains useful when available, but its lower control must be visible.

## Recommended implementation sequence

1. Characterize the current Pi implementation as host-neutral invariants and Pi-specific mechanics.
2. Define the minimum adapter contract and capability vocabulary without moving production code yet.
3. Build one narrow non-Pi contract proof that exercises durable trajectory, todo state, positive mutation proof, settled-turn handoff, model identity, resume, and cleanup.
4. Revise the contract from that evidence.
5. Extract only the behavior proved common to Pi and the second harness.
6. Keep vendor event translation, authentication, compaction, and model-routing mechanics in adapters.
7. Add other adapters one at a time, with explicit degradation and compatibility matrices.

This sequence is slower than mechanically creating `core/` and `adapters/` directories, but it is less likely to produce a Pi-shaped abstraction that immediately needs redesign.

## Research and release gates

Before claiming support for a harness, require:

- a pinned or bounded tested harness/SDK version;
- a capability probe and observed model-identity canary;
- characterization of event ordering and terminal behavior;
- filesystem-backed mutation verification;
- resume and compaction tests;
- cancellation, interruption, stale-event, and duplicate-event tests;
- authentication and credential-boundary review;
- wording that distinguishes observed facts, estimates, and unsupported behavior;
- a no-network deterministic test lane;
- a separately approved provider-backed canary when account behavior must be proven.

No paid provider canary was run for this research.

## Risks and unresolved questions

| Risk | Impact | Required response |
| --- | --- | --- |
| Core extraction becomes Pi with renamed types | Every later adapter carries false assumptions | Require a non-Pi contract proof before locking the public core boundary |
| “Shared trajectory” is used loosely | Product drifts into plan mode while retaining the Prewalk name | Make durable vendor-session identity and fidelity grade visible in every receipt |
| Vendor event streams omit or reorder terminal facts | Premature handoff or stale-run mutation | Keep exact run identity, post-await checks, and reconciliation paths |
| Hidden planner guidance cannot be removed | Executor receives conflicting instructions | Downgrade context fidelity and make retained guidance explicit |
| Subscription reuse conflicts with vendor terms | OSS users face blocked login or account risk | Keep auth policy per adapter; never broker credentials |
| Experimental APIs drift | Adapter silently overclaims control | Pin versions, feature-detect, canary, and fail closed |
| Cross-model normalization loses provider metadata | Executor replay differs from planner context | Claim semantic continuity, not byte-identical replay |
| Controller mode feels like loss of user control | Users reject the strongest experience | Keep it optional, task-scoped, inspectable, and non-invasive |

Questions to answer during planning or the first contract proof:

- Which exact subset of todo state must live in the vendor conversation versus Prewalk's own journal?
- What evidence is sufficient to prove the executor model actually served the next request on each harness?
- Which planner instructions may remain visible without changing executor behavior?
- How should a controlled session adopt or coexist with an already-open vendor session?
- What is the minimum state required to recover after Prewalk crashes while the vendor session remains valid?
- Which usage fields are comparable enough for cross-harness efficacy experiments?

## Primary sources

### Shared project baseline

- [`README.md`](../../README.md) — current Pi trajectory and lifecycle behavior.
- [`docs/prewalk-vs-omp.md`](../prewalk-vs-omp.md) — plain-language behavioral baseline.
- [`docs/research/2026-08-07-omp-behavior-matrix.md`](2026-08-07-omp-behavior-matrix.md) — source-level behavior matrix.
- [`docs/architecture/host-event-correlation.md`](../architecture/host-event-correlation.md) — exact run attribution and ownership boundaries.

### Claude Code

- [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Agent SDK Python reference](https://code.claude.com/docs/en/agent-sdk/python)
- [Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Authentication and legal guidance](https://code.claude.com/docs/en/legal-and-compliance)
- [Agent SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart)
- [Claude plan usage notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

### OpenAI Codex

- [Codex Python SDK API reference](https://github.com/openai/codex/blob/main/sdk/python/docs/api-reference.md)
- [Codex app-server documentation](https://developers.openai.com/codex/app-server)
- [Codex app-server protocol README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Codex authentication](https://developers.openai.com/codex/auth)
- [Codex pricing](https://developers.openai.com/codex/pricing)

### Cursor

- [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript)
- [Cursor Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints)
- [Cursor SDK `Agent` declarations](https://cdn.jsdelivr.net/npm/@cursor/sdk@1.0.27/dist/esm/agent.d.ts)
- [Cursor SDK `Run` declarations](https://cdn.jsdelivr.net/npm/@cursor/sdk@1.0.27/dist/esm/run.d.ts)
- [Cursor SDK message declarations](https://cdn.jsdelivr.net/npm/@cursor/sdk@1.0.27/dist/esm/messages.d.ts)

### OpenCode

- [Stable OpenCode SDK](https://opencode.ai/docs/sdk/)
- [V2 model switching](https://opencode.ai/v2/docs/api/session/v2-session-switchmodel)
- [V2 projected context](https://opencode.ai/v2/docs/api/session/v2-session-context)
- [V2 session specification](https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md)
- [V2 session protocol source](https://github.com/anomalyco/opencode/blob/b6478dce/packages/protocol/src/groups/session.ts)
- [OpenCode context contract](https://github.com/anomalyco/opencode/blob/dev/CONTEXT.md)

## Evidence limits

This report verifies public contracts and current source, not private implementation behavior. Negative claims mean no documented supported seam was found; they do not prove that a private fork or unsupported proxy could not do more.

The vendors ship quickly. Codex schemas, Cursor SDK payloads, Claude authentication policy, and OpenCode V2 status must be rechecked before implementation or release. No authenticated provider calls, account-specific billing checks, quality benchmark, latency benchmark, or savings experiment was performed.
