import type { BenchmarkManifest, BenchmarkOutcome, BenchmarkTask } from "./benchmark-contract.mjs";

export interface ScheduledRun {
	runId: string;
	taskId: string;
	repetition: number;
	blindArm: string;
	sequence: number;
}

export interface BenchmarkRuntimeResult {
	outcome: BenchmarkOutcome;
	cost: number;
	elapsedMs: number;
	lookupAttempts: number;
	sandboxViolations: number;
	patchDigest: string;
	evaluatorDigest: string;
}

export interface BenchmarkRuntime {
	preflight(manifest: BenchmarkManifest): Promise<void>;
	run(input: {
		task: BenchmarkTask;
		arm: string;
		run: ScheduledRun;
	}): Promise<BenchmarkRuntimeResult>;
	cleanup(input: { task: BenchmarkTask; run: ScheduledRun }): Promise<void>;
}

export function createBlindedSchedule(
	manifest: BenchmarkManifest,
	options?: {
		randomInt?: (maximum: number) => number;
		runId?: () => string;
		commitmentNonce?: () => string;
	},
): {
	schemaVersion: 1;
	corpusDigest: string;
	scheduleDigest: string;
	unblindingCommitment: string;
	runs: ScheduledRun[];
	unblinding: Record<string, string>;
	commitmentNonce: string;
};

export function executeBenchmark(options: {
	manifest: BenchmarkManifest;
	outputDirectory: string;
	controlDirectory: string;
	confirmation: string;
	runtime: BenchmarkRuntime;
	randomInt?: (maximum: number) => number;
	runId?: () => string;
}): Promise<{
	runCount: number;
	schedulePath: string;
	unblindingPath: string;
	resultsPath: string;
	lockPath: string;
	metricsPath: string;
}>;
