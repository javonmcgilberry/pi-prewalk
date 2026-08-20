#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const scenarios = [
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
