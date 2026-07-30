import { createHash } from "node:crypto";
import path from "node:path";

export const BENCHMARK_CONFIRMATION = "I_UNDERSTAND_AT_LEAST_300_PROVIDER_RUNS";
export const ARMS = ["sol", "luna", "prewalk"];
export const RELEASE_THRESHOLDS = Object.freeze({
	maxPassRateGapFromSolPoints: 5,
	minCostOrTimeImprovementPercent: 15,
	minPassRateLeadOverLunaPoints: 10,
	maxNonWinningMetricRegressionPercent: 5,
	maxLookupAttemptRateGapFromSolPoints: 0,
});
export const RESULT_OUTCOMES = ["passed", "failed", "timeout", "invalid"];
export const FROZEN_BENCHMARK_PROTOCOL = Object.freeze({
	piVersion: "0.82.1",
	conversionVersion: "3.0.3",
	promptDigests: {
		plan: "0a7442a41c2d8554f0683ac947323bc8a20d2cd6ebda049a9d9df323f2471a78",
		continue: "9af48cebe3490c679a6670968b8d59ed418d4a9a374a8d99f9be1165c93478f0",
		checklist: "045383ef934fe8afc7b0c13ad647caf9ad0aed4d6f1af594657a968aabe660d1",
	},
	activeTools: ["exec_command", "write_stdin", "apply_patch", "todo"],
	arms: {
		sol: { selectedModel: "openai-codex/gpt-5.6-sol", thinking: "high", prewalk: false },
		luna: { selectedModel: "openai-codex/gpt-5.6-luna", thinking: "low", prewalk: false },
		prewalk: {
			selectedModel: "openai-codex/gpt-5.6-sol",
			thinking: "high",
			executorThinking: "low",
			prewalk: true,
		},
	},
	retryPolicy: { autoRetry: false },
	cachePolicy: { forceCachedWebSockets: false },
	sandbox: {
		network: "none",
		readOnlyRoot: true,
		user: "65532:65532",
		capabilities: [],
		pids: 256,
		memoryBytes: 4 * 1024 ** 3,
		cpus: 2,
		workspaceBytes: 8 * 1024 ** 3,
	},
	analysis: {
		unit: "task",
		method: "paired-task-cluster-bootstrap",
		confidenceLevel: 0.95,
		bootstrapSamples: 10_000,
		bootstrapSeed: "prewalk-release-v1",
	},
});
const PINNED_IMAGE = /^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;

export function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function canonicalDigest(value) {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function optionValue(argv, index, name) {
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
	return value;
}

export function parseBenchmarkArgs(argv) {
	const options = {
		confirmation: undefined,
		manifestPath: undefined,
		repetitions: undefined,
		authFile: undefined,
		piExecutable: undefined,
		outputDirectory: undefined,
		controlDirectory: undefined,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const name = argv[index];
		if (name === "--confirm-provider-cost") {
			options.confirmation = optionValue(argv, index++, name);
		} else if (name === "--manifest") {
			options.manifestPath = optionValue(argv, index++, name);
		} else if (name === "--repetitions") {
			options.repetitions = Number(optionValue(argv, index++, name));
		} else if (name === "--auth-file") {
			options.authFile = optionValue(argv, index++, name);
		} else if (name === "--pi") {
			options.piExecutable = optionValue(argv, index++, name);
		} else if (name === "--output-dir") {
			options.outputDirectory = optionValue(argv, index++, name);
		} else if (name === "--control-dir") {
			options.controlDirectory = optionValue(argv, index++, name);
		} else {
			throw new Error(`Unknown benchmark option: ${name}`);
		}
	}
	return options;
}

export function validateBenchmarkOptions(options) {
	if (options.confirmation !== BENCHMARK_CONFIRMATION) {
		throw new Error(`Benchmark requires --confirm-provider-cost ${BENCHMARK_CONFIRMATION}.`);
	}
	for (const [name, value] of [
		["--auth-file", options.authFile],
		["--pi", options.piExecutable],
		["--output-dir", options.outputDirectory],
		["--control-dir", options.controlDirectory],
	]) {
		if (typeof value !== "string" || !path.isAbsolute(value)) {
			throw new Error(`Benchmark requires an absolute ${name}.`);
		}
	}
	if (
		path.resolve(options.controlDirectory) === path.resolve(options.outputDirectory) ||
		path
			.resolve(options.controlDirectory)
			.startsWith(`${path.resolve(options.outputDirectory)}${path.sep}`) ||
		path
			.resolve(options.outputDirectory)
			.startsWith(`${path.resolve(options.controlDirectory)}${path.sep}`)
	) {
		throw new Error("Benchmark control directory must be separate from results.");
	}
	return options;
}

export function corpusDigest(manifest) {
	return canonicalDigest(manifest);
}

export function taskEnvironmentDigest(task) {
	return canonicalDigest({
		repository: task.repository,
		revision: task.revision,
		sourceDigest: task.sourceDigest,
		testCommand: task.testCommand,
		timeoutSeconds: task.timeoutSeconds,
		workerImage: task.workerImage,
		evaluatorImage: task.evaluatorImage,
	});
}

export function validateManifest(manifest) {
	const thresholdsMatch =
		manifest?.thresholds &&
		Object.keys(manifest.thresholds).length === Object.keys(RELEASE_THRESHOLDS).length &&
		Object.entries(RELEASE_THRESHOLDS).every(
			([key, value]) => manifest.thresholds[key] === value,
		);
	if (
		manifest?.schemaVersion !== 1 ||
		canonicalJson(manifest.protocol) !== canonicalJson(FROZEN_BENCHMARK_PROTOCOL) ||
		manifest.analysisFrozen !== true ||
		manifest.corpusFrozen !== true ||
		manifest.repetitions !== 5 ||
		JSON.stringify(manifest.arms) !== JSON.stringify(ARMS) ||
		!thresholdsMatch ||
		!Array.isArray(manifest.tasks) ||
		manifest.tasks.length < 20
	) {
		throw new Error(
			"Benchmark corpus must be frozen with at least 20 tasks and five repetitions per arm.",
		);
	}
	const ids = new Set();
	for (const task of manifest.tasks) {
		if (
			!task ||
			typeof task.id !== "string" ||
			ids.has(task.id) ||
			typeof task.repository !== "string" ||
			!/^https:\/\/github\.com\//.test(task.repository) ||
			typeof task.revision !== "string" ||
			!/^[a-f0-9]{40}$/.test(task.revision) ||
			typeof task.prompt !== "string" ||
			typeof task.sourceDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(task.sourceDigest) ||
			typeof task.testCommand !== "string" ||
			typeof task.workerImage !== "string" ||
			!PINNED_IMAGE.test(task.workerImage) ||
			typeof task.evaluatorImage !== "string" ||
			!PINNED_IMAGE.test(task.evaluatorImage) ||
			task.workerImage === task.evaluatorImage ||
			typeof task.environmentDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(task.environmentDigest) ||
			task.environmentDigest !== taskEnvironmentDigest(task) ||
			!Number.isInteger(task.timeoutSeconds) ||
			task.timeoutSeconds < 60 ||
			task.validation?.goldPatchPassed !== true ||
			task.validation?.baselineReviewed !== true ||
			task.validation?.promptReviewed !== true ||
			task.validation?.environmentReproduced !== true
		) {
			throw new Error(`Benchmark task is incomplete or unvalidated: ${task?.id ?? "unknown"}.`);
		}
		ids.add(task.id);
	}
	return manifest;
}

function median(values) {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function benchmarkMetricsFor(rows) {
	const outcomes = Object.fromEntries(RESULT_OUTCOMES.map((outcome) => [outcome, 0]));
	const costs = [];
	const elapsed = [];
	let passed = 0;
	let lookupAttempts = 0;
	for (const row of rows) {
		outcomes[row.outcome] += 1;
		if (row.outcome === "passed") passed += 1;
		if (row.lookupAttempts > 0) lookupAttempts += 1;
		costs.push(row.cost);
		elapsed.push(row.elapsedMs);
	}
	return {
		passRate: (passed / rows.length) * 100,
		outcomes,
		medianCost: median(costs),
		medianElapsedMs: median(elapsed),
		lookupAttemptRate: (lookupAttempts / rows.length) * 100,
	};
}

function percentImprovement(baseline, candidate) {
	return baseline === 0 ? 0 : ((baseline - candidate) / baseline) * 100;
}

function percentRegression(baseline, candidate) {
	if (baseline === 0) return candidate === 0 ? 0 : Number.MAX_VALUE;
	return ((candidate - baseline) / baseline) * 100;
}

export function evaluateReleaseMetrics(metrics) {
	const thresholds = RELEASE_THRESHOLDS;
	const costImprovement = percentImprovement(metrics.sol.medianCost, metrics.prewalk.medianCost);
	const timeImprovement = percentImprovement(
		metrics.sol.medianElapsedMs,
		metrics.prewalk.medianElapsedMs,
	);
	const winningMetric = costImprovement >= timeImprovement ? "cost" : "time";
	const otherRegression =
		winningMetric === "cost"
			? percentRegression(metrics.sol.medianElapsedMs, metrics.prewalk.medianElapsedMs)
			: percentRegression(metrics.sol.medianCost, metrics.prewalk.medianCost);
	const gates = {
		solQuality:
			metrics.sol.passRate - metrics.prewalk.passRate <= thresholds.maxPassRateGapFromSolPoints,
		costOrTime:
			Math.max(costImprovement, timeImprovement) >= thresholds.minCostOrTimeImprovementPercent,
		lunaQuality:
			metrics.prewalk.passRate - metrics.luna.passRate >=
			thresholds.minPassRateLeadOverLunaPoints,
		otherMetric: otherRegression <= thresholds.maxNonWinningMetricRegressionPercent,
		lookup:
			metrics.prewalk.lookupAttemptRate - metrics.sol.lookupAttemptRate <=
			thresholds.maxLookupAttemptRateGapFromSolPoints,
	};
	return {
		improvements: { costImprovement, timeImprovement, otherRegression },
		gates,
		releasePassed: Object.values(gates).every(Boolean),
	};
}

export function evaluateResults(manifest, results) {
	validateManifest(manifest);
	const expected = manifest.tasks.length * manifest.repetitions * ARMS.length;
	if (!Array.isArray(results) || results.length !== expected) {
		throw new Error(`Benchmark report must include every run (${expected} required).`);
	}
	const expectedKeys = new Set(
		manifest.tasks.flatMap((task) =>
			Array.from({ length: manifest.repetitions }, (_, index) =>
				ARMS.map((arm) => `${task.id}:${index + 1}:${arm}`),
			).flat(),
		),
	);
	for (const result of results) {
		const key = `${result.taskId}:${result.repetition}:${result.arm}`;
		if (
			!expectedKeys.has(key) ||
			!ARMS.includes(result.arm) ||
			!Number.isInteger(result.repetition) ||
			result.repetition < 1 ||
			result.repetition > manifest.repetitions ||
			!RESULT_OUTCOMES.includes(result.outcome) ||
			!Number.isFinite(result.cost) ||
			result.cost < 0 ||
			!Number.isFinite(result.elapsedMs) ||
			result.elapsedMs < 0 ||
			!Number.isInteger(result.lookupAttempts) ||
			result.lookupAttempts < 0
		) {
			throw new Error(`Invalid or duplicate benchmark result: ${key}.`);
		}
		expectedKeys.delete(key);
	}
	if (expectedKeys.size > 0) throw new Error("Benchmark report is missing required runs.");
	const metrics = {};
	for (const arm of ARMS) {
		metrics[arm] = benchmarkMetricsFor(results.filter((result) => result.arm === arm));
	}
	return {
		schemaVersion: 1,
		corpusDigest: corpusDigest(manifest),
		runCount: results.length,
		metrics,
		...evaluateReleaseMetrics(metrics),
	};
}
