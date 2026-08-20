#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const split = process.argv.find((argument) => argument.startsWith("--split="))?.slice(8) ?? "train";
if (!new Set(["train", "validation", "holdout", "all"]).has(split)) {
	throw new Error(`Unknown split: ${split}`);
}

const corpus = JSON.parse(await readFile(path.resolve(".auto/admission-robustness.json"), "utf8"));
const { admitAutomaticPrewalk } = await import(
	pathToFileURL(path.resolve("src/orchestration/admission.ts")).href
);
const rows = corpus.rows.filter((row) => split === "all" || row.split === split);
if (rows.length === 0) throw new Error(`No robustness rows for split ${split}.`);

const scored = rows.map((row) => ({ ...row, actual: admitAutomaticPrewalk(row.text) }));
const falseNegatives = scored.filter(
	(row) => row.expected === "admit" && row.actual !== row.expected,
);
const falsePositives = scored.filter(
	(row) => row.expected === "bypass" && row.actual !== row.expected,
);
const mustAdmitMisses = scored.filter((row) => row.mustAdmit === true && row.actual !== "admit");
const exact = scored.filter((row) => row.actual === row.expected).length;
const families = new Set(scored.map((row) => row.family));
const metrics = {
	weighted_error: falseNegatives.length * 5 + falsePositives.length,
	false_negatives: falseNegatives.length,
	false_positives: falsePositives.length,
	must_admit_misses: mustAdmitMisses.length,
	accuracy_ppm: Math.round((exact / scored.length) * 1_000_000),
	rows: scored.length,
	families: families.size,
};
for (const [name, value] of Object.entries(metrics)) console.log(`METRIC ${name}=${value}`);
if (falseNegatives.length || falsePositives.length || mustAdmitMisses.length) {
	console.error(JSON.stringify({ falseNegatives, falsePositives, mustAdmitMisses }, null, 2));
}
