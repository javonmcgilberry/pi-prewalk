#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUTPUT = path.resolve(".auto/admission-robustness.json");
const families = [
	{
		id: "train-approved-plan",
		split: "train",
		expected: "admit",
		texts: [
			"Implement the approved migration plan for billing and persistence.",
			"Execute the exact implementation plan for session recovery.",
			"Build the approved feature plan across the service and client.",
			"Migrate the storage contracts according to the approved plan.",
		],
	},
	{
		id: "train-cross-cutting",
		split: "train",
		expected: "admit",
		texts: [
			"Build a cross-cutting feature across the API and dashboard.",
			"Fix the end-to-end workflow across the worker and queue.",
			"Refactor the service across the persistence and reporting layers.",
			"Implement an across-the-product recovery change.",
		],
	},
	{
		id: "train-regression",
		split: "train",
		expected: "admit",
		texts: [
			"Fix the production regression with a reproduction and regression test.",
			"Diagnose and fix the cross-cutting failure with regression coverage.",
			"Build the feature with a reproduction and a regression test.",
			"Refactor the large migration after adding a reproduction.",
		],
	},
	{
		id: "train-small-change",
		split: "train",
		expected: "bypass",
		texts: [
			"Change the button label in one file.",
			"Implement a single-file copy change.",
			"Fix one small line in the executor.",
			"Build a small isolated utility.",
		],
	},
	{
		id: "train-operations",
		split: "train",
		expected: "bypass",
		texts: [
			"Run git status and report the result.",
			"Install the approved package and update settings.",
			"Configure the executor reasoning level.",
			"Execute the one-off operational command.",
		],
	},
	{
		id: "train-direct-negation",
		split: "train",
		expected: "bypass",
		texts: [
			"Implement the migration without changing code.",
			"Build the feature without modifying files.",
			"Fix the regression without writing code.",
			"Refactor the service without editing the implementation.",
		],
	},
	{
		id: "train-making-negation",
		split: "train",
		expected: "bypass",
		texts: [
			"Implement the approved migration plan without making any code changes.",
			"Build the cross-cutting feature without making changes.",
			"Execute the exact implementation plan without any changes.",
			"Fix the large feature with no code changes.",
		],
	},
	{
		id: "train-quoted",
		split: "train",
		expected: "bypass",
		texts: [
			"Explain how the quoted request 'implement a migration' would work.",
			"Research the example `build an end-to-end feature` and summarize it.",
			'Describe the phrase "fix the cross-cutting issue".',
			"Analyze whether 'execute the approved plan' is feasible.",
		],
	},
	{
		id: "validation-end-to-end",
		split: "validation",
		expected: "admit",
		texts: [
			"Implement the end-to-end recovery workflow for the client and worker.",
			"Build the cross-cutting migration across the API and persistence layer.",
			"Fix the feature spanning the queue, service, and reporting layer.",
			"Execute the approved plan for the full session lifecycle.",
		],
	},
	{
		id: "validation-substantial",
		split: "validation",
		expected: "admit",
		texts: [
			"Implement the substantial refactor described in the plan.",
			"Build the large migration with regression coverage.",
			"Fix the substantial feature with a reproduction.",
			"Refactor the large cross-cutting change across the product.",
		],
	},
	{
		id: "validation-new-negation",
		split: "validation",
		expected: "bypass",
		texts: [
			"Refactor the approved plan without making any changes.",
			"Migrate the end-to-end feature without making code changes.",
			"Implement the cross-cutting migration with no code changes.",
			"Fix the substantial feature without any changes.",
		],
	},
	{
		id: "validation-setup",
		split: "validation",
		expected: "bypass",
		texts: [
			"Research and compare the available implementations.",
			"Explain how the executor handoff works.",
			"Set up the new package and update configuration.",
			"Diagnose why the worker is slow without changing anything.",
		],
	},
	{
		id: "holdout-multiple-concerns",
		split: "holdout",
		expected: "admit",
		texts: [
			"Fix the multiple-concerns failure in the planner and executor.",
			"Build an end-to-end feature that updates the editor and analytics.",
			"Implement the multiple concerns migration across the service.",
			"Refactor the cross-cutting planner lifecycle.",
		],
	},
	{
		id: "holdout-regression",
		split: "holdout",
		expected: "admit",
		texts: [
			"Migrate the approved contract with a regression test.",
			"Fix the large recovery workflow with reproduction coverage.",
			"Execute the exact plan across the client and service.",
			"Build the substantial feature with a regression test.",
		],
	},
	{
		id: "holdout-no-code",
		split: "holdout",
		expected: "bypass",
		texts: [
			"Build the exact feature without making any code changes.",
			"Execute the approved plan with no changes.",
			"Implement a large migration without making changes.",
			"Refactor the cross-cutting feature without any code changes.",
		],
	},
	{
		id: "holdout-research",
		split: "holdout",
		expected: "bypass",
		texts: [
			"Investigate the migration options and write a recommendation.",
			"Analyze the quoted request 'build the feature' without acting.",
			"Configure the integration and update settings.",
			"Run the maintenance command and report its result.",
		],
	},
];

const rows = families.flatMap((family) =>
	family.texts.map((text, index) => ({
		id: `${family.id}-${String(index + 1).padStart(2, "0")}`,
		split: family.split,
		family: family.id,
		text,
		expected: family.expected,
		mustAdmit: family.expected === "admit",
	})),
);
if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("Duplicate row ID");
if (rows.some((row) => !row.text || !row.family || !row.expected)) {
	throw new Error("Incomplete robustness row");
}

const corpus = {
	schemaVersion: 1,
	privacy: "Synthetic public request text only; no paths, credentials, or session content.",
	rowCount: rows.length,
	familyCount: families.length,
	rows,
};
await mkdir(path.dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(corpus, null, 2)}\n`, { mode: 0o600 });
console.log(
	JSON.stringify({
		output: path.relative(process.cwd(), OUTPUT),
		rows: rows.length,
		families: families.length,
	}),
);
