import { describe, expect, it } from "vitest";
import {
	ARMS,
	type BenchmarkManifest,
	type BenchmarkResult,
	evaluateResults,
	evaluateStudyMetrics,
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
		schemaVersion: 2,
		protocol: FROZEN_BENCHMARK_PROTOCOL,
		analysisFrozen: true,
		corpusFrozen: true,
		repetitions: 1,
		arms: ARMS,
		targets: {
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
		ARMS.map((arm) => ({
			taskId: entry.id,
			repetition: 1,
			arm,
			outcome: arm === "luna" && Number(entry.id.slice(5)) % 2 === 0 ? "failed" : "passed",
			cost: arm === "prewalk" ? 80 : 100,
			elapsedMs: arm === "prewalk" ? 102 : 100,
			lookupAttempts: 0,
		})),
	);
}

describe("directional benchmark contract", () => {
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
				"1",
				"--confirm-provider-cost",
				"I_UNDERSTAND_AT_LEAST_60_PROVIDER_RUNS",
			]),
		).toEqual({
			confirmation: "I_UNDERSTAND_AT_LEAST_60_PROVIDER_RUNS",
			manifestPath: "benchmark/corpus.json",
			repetitions: 1,
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
			"I_UNDERSTAND_AT_LEAST_60_PROVIDER_RUNS",
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
		expect(() => validateManifest({ ...manifest(), repetitions: 3 })).toThrow(/one repetition/);
		expect(() =>
			validateManifest({ ...manifest(), schemaVersion: 1 } as unknown as BenchmarkManifest),
		).toThrow(/frozen/);
		const invalid = manifest();
		invalid.tasks[0].validation.goldPatchPassed = false;
		expect(() => validateManifest(invalid)).toThrow(/unvalidated/);
		const changedTarget = manifest();
		changedTarget.targets.minCostOrTimeImprovementPercent = 1;
		expect(() => validateManifest(changedTarget)).toThrow(/frozen/);
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

	it("reports a missed non-winning metric target from a zero baseline", () => {
		const evaluation = evaluateStudyMetrics({
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
		expect(evaluation.targetsMet.costOrTime).toBe(true);
		expect(evaluation.targetsMet.otherMetric).toBe(false);
		expect(evaluation.allTargetsMet).toBe(false);
		expect(evaluation.directionalOnly).toBe(true);
	});

	it("requires all 60 results and reports every frozen comparison target", () => {
		const allResults = results();
		expect(allResults).toHaveLength(60);
		expect(() => evaluateResults(manifest(), allResults.slice(1))).toThrow(/every run/);
		const report = evaluateResults(manifest(), allResults);
		expect(report.runCount).toBe(60);
		expect(report.targetsMet).toEqual({
			solQuality: true,
			costOrTime: true,
			lunaQuality: true,
			otherMetric: true,
			lookup: true,
		});
		expect(report.allTargetsMet).toBe(true);
		expect(report.directionalOnly).toBe(true);
		expect(report).not.toHaveProperty("releasePassed");
	});

	it("reports when Prewalk is not meaningfully better than Luna", () => {
		const allResults = results().map((result) =>
			result.arm === "luna" ? { ...result, outcome: "passed" as const } : result,
		);
		const report = evaluateResults(manifest(), allResults);
		expect(report.targetsMet.lunaQuality).toBe(false);
		expect(report.allTargetsMet).toBe(false);
		expect(report.directionalOnly).toBe(true);
	});

	it("rejects unrelated task IDs even when the run count and tuples look complete", () => {
		const unrelated = results().map((result, index) => ({
			...result,
			taskId: `unrelated-${Math.floor(index / 3)}`,
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
		expect(report.runCount).toBe(60);
	});
});

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
