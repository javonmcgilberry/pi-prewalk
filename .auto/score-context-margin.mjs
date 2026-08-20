#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const split = process.argv.find((argument) => argument.startsWith("--split="))?.slice(8) ?? "train";
const marginArgument = process.argv.find((argument) => argument.startsWith("--margin="));
const margin = marginArgument === undefined ? Number.NaN : Number(marginArgument.slice(9));
if (!new Set(["train", "validation", "holdout", "optimization"]).has(split)) {
	throw new Error(`Unknown split: ${split}`);
}
if (!Number.isInteger(margin) || margin < 0 || margin > 4_096) {
	throw new Error(`Margin must be an integer from 0 through 4096: ${marginArgument ?? "missing"}`);
}

const corpus = JSON.parse(await readFile(path.resolve(".auto/context-calibration.json"), "utf8"));
const DEFAULT_THRESHOLD = 183_616;
const { CONTEXT_ESTIMATE_SAFETY_MARGIN, estimateRequestTokens } = await import(
	pathToFileURL(path.resolve("src/executor/context.ts")).href
);
if (CONTEXT_ESTIMATE_SAFETY_MARGIN !== 384) {
	throw new Error(
		`Production margin changed from the frozen baseline: ${CONTEXT_ESTIMATE_SAFETY_MARGIN}`,
	);
}

function contextFor(row) {
	return {
		systemPrompt: "",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "" }],
				api: row.api,
				provider: row.provider,
				model: row.model,
				usage: {
					...row.previousUsage,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
			{
				role: "user",
				content: "x".repeat(row.trailingTokens * 4),
				timestamp: 2,
			},
		],
	};
}

function percentile(values, fraction) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor((sorted.length - 1) * fraction)];
}

const rows = corpus.rows.filter((row) => {
	if (!row.scoreEligible) return false;
	if (split === "holdout") return row.split === "holdout";
	if (split === "validation") return row.split === "validation";
	if (split === "train") return row.split === "train";
	return row.split === "train" || row.split === "validation";
});
if (rows.length === 0) throw new Error(`No scoreable rows for split ${split}.`);

const observations = rows.map((row) => {
	const estimate =
		estimateRequestTokens(contextFor(row)) - CONTEXT_ESTIMATE_SAFETY_MARGIN + margin;
	const under = Math.max(0, row.actualRequestTokens - estimate);
	const over = Math.max(0, estimate - row.actualRequestTokens);
	const denominator = Math.max(1_024, row.actualRequestTokens);
	const loss = 8 * Math.min(1, under / denominator) + Math.min(1, over / denominator);
	return { row, estimate, under, over, loss };
});

const byModel = new Map();
for (const observation of observations) {
	const key = `${observation.row.api}|${observation.row.provider}|${observation.row.model}`;
	const values = byModel.get(key) ?? [];
	values.push(observation.loss);
	byModel.set(key, values);
}
const modelLosses = [...byModel.values()].map(
	(values) => values.reduce((total, value) => total + value, 0) / values.length,
);
const weightedError = modelLosses.reduce((total, value) => total + value, 0) / modelLosses.length;
const under = observations.map((observation) => observation.under);
const over = observations.map((observation) => observation.over);

const metrics = {
	weighted_error_ppm: Math.round(weightedError * 1_000_000),
	underestimation_rate_ppm: Math.round(
		(observations.filter((observation) => observation.under > 0).length / observations.length) *
			1_000_000,
	),
	p95_under_tokens: percentile(under, 0.95),
	p95_over_tokens: percentile(over, 0.95),
	reserve_breach_underestimates: observations.filter((observation) => observation.under > 16_384)
		.length,
	threshold_false_positives: observations.filter(
		(observation) =>
			observation.estimate > DEFAULT_THRESHOLD &&
			observation.row.actualRequestTokens <= DEFAULT_THRESHOLD,
	).length,
	threshold_false_negatives: observations.filter(
		(observation) =>
			observation.estimate <= DEFAULT_THRESHOLD &&
			observation.row.actualRequestTokens > DEFAULT_THRESHOLD,
	).length,
	rows: observations.length,
	models: byModel.size,
};

for (const [name, value] of Object.entries(metrics)) console.log(`METRIC ${name}=${value}`);
