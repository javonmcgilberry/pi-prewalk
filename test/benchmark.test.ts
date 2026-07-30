import { describe, expect, it } from "vitest";
import {
	ARMS,
	type BenchmarkManifest,
	type BenchmarkResult,
	evaluateReleaseMetrics,
	evaluateResults,
	FROZEN_BENCHMARK_PROTOCOL,
	parseBenchmarkArgs,
	taskEnvironmentDigest,
	validateBenchmarkOptions,
	validateManifest,
} from "../scripts/benchmark-contract.mjs";

function task(index: number) {
	const entry = {
		id: `task-${index}`,
		repository: "https://github.com/example/project",
		revision: `${index}`.padStart(40, "a").slice(-40),
		sourceDigest: "f".repeat(64),
		prompt: `Fix task ${index}.`,
		testCommand: "npm test",
		timeoutSeconds: 600,
		workerImage: `ghcr.io/example/prewalk-worker@sha256:${`${index}`.padStart(64, "b").slice(-64)}`,
		evaluatorImage: `ghcr.io/example/prewalk-evaluator@sha256:${`${index}`.padStart(64, "c").slice(-64)}`,
		validation: {
			goldPatchPassed: true,
			baselineReviewed: true,
			promptReviewed: true,
			environmentReproduced: true,
		},
	};
	return { ...entry, environmentDigest: taskEnvironmentDigest(entry) };
}

function manifest(): BenchmarkManifest {
	return {
		schemaVersion: 1,
		protocol: FROZEN_BENCHMARK_PROTOCOL,
		analysisFrozen: true,
		corpusFrozen: true,
		repetitions: 5,
		arms: ARMS,
		thresholds: {
			maxPassRateGapFromSolPoints: 5,
			minCostOrTimeImprovementPercent: 15,
			minPassRateLeadOverLunaPoints: 10,
			maxNonWinningMetricRegressionPercent: 5,
			maxLookupAttemptRateGapFromSolPoints: 0,
		},
		tasks: Array.from({ length: 20 }, (_, index) => task(index + 1)),
	};
}

function results(): BenchmarkResult[] {
	return manifest().tasks.flatMap((entry) =>
		Array.from({ length: 5 }, (_, index) =>
			ARMS.map((arm) => {
				const outcome: BenchmarkResult["outcome"] =
					arm !== "luna" || index < 3 ? "passed" : "failed";
				return {
					taskId: entry.id,
					repetition: index + 1,
					arm,
					outcome,
					cost: arm === "prewalk" ? 80 : 100,
					elapsedMs: arm === "prewalk" ? 102 : 100,
					lookupAttempts: 0,
				};
			}),
		).flat(),
	);
}

describe("release benchmark contract", () => {
	it("freezes the exact shipped Prewalk prompt bytes", async () => {
		for (const [name, expected] of Object.entries(FROZEN_BENCHMARK_PROTOCOL.promptDigests)) {
			const content = await readFile(new URL(`../prompts/prewalk-${name}.md`, import.meta.url));
			expect(createHash("sha256").update(content).digest("hex")).toBe(expected);
		}
	});

	it("parses only the reviewed runner options", () => {
		expect(
			parseBenchmarkArgs([
				"--manifest",
				"benchmark/corpus.json",
				"--repetitions",
				"5",
				"--confirm-provider-cost",
				"I_UNDERSTAND_AT_LEAST_300_PROVIDER_RUNS",
			]),
		).toEqual({
			confirmation: "I_UNDERSTAND_AT_LEAST_300_PROVIDER_RUNS",
			manifestPath: "benchmark/corpus.json",
			repetitions: 5,
			authFile: undefined,
			piExecutable: undefined,
			outputDirectory: undefined,
			controlDirectory: undefined,
		});
		expect(() => parseBenchmarkArgs(["--worker-command", "unsafe"])).toThrow(/Unknown/);
	});

	it("requires explicit absolute controller paths and a private control directory", () => {
		const options = parseBenchmarkArgs([
			"--confirm-provider-cost",
			"I_UNDERSTAND_AT_LEAST_300_PROVIDER_RUNS",
			"--auth-file",
			"/tmp/auth.json",
			"--pi",
			"/usr/local/bin/pi",
			"--output-dir",
			"/tmp/results",
			"--control-dir",
			"/tmp/control",
		]);
		expect(validateBenchmarkOptions(options)).toBe(options);
		expect(() =>
			validateBenchmarkOptions({ ...options, controlDirectory: "/tmp/results/control" }),
		).toThrow(/separate/);
	});

	it("rejects an incomplete, mutable, or unvalidated corpus", () => {
		expect(() => validateManifest({ ...manifest(), tasks: [] })).toThrow(/at least 20/);
		expect(() => validateManifest({ ...manifest(), corpusFrozen: false })).toThrow(/frozen/);
		const invalid = manifest();
		invalid.tasks[0].validation.goldPatchPassed = false;
		expect(() => validateManifest(invalid)).toThrow(/unvalidated/);
		const changedThreshold = manifest();
		changedThreshold.thresholds.minCostOrTimeImprovementPercent = 1;
		expect(() => validateManifest(changedThreshold)).toThrow(/frozen/);
		const mutableImage = manifest();
		mutableImage.tasks[0].workerImage = "ghcr.io/example/prewalk-worker:latest";
		expect(() => validateManifest(mutableImage)).toThrow(/unvalidated/);
		const sharedImage = manifest();
		sharedImage.tasks[0].evaluatorImage = sharedImage.tasks[0].workerImage;
		sharedImage.tasks[0].environmentDigest = taskEnvironmentDigest(sharedImage.tasks[0]);
		expect(() => validateManifest(sharedImage)).toThrow(/unvalidated/);
		const changedEnvironment = manifest();
		changedEnvironment.tasks[0].testCommand = "npm run different";
		expect(() => validateManifest(changedEnvironment)).toThrow(/unvalidated/);
		const changedProtocol = manifest();
		changedProtocol.protocol = {
			...FROZEN_BENCHMARK_PROTOCOL,
			cachePolicy: { forceCachedWebSockets: true },
		};
		expect(() => validateManifest(changedProtocol)).toThrow(/frozen/);
	});

	it("fails a non-winning metric regression from a zero baseline", () => {
		const evaluation = evaluateReleaseMetrics({
			sol: {
				passRate: 100,
				medianCost: 0,
				medianElapsedMs: 100,
				lookupAttemptRate: 0,
			},
			luna: {
				passRate: 80,
				medianCost: 0,
				medianElapsedMs: 100,
				lookupAttemptRate: 0,
			},
			prewalk: {
				passRate: 100,
				medianCost: 1,
				medianElapsedMs: 80,
				lookupAttemptRate: 0,
			},
		});
		expect(evaluation.gates.costOrTime).toBe(true);
		expect(evaluation.gates.otherMetric).toBe(false);
		expect(evaluation.releasePassed).toBe(false);
	});

	it("requires all 300 results and evaluates every frozen gate", () => {
		const allResults = results();
		expect(allResults).toHaveLength(300);
		expect(() => evaluateResults(manifest(), allResults.slice(1))).toThrow(/every run/);
		const report = evaluateResults(manifest(), allResults);
		expect(report.runCount).toBe(300);
		expect(report.gates).toEqual({
			solQuality: true,
			costOrTime: true,
			lunaQuality: true,
			otherMetric: true,
			lookup: true,
		});
		expect(report.releasePassed).toBe(true);
	});

	it("fails release when Prewalk is not meaningfully better than Luna", () => {
		const allResults = results().map((result) =>
			result.arm === "luna" ? { ...result, outcome: "passed" as const } : result,
		);
		const report = evaluateResults(manifest(), allResults);
		expect(report.gates.lunaQuality).toBe(false);
		expect(report.releasePassed).toBe(false);
	});

	it("rejects unrelated task IDs even when the run count and tuples look complete", () => {
		const unrelated = results().map((result, index) => ({
			...result,
			taskId: `unrelated-${Math.floor(index / 15)}`,
		}));
		expect(() => evaluateResults(manifest(), unrelated)).toThrow(/Invalid or duplicate/);
	});

	it("retains failed, timeout, and invalid runs in the denominator", () => {
		const allResults = results();
		allResults[0].outcome = "timeout";
		allResults[1].outcome = "invalid";
		const report = evaluateResults(manifest(), allResults);
		expect(report.metrics.sol.outcomes.timeout).toBe(1);
		expect(report.metrics.luna.outcomes.invalid).toBe(1);
		expect(report.runCount).toBe(300);
	});
});

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
