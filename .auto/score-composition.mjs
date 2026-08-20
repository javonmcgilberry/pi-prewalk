#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const scenarios = [
	{
		id: "child-unavailable-fail-closed-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "reports why a child stayed unarmed when its executor is unavailable",
		metric: "unfinished_run",
	},
	{
		id: "stock-pi-child-process-boundary",
		file: "test/integration/agent-loop.test.ts",
		pattern: "runs an opted-in child through stock Pi and unmodified pi-subagents",
		metric: "lifecycle_violations",
	},
	{
		id: "public-subagent-launch-boundary",
		file: "test/integration/agent-loop.test.ts",
		pattern: "preserves a real public subagent launch before its child provider boundary",
		metric: "lifecycle_violations",
	},
	{
		id: "public-planner-recovery-shutdown-boundary",
		file: "test/integration/agent-loop.test.ts",
		pattern: "self-recovers an aborted planner and keeps one stock-Pi route through shutdown",
		metric: "stale_recovery",
	},
	{
		id: "automatic-assessment-public-runtime-boundary",
		file: "test/integration/agent-loop.test.ts",
		pattern: "launches automatic assessment and its one continuation through Pi's public runtime",
		metric: "duplicate_admission",
	},
	{
		id: "cross-provider-public-handoff-boundary",
		file: "test/integration/agent-loop.test.ts",
		pattern: "streams a cross-provider handoff through the executor's own provider",
		metric: "lifecycle_violations",
	},
	{
		id: "agent-end-continuation-boundary",
		file: "test/integration/agent-loop.test.ts",
		pattern: "settles an Autoresearch agent-end continuation around one manual Prewalk handoff",
		metric: "duplicate_continuation",
	},
	{
		id: "extension-admission-boundary",
		file: "test/integration/autoresearch-composition.test.ts",
		pattern: "does not admit an Autoresearch-shaped extension message into automatic Prewalk",
		metric: "duplicate_admission",
	},
	{
		id: "interactive-admission",
		file: "test/integration/autoresearch-composition.test.ts",
		pattern: "admits one interactive substantial input before any extension continuation",
		metric: "duplicate_admission",
	},
	{
		id: "extension-steered-boundary",
		file: "test/integration/autoresearch-composition.test.ts",
		pattern: "keeps a steered extension continuation outside automatic admission",
		metric: "duplicate_continuation",
	},
	{
		id: "mutation-gate",
		file: "test/integration/extension.test.ts",
		pattern:
			"fails closed for missing, duplicate, late, and mutation-invalid assessment decisions",
		metric: "lifecycle_violations",
	},
	{
		id: "todo-gate",
		file: "test/integration/extension.test.ts",
		pattern: "rejects delayed todo and assessment execution from run A after replacement B",
		metric: "stale_recovery",
	},
	{
		id: "compaction-continuation",
		file: "test/integration/extension.test.ts",
		pattern: "continues from the durable todo after planner compaction",
		metric: "duplicate_continuation",
	},
	{
		id: "compaction-suppression",
		file: "test/integration/extension.test.ts",
		pattern: "keeps a disowned compaction cycle suppressed across repeated terminals",
		metric: "duplicate_continuation",
	},
	{
		id: "settled-continuation-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "keeps the executor active after settling without injecting another continuation",
		metric: "duplicate_continuation",
	},
	{
		id: "reload-tool-result-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "does not re-arm continuation from arbitrary tool results across reload",
		metric: "duplicate_continuation",
	},
	{
		id: "cancelled-queued-event-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "ignores queued host events from a cancelled run after replacement",
		metric: "stale_recovery",
	},
	{
		id: "inflight-cancellation-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "does not reactivate Luna when an in-flight stream finishes after cancellation",
		metric: "unfinished_run",
	},
	{
		id: "cancelled-evaluation-reload-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "cancels and reloads an evaluation without allowing a later decision to revive it",
		metric: "stale_recovery",
	},
	{
		id: "aborted-idle-recovery-boundary",
		file: "test/integration/extension.test.ts",
		pattern:
			"recovers an aborted idle agent boundary before compaction and hands off after the valid todo and edit",
		metric: "stale_recovery",
	},
	{
		id: "empty-stale-agent-end-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "ignores an empty stale agent end after replacement",
		metric: "stale_recovery",
	},
	{
		id: "stale-todo-replay-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "keeps replaying the same planning checkpoint until a stale todo is replaced",
		metric: "stale_recovery",
	},
	{
		id: "planner-compaction-replay-boundary",
		file: "test/integration/extension.test.ts",
		pattern:
			"replays the planning checkpoint after compaction interrupts the initial planner request",
		metric: "stale_recovery",
	},
	{
		id: "planner-pressure-retry-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "fails closed when planner pressure remains after one compaction retry",
		metric: "unfinished_run",
	},
	{
		id: "automatic-compaction-disabled-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "fails closed before planner transport when automatic compaction is disabled",
		metric: "unfinished_run",
	},
	{
		id: "executor-compaction-observer-error-boundary",
		file: "test/integration/extension.test.ts",
		pattern:
			"continues after the host reports an observer error for a committed executor compaction",
		metric: "unfinished_run",
	},
	{
		id: "executor-compaction-error-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "fails the run once when executor compaction reports an error",
		metric: "unfinished_run",
	},
	{
		id: "compaction-analytics-failure-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "does not reject compaction when analytics persistence fails",
		metric: "unfinished_run",
	},
	{
		id: "cancellation-analytics-failure-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "restores the provider lease when cancellation analytics finalization fails",
		metric: "unfinished_run",
	},
	{
		id: "shutdown-analytics-failure-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "does not write session-ended when shutdown analytics finalization fails",
		metric: "unfinished_run",
	},
	{
		id: "child-mutation-isolation-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "does not treat a child subagent result as the parent's first mutation",
		metric: "lifecycle_violations",
	},
	{
		id: "child-local-todo-gate-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "requires an opted-in child's local todo before handoff and restores its tool slate",
		metric: "lifecycle_violations",
	},
	{
		id: "child-proven-mutation-handoff-boundary",
		file: "test/integration/extension.test.ts",
		pattern:
			"hands an opted-in child to a lower-effort same-model executor only after proven mutation",
		metric: "lifecycle_violations",
	},
	{
		id: "restricted-child-todo-gate-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "treats a restricted child slate without todo as an open gate",
		metric: "lifecycle_violations",
	},
	{
		id: "unconfigured-child-slate-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "does not change an unconfigured child's supplied tool slate",
		metric: "lifecycle_violations",
	},
	{
		id: "foreign-todo-ownership-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "keeps a foreign todo outside the Prewalk lifecycle",
		metric: "lifecycle_violations",
	},
	{
		id: "foreign-todo-reload-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "restores a foreign todo slate after a same-session reload",
		metric: "lifecycle_violations",
	},
	{
		id: "completed-run-reload-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "does not restore an explicitly completed run on reload",
		metric: "duplicate_continuation",
	},
	{
		id: "session-ended-reload-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "does not restore a successfully session-ended run on reload",
		metric: "duplicate_continuation",
	},
	{
		id: "completed-executor-reload-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "restores a completed Luna run on reload without adding an arm or request",
		metric: "duplicate_continuation",
	},
	{
		id: "planning-failed-reload-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "restores planning and failed Luna runs without adding an arm",
		metric: "duplicate_continuation",
	},
	{
		id: "cancelled-run-restore-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "restores a cancelled run without validating models or reinstalling the overlay",
		metric: "duplicate_continuation",
	},
	{
		id: "cancelled-provider-restore-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "restores the conversion provider when a live run is cancelled",
		metric: "unfinished_run",
	},
	{
		id: "disposed-provider-drift-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "ignores provider drift reported by a disposed run",
		metric: "stale_recovery",
	},
	{
		id: "model-selection-source-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "cancels on an explicit model selection but ignores restore selection",
		metric: "duplicate_continuation",
	},
	{
		id: "evaluation-model-selection-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "disarms evaluation on model selection and keeps automatic mode ready",
		metric: "duplicate_admission",
	},
	{
		id: "active-provider-drift-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "detects provider replacement before the next Agent-loop request",
		metric: "stale_recovery",
	},
	{
		id: "delegated-failure-restore-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "restores planner routing after a delegated Luna failure",
		metric: "unfinished_run",
	},
	{
		id: "settled-failure-retry-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "keeps a settled executor failure visible and allows a new run",
		metric: "unfinished_run",
	},
	{
		id: "transient-failure-retry-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "keeps a transient executor failure retryable until the next stream succeeds",
		metric: "unfinished_run",
	},
	{
		id: "native-provider-install-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "installs from Pi's built-in provider stream without the conversion extension",
		metric: "unfinished_run",
	},
	{
		id: "manual-release-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "releases an active executor route back to the selected planner without re-arming",
		metric: "duplicate_continuation",
	},
	{
		id: "reopened-stale-active-boundary",
		file: "test/integration/extension.test.ts",
		pattern:
			"starts a reopened session on the planner and records stale active evidence as interrupted",
		metric: "stale_recovery",
	},
	{
		id: "journal-owner-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "leaves a recently written journal to the session that still owns it",
		metric: "stale_recovery",
	},
	{
		id: "abandoned-journal-recovery-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "recovers an abandoned journal from a dead session and prices its estimate",
		metric: "stale_recovery",
	},
	{
		id: "repaired-startup-retry-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "retries a repaired startup configuration on reload",
		metric: "stale_recovery",
	},
	{
		id: "slash-cancellation-release-boundary",
		file: "test/integration/extension.test.ts",
		pattern:
			"keeps slash cancellation pre-handoff and directs an active executor route to release",
		metric: "duplicate_continuation",
	},
	{
		id: "hidden-guidance-scrub-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "scrubs hidden guidance after cancellation and from compaction",
		metric: "lifecycle_violations",
	},
	{
		id: "executor-manual-compaction-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "keeps an active executor route through manual compaction events",
		metric: "duplicate_continuation",
	},
	{
		id: "executor-overflow-compaction-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "keeps an active executor route through overflow compaction events",
		metric: "duplicate_continuation",
	},
	{
		id: "executor-threshold-compaction-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "keeps an active executor route through threshold compaction events",
		metric: "duplicate_continuation",
	},
	{
		id: "cancelled-executor-compaction-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "does not let a cancelled executor compaction restart the run",
		metric: "duplicate_continuation",
	},
	{
		id: "oversized-compaction-retry-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "stops after one compaction retry when the executor remains oversized",
		metric: "duplicate_continuation",
	},
	{
		id: "initial-handoff-compaction-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "keeps an initial handoff alive while compaction settles the agent",
		metric: "duplicate_continuation",
	},
	{
		id: "threshold-resume-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "resumes unfinished executor work after Pi compacts at turn_end",
		metric: "duplicate_continuation",
	},
	{
		id: "completed-stop-compaction-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "does not retry a completed executor stop after threshold compaction",
		metric: "duplicate_continuation",
	},
	{
		id: "executor-preflight-pressure-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "compacts and retries when the executor preflight finds an oversized context",
		metric: "duplicate_continuation",
	},
	{
		id: "compaction-disabled-fail-closed-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "fails closed when Pi automatic compaction is disabled",
		metric: "unfinished_run",
	},
	{
		id: "smaller-executor-watchdog-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "accepts a smaller executor and lets its watchdog protect the request",
		metric: "duplicate_continuation",
	},
	{
		id: "vanished-executor-reload-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "drops back to the planner when a restored run's executor has gone away",
		metric: "stale_recovery",
	},
	{
		id: "no-executor-fail-closed-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "leaves Prewalk unarmed with a notice when no executor candidate resolves",
		metric: "unfinished_run",
	},
	{
		id: "unauthorized-executor-fail-closed-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "leaves Prewalk unarmed with a notice when the executor has no configured auth",
		metric: "unfinished_run",
	},
	{
		id: "fallback-executor-selection-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "arms on a fallback executor when the primary one is missing",
		metric: "unfinished_run",
	},
	{
		id: "inferred-fallback-chain-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "infers a fallback chain when the config omits executorFallbacks",
		metric: "unfinished_run",
	},
	{
		id: "explicit-empty-fallback-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "does not infer fallbacks when executorFallbacks is explicitly empty",
		metric: "unfinished_run",
	},
	{
		id: "configuration-no-start-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "configures an executor without starting Prewalk work",
		metric: "duplicate_admission",
	},
	{
		id: "unknown-mutation-trigger-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "ignores unknown mutation-like results without consuming the later valid trigger",
		metric: "duplicate_admission",
	},
	{
		id: "active-turn-admission-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "refuses to arm manual Prewalk during an active agent turn",
		metric: "duplicate_admission",
	},
	{
		id: "automatic-session-boundary",
		file: "test/integration/extension.test.ts",
		pattern:
			"enables automatic admission from config for fresh sessions but not resumed sessions",
		metric: "duplicate_admission",
	},
	{
		id: "automatic-cancellation-reload-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "keeps a session cancellation disabled across reload even when the default is on",
		metric: "duplicate_admission",
	},
	{
		id: "automatic-default-opt-in-boundary",
		file: "test/integration/extension.test.ts",
		pattern:
			"defaults persistent automatic admission off and preserves a session opt-in on reload",
		metric: "duplicate_admission",
	},
	{
		id: "automatic-cancel-no-run-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "cancels automatic mode without starting a run",
		metric: "duplicate_admission",
	},
	{
		id: "multi-turn-assessment-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "evaluates substantial work across turns before queuing the full plan",
		metric: "duplicate_admission",
	},
	{
		id: "assessment-tool-gate-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "blocks non-read-only tools before assessment execution while permitting inspection",
		metric: "duplicate_admission",
	},
	{
		id: "assessment-inspection-boundary",
		file: "test/integration/extension.test.ts",
		pattern:
			"allows read-only exec inspection but ignores failed mutation attempts during assessment",
		metric: "duplicate_admission",
	},
	{
		id: "approved-plan-bypass-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "quietly bypasses a completed approved plan and restores the exact tool slate",
		metric: "duplicate_admission",
	},
	{
		id: "markdown-only-handoff-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "keeps the planner through Markdown-only edits before handing off for code",
		metric: "duplicate_continuation",
	},
	{
		id: "mutation-tools-unavailable-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "fails before planning when the active default tool slate cannot prove an edit",
		metric: "unfinished_run",
	},
	{
		id: "termination-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "honors explicit cancellation instead of reviving an aborted planner",
		metric: "unfinished_run",
	},
	{
		id: "stale-settlement-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "does not let a stale settled handler reset a replacement run",
		metric: "stale_recovery",
	},
	{
		id: "stale-tool-query-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "does not persist a tool result query before a later replacement-run claim",
		metric: "stale_recovery",
	},
	{
		id: "active-capture-replacement-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "captures active message and both tool-claim fallbacks before replacement",
		metric: "stale_recovery",
	},
	{
		id: "oldest-settlement-replacement-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "captures oldest-settlement message and tool fallbacks before replacement",
		metric: "stale_recovery",
	},
	{
		id: "first-known-agent-end-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "uses the first directly known agent-end message and skips earlier unknown messages",
		metric: "stale_recovery",
	},
	{
		id: "unowned-ordering-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "preserves explicit-unowned capture and direct-unowned agent-end ordering",
		metric: "stale_recovery",
	},
	{
		id: "tool-id-retention-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "retains 512 tool IDs and permits rebinding only after oldest-ID eviction",
		metric: "stale_recovery",
	},
	{
		id: "message-key-retention-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "retains 512 message keys and evicts the oldest on the 513th distinct key",
		metric: "stale_recovery",
	},
	{
		id: "cancellation-settlement-race-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "ignores settlement that races cancellation finalization",
		metric: "duplicate_continuation",
	},
	{
		id: "planner-abort-recovery-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "replays persisted planner reasoning after every abort without replacing the run",
		metric: "duplicate_continuation",
	},
	{
		id: "planner-recovery-limit-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "stops after the configured number of automatic planner recoveries",
		metric: "unfinished_run",
	},
	{
		id: "permissive-direct-tool-boundary",
		file: "test/integration/extension.test.ts",
		pattern:
			"allows a direct registered-tool execution without a host claim via permissive unknown",
		metric: "lifecycle_violations",
	},
	{
		id: "duplicate-subagent-result-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "deduplicates repeated delivery of one terminal subagent result",
		metric: "lifecycle_violations",
	},
	{
		id: "delegation-status-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "keeps delegation progress in explicit status instead of the compact footer",
		metric: "lifecycle_violations",
	},
	{
		id: "serial-delegation-tree-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "keeps evidence from serial delegation invocations in one task tree",
		metric: "lifecycle_violations",
	},
	{
		id: "analytics-failure-isolation-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "does not block subagent execution when analytics generation lookup fails",
		metric: "lifecycle_violations",
	},
	{
		id: "unrelated-analytics-input-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "ignores unrelated tool results in task-tree analytics",
		metric: "lifecycle_violations",
	},
	{
		id: "automatic-source-ownership-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "ignores extension and streaming input while automatic mode is ready",
		metric: "duplicate_admission",
	},
	{
		id: "executor-attribution-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "stops crediting planner turns to planning once the executor has taken over",
		metric: "lifecycle_violations",
	},
	{
		id: "planning-only-receipt-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "reports a planning-only run without inventing a comparison",
		metric: "lifecycle_violations",
	},
	{
		id: "post-receipt-finality-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "stops recording into a run once its receipt is written",
		metric: "unfinished_run",
	},
	{
		id: "analytics-generation-reset-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "excludes a child result that finishes after its analytics generation is reset",
		metric: "stale_recovery",
	},
	{
		id: "analytics-cleanup-retry-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "reports incomplete reset cleanup and retries it without another reset",
		metric: "stale_recovery",
	},
	{
		id: "completed-finalization-recovery-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "keeps recovery possible when completed analytics finalization fails",
		metric: "stale_recovery",
	},
	{
		id: "shutdown-boundary",
		file: "test/integration/extension.test.ts",
		pattern: "collects planner and later executor turns until shutdown, then reports the receipt",
		metric: "unfinished_run",
	},
];

const metrics = {
	lifecycle_violations: 0,
	duplicate_admission: 0,
	duplicate_continuation: 0,
	stale_recovery: 0,
	unfinished_run: 0,
};
const failures = [];

for (const scenario of scenarios) {
	const result = spawnSync(
		"npm",
		["test", "--", "--run", scenario.file, "--testNamePattern", scenario.pattern],
		{ encoding: "utf8" },
	);
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	const passed = result.status === 0 && /Tests\s+1 passed/.test(output);
	if (!passed) {
		metrics.lifecycle_violations += 1;
		metrics[scenario.metric] += 1;
		failures.push({ id: scenario.id, status: result.status, output });
	}
}

console.log(`METRIC lifecycle_violations=${metrics.lifecycle_violations}`);
console.log(`METRIC duplicate_admission=${metrics.duplicate_admission}`);
console.log(`METRIC duplicate_continuation=${metrics.duplicate_continuation}`);
console.log(`METRIC stale_recovery=${metrics.stale_recovery}`);
console.log(`METRIC unfinished_run=${metrics.unfinished_run}`);
console.log(`METRIC scenarios=${scenarios.length}`);
console.log(`METRIC failed_scenarios=${failures.length}`);
if (failures.length > 0) {
	for (const failure of failures) {
		console.error(`\n[${failure.id}] status=${failure.status}`);
		console.error(failure.output.split("\n").slice(-80).join("\n"));
	}
	process.exit(1);
}
