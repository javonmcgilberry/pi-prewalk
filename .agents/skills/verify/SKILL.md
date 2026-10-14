---
name: verify
description: Drive the Prewalk Pi extension (pi-prewalk) through a real, isolated Pi RPC process and capture evidence. Use after changing extensions/ or src/, after a Pi or Codex Conversion upgrade, or whenever you need proof that the planner-to-executor handoff, /prewalk commands, or release still work end to end. The surface is Pi's /prewalk slash commands and its model routing; no paid provider is used.
---

# Verify Prewalk

Prewalk is a Pi extension, so the user-facing surface is a Pi session: the
`/prewalk` commands, the footer status, and which model answers each turn. The
driver here launches the real Pi CLI in RPC mode with the real
`extensions/prewalk.ts` plus a credential-free scripted provider, sends the same
prompts and slash commands a user types, and records what Pi did. RPC mode runs
the same command dispatch, extension events, and model selection as the TUI;
only the rendering differs.

All paths below are relative to the repository root.

## Launch

There is no long-lived server. Install once, then every drive starts and stops
its own Pi process:

```sh
npm install            # only when node_modules is missing or doctor says it drifted
node .agents/skills/verify/scripts/drive.mjs --journey handoff
```

The driver creates a scratch tree with `mkdtemp` under the OS temp directory
(`prewalk-verify-*`) holding its own `PI_CODING_AGENT_DIR`, empty workspace,
`settings.json`, `prewalk.json`, and session file. It never reads or writes
`~/.pi/agent`, it passes `--no-mcp`, and parallel drives are isolated from each
other. Pi is ready when the first `get_state` RPC returns `fixture/planner`; the
driver checks that before doing anything else.

By default it launches `node_modules/@earendil-works/pi-coding-agent/dist/cli.js`
(the version pinned in `package.json`). To prove against the Pi the user runs,
set `PREWALK_PI_EXECUTABLE="$(which pi)"`.

## Doctor

Run this first, and again whenever a drive fails in a way that does not look
like a Prewalk bug:

```sh
node .agents/skills/verify/scripts/doctor.mjs
```

It is read-only. It checks Node >= 22, that installed Pi and Codex Conversion
packages match `package.json`, that the driver Pi starts and matches `pi` on
PATH, and whether live Pi loads this checkout. When it reports `live Pi loads
this checkout: yes`, code changes reach the user's sessions only after a Pi
restart; the driver always loads the working tree directly.

## Drive

```sh
node .agents/skills/verify/scripts/drive.mjs --journey handoff [--evidence /abs/dir]
node .agents/skills/verify/scripts/drive.mjs --journey cancel  [--evidence /abs/dir]
```

- `handoff` sends `/prewalk run`, then the user prompt `Write the verification
  file.` The fixture planner calls `prewalk_todo init`, then `write` plus
  `prewalk_todo done`. Prewalk must route the next turn to `fixture/executor`
  at low reasoning, then `/prewalk status` and `/prewalk release` run.
- `cancel` sends `/prewalk run`, `/prewalk cancel`, and `/prewalk status`, and
  must make no provider request.

Stable handles: RPC `{"type":"prompt","message":"/prewalk ..."}` with
`data.disposition === "handled"` for commands, `agent_settled` events for run
completion, `extension_ui_request` events with `method: "notify"` for command
output, `get_state().data.model` for the selected model, and `prewalk-audit`
custom entries in the session file for lifecycle facts. The scripted replies
live in `scripts/fixture-provider.mjs`; extend it, not the extension, when a
journey needs a different planner script.

For a journey the driver does not script yet, import `RpcProcess` from
`scripts/rpc-support.mjs` and `readAuditRecords` from
`scripts/rpc-smoke-support.mjs`, as `drive.mjs` does. The feature files under
`features/` name the right entry point for each feature.

## Evidence

Each drive writes `evidence/verify/<journey>-<timestamp>/` (Git-ignored), or the
`--evidence` directory:

- `summary.json`: verdict, Pi version and executable, every check with detail, and every `/prewalk` notice.
- `provider-trace.jsonl`: one line per provider request, with model, reasoning level, and the tool calls it returned.
- `audit.json` and `session.jsonl`: Prewalk's audit trail and the complete Pi session.
- `rpc-events.jsonl` and `stderr.txt`: the raw RPC stream and Pi's stderr.
- `prewalk-verify.txt`: the file the planner's `write` produced (handoff only).

Proof standards. Drive through prompts and slash commands, never by calling
coordinator methods or test harness emitters. Prove the routing from the
provider trace (which model served each request) and the side effect from the
written file, not only from the status text. A pass also requires no actionable
stderr and a byte-identical scratch `settings.json`, because Prewalk must never
change the saved default model. The fixture provider replaces only the network
call; Pi's own model selection, tool execution, and session persistence run for
real. To confirm a check has teeth, break the precondition on purpose: setting
`handoff.ignoreExtensions` to `[".txt"]` in the driver's `prewalk.json` turns
every handoff check into FAIL.

## Cleanup

The driver closes the Pi child it spawned (stdin end, then SIGTERM, then
SIGKILL on that PID only) and deletes its scratch tree in a `finally` block, even
when a check fails. The evidence directory is kept. To remove old evidence,
delete `evidence/verify/` yourself. If a drive was killed mid-run, remove
leftover scratch with `rm -rf "${TMPDIR:-/tmp}"/prewalk-verify-*` after
confirming no driver is still running; never kill Pi processes by name, since
the user's own sessions are Pi processes too.

## Helpers

- `scripts/doctor.mjs`: read-only preflight, shown above.
- `scripts/drive.mjs`: journey driver; exit code 0 means every check passed.
- `scripts/fixture-provider.mjs`: verification scaffolding loaded with `-e`; registers provider `fixture` with models `planner` and `executor` and never reaches the network.

Repository checks that complement a drive: `npm run smoke:rpc` and
`npm run smoke:rpc-cross-provider` (real Pi RPC, zero provider requests),
`npm test`, `npm run typecheck`, and `npm run lint`. Paid canaries
(`npm run canary:provider`) and the benchmark need explicit approval.

## Feature map

See [`features/README.md`](features/README.md). A proof that drives one
convenient entry point is incomplete when the map lists others.
