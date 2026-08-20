#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const split =
	process.argv.find((argument) => argument.startsWith("--split="))?.slice(8) ?? "optimization";
if (!new Set(["optimization", "holdout", "all"]).has(split)) {
	throw new Error(`Unknown split: ${split}`);
}

const corpus = JSON.parse(await readFile(path.resolve(".auto/admission-corpus.json"), "utf8"));
const { admitAutomaticPrewalk } = await import(
	pathToFileURL(path.resolve("src/orchestration/admission.ts")).href
);
const rows = corpus.rows.filter((row) => split === "all" || row.split !== "holdout");
const selected = split === "holdout" ? corpus.rows.filter((row) => row.split === "holdout") : rows;
const scored = selected.map((row) => ({ ...row, actual: admitAutomaticPrewalk(row.text) }));
const falseNegatives = scored.filter(
	(row) => row.expected === "admit" && row.actual !== row.expected,
);
const falsePositives = scored.filter(
	(row) => row.expected === "bypass" && row.actual !== row.expected,
);
const exact = scored.filter((row) => row.actual === row.expected).length;
const weightedError = falseNegatives.length * 5 + falsePositives.length;

const metrics = {
	weighted_error: weightedError,
	false_negatives: falseNegatives.length,
	false_positives: falsePositives.length,
	accuracy_ppm: Math.round((exact / scored.length) * 1_000_000),
	rows: scored.length,
};
for (const [name, value] of Object.entries(metrics)) console.log(`METRIC ${name}=${value}`);
if (falseNegatives.length || falsePositives.length) {
	console.error(JSON.stringify({ falseNegatives, falsePositives }, null, 2));
}
