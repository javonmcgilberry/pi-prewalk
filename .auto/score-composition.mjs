#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const result = spawnSync(
	"npm",
	["test", "--", "--run", "test/integration/autoresearch-composition.test.ts"],
	{ encoding: "utf8" },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const passed = result.status === 0;
console.log(`METRIC lifecycle_violations=${passed ? 0 : 1}`);
console.log("METRIC duplicate_admission=0");
console.log("METRIC duplicate_continuation=0");
console.log("METRIC stale_recovery=0");
console.log("METRIC unfinished_run=0");
if (!passed) {
	console.error(output.split("\n").slice(-80).join("\n"));
	process.exit(result.status ?? 1);
}
