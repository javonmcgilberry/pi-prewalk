import type { BenchmarkManifest } from "./benchmark-contract.mjs";
import type { ScheduledRun } from "./benchmark-controller.mjs";

export interface BlindedRow {
	schemaVersion: number;
	corpusDigest: string;
	scheduleDigest: string;
	runId: string;
	taskId: string;
	repetition: number;
	blindArm: string;
	sequence: number;
	outcome: "passed" | "failed" | "timeout" | "invalid";
	cost: number;
	elapsedMs: number;
	lookupAttempts: number;
	sandboxViolations: number;
	patchDigest: string;
	evaluatorDigest: string;
	arm?: string;
}

export interface FrozenMetrics {
	schemaVersion: 1;
	corpusDigest: string;
	scheduleDigest: string;
	unblindingCommitment: string;
	rawResultsDigest: string;
	metricsDigest: string;
	runCount: number;
	metrics: Record<string, Record<string, unknown>>;
	confidenceIntervals: Record<string, unknown>;
}

export function freezeBlindedMetrics(
	manifest: BenchmarkManifest,
	schedule: {
		schemaVersion: 1;
		corpusDigest: string;
		scheduleDigest: string;
		unblindingCommitment: string;
		runs: ScheduledRun[];
	},
	rows: BlindedRow[],
): FrozenMetrics;
export function verifyFrozenMetrics(
	manifest: BenchmarkManifest,
	schedule: {
		schemaVersion: 1;
		corpusDigest: string;
		scheduleDigest: string;
		unblindingCommitment: string;
		runs: ScheduledRun[];
	},
	rows: BlindedRow[],
	lock: {
		schemaVersion: 1;
		corpusDigest: string;
		scheduleDigest: string;
		unblindingCommitment: string;
		rawResultsDigest: string;
		runCount: number;
	},
	frozen: FrozenMetrics,
): FrozenMetrics;

export function unblindFrozenMetrics(
	manifest: BenchmarkManifest,
	frozen: FrozenMetrics,
	unblinding: {
		schemaVersion: 1;
		corpusDigest: string;
		scheduleDigest: string;
		unblindingCommitment: string;
		commitmentNonce: string;
		mapping: Record<string, string>;
	},
): {
	schemaVersion: 2;
	corpusDigest: string;
	scheduleDigest: string;
	unblindingCommitment: string;
	rawResultsDigest: string;
	metricsDigest: string;
	runCount: number;
	metrics: Record<string, unknown>;
	confidenceIntervals: Record<string, unknown>;
	improvements: {
		costImprovement: number;
		timeImprovement: number;
		otherRegression: number;
	};
	targetsMet: Record<string, boolean>;
	allTargetsMet: boolean;
	directionalOnly: true;
};
