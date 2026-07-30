import { describe, expect, it } from "vitest";
import {
	ARMS,
	type BenchmarkManifest,
	FROZEN_BENCHMARK_PROTOCOL,
	taskEnvironmentDigest,
} from "../scripts/benchmark-contract.mjs";
import { createBlindedSchedule } from "../scripts/benchmark-controller.mjs";
import {
	freezeBlindedMetrics,
	unblindFrozenMetrics,
	verifyFrozenMetrics,
} from "../scripts/benchmark-report-lib.mjs";

function task(index: number) {
	const entry = {
		id: `task-${index}`,
		repository: "https://github.com/example/project",
		revision: `${index}`.padStart(40, "a").slice(-40),
		sourceDigest: "f".repeat(64),
		prompt: `Fix task ${index}.`,
		testCommand: "npm test",
		timeoutSeconds: 600,
		workerImage: `ghcr.io/example/worker@sha256:${`${index}`.padStart(64, "b").slice(-64)}`,
		evaluatorImage: `ghcr.io/example/evaluator@sha256:${`${index}`.padStart(64, "c").slice(-64)}`,
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

function evidence() {
	let random = 0;
	let identifier = 0;
	const schedule = createBlindedSchedule(manifest(), {
		randomInt: (maximum) => random++ % maximum,
		runId: () => `run-${identifier++}`,
		commitmentNonce: () => "f".repeat(64),
	});
	const rows = schedule.runs.map((run) => {
		const arm = schedule.unblinding[run.blindArm];
		const passed = arm !== "luna" || run.repetition <= 3;
		return {
			schemaVersion: 1,
			corpusDigest: schedule.corpusDigest,
			scheduleDigest: schedule.scheduleDigest,
			runId: run.runId,
			taskId: run.taskId,
			repetition: run.repetition,
			blindArm: run.blindArm,
			sequence: run.sequence,
			outcome: passed ? ("passed" as const) : ("failed" as const),
			cost: arm === "prewalk" ? 80 : 100,
			elapsedMs: arm === "prewalk" ? 102 : 100,
			lookupAttempts: 0,
			sandboxViolations: 0,
			patchDigest: "d".repeat(64),
			evaluatorDigest: "e".repeat(64),
		};
	});
	return { schedule, rows };
}

describe("blinded benchmark reporting", () => {
	it("freezes complete opaque metrics before applying the arm map", () => {
		const { schedule, rows } = evidence();
		const frozen = freezeBlindedMetrics(manifest(), schedule, rows);
		expect(frozen.runCount).toBe(300);
		expect(frozen.metrics).toHaveProperty("blind-a");
		expect(JSON.stringify(frozen)).not.toMatch(/"sol"|"luna"|"prewalk"/);
		expect(frozen.rawResultsDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(frozen.metricsDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(frozen.confidenceIntervals).toBeDefined();
	});

	it("unblinds only a locked matching metrics artifact and evaluates every gate", () => {
		const { schedule, rows } = evidence();
		const frozen = freezeBlindedMetrics(manifest(), schedule, rows);
		const report = unblindFrozenMetrics(manifest(), frozen, {
			schemaVersion: 1,
			corpusDigest: schedule.corpusDigest,
			scheduleDigest: schedule.scheduleDigest,
			unblindingCommitment: schedule.unblindingCommitment,
			commitmentNonce: schedule.commitmentNonce,
			mapping: schedule.unblinding,
		});
		expect(report.metrics).toHaveProperty("sol");
		expect(Object.keys(report.gates).sort()).toEqual(
			["costOrTime", "lookup", "lunaQuality", "otherMetric", "solQuality"].sort(),
		);
		expect(report.releasePassed).toBe(true);
	});

	it("rejects missing rows, premature labels, tampering, and relabeling", () => {
		const { schedule, rows } = evidence();
		expect(() => freezeBlindedMetrics(manifest(), schedule, rows.slice(1))).toThrow(/every run/);
		expect(() =>
			freezeBlindedMetrics(manifest(), schedule, [{ ...rows[0], arm: "sol" }, ...rows.slice(1)]),
		).toThrow(/arm labels/);
		const frozen = freezeBlindedMetrics(manifest(), schedule, rows);
		expect(() =>
			unblindFrozenMetrics(
				manifest(),
				{ ...frozen, runCount: 299 },
				{
					schemaVersion: 1,
					corpusDigest: schedule.corpusDigest,
					scheduleDigest: schedule.scheduleDigest,
					unblindingCommitment: schedule.unblindingCommitment,
					commitmentNonce: schedule.commitmentNonce,
					mapping: schedule.unblinding,
				},
			),
		).toThrow(/lock/);
		const swapped = { ...schedule.unblinding };
		const [first, second] = Object.keys(swapped);
		[swapped[first], swapped[second]] = [swapped[second], swapped[first]];
		expect(() =>
			unblindFrozenMetrics(manifest(), frozen, {
				schemaVersion: 1,
				corpusDigest: schedule.corpusDigest,
				scheduleDigest: schedule.scheduleDigest,
				unblindingCommitment: schedule.unblindingCommitment,
				commitmentNonce: schedule.commitmentNonce,
				mapping: swapped,
			}),
		).toThrow(/commitment/);
	});

	it("recomputes frozen metrics from the locked raw rows before unblinding", () => {
		const { schedule, rows } = evidence();
		const frozen = freezeBlindedMetrics(manifest(), schedule, rows);
		const lock = {
			schemaVersion: 1 as const,
			corpusDigest: schedule.corpusDigest,
			scheduleDigest: schedule.scheduleDigest,
			unblindingCommitment: schedule.unblindingCommitment,
			rawResultsDigest: frozen.rawResultsDigest,
			runCount: frozen.runCount,
		};
		expect(verifyFrozenMetrics(manifest(), schedule, rows, lock, frozen)).toBe(frozen);
		expect(() =>
			verifyFrozenMetrics(
				manifest(),
				schedule,
				[{ ...rows[0], cost: rows[0].cost + 1 }, ...rows.slice(1)],
				lock,
				frozen,
			),
		).toThrow(/raw benchmark evidence/i);
		expect(() =>
			verifyFrozenMetrics(manifest(), schedule, rows, lock, {
				...frozen,
				runCount: frozen.runCount - 1,
			}),
		).toThrow(/raw benchmark evidence/i);
	});
});
