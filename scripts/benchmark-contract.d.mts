export const BENCHMARK_CONFIRMATION: string;
export const ARMS: string[];
export const STUDY_TARGETS: Readonly<BenchmarkManifest["targets"]>;
export const RESULT_OUTCOMES: BenchmarkOutcome[];
export const FROZEN_BENCHMARK_PROTOCOL: BenchmarkProtocol;
export function canonicalJson(value: unknown): string;
export function canonicalDigest(value: unknown): string;
export type BenchmarkOutcome = "passed" | "failed" | "timeout" | "invalid";
export interface BenchmarkTask {
	id: string;
	repository: string;
	revision: string;
	sourceDigest: string;
	prompt: string;
	testCommand: string;
	timeoutSeconds: number;
	workerImage: string;
	evaluatorImage: string;
	environmentDigest: string;
	validation: {
		goldPatchPassed: boolean;
		baselineReviewed: boolean;
		promptReviewed: boolean;
		environmentReproduced: boolean;
	};
}
export interface BenchmarkManifest {
	schemaVersion: 2;
	protocol: BenchmarkProtocol;
	analysisFrozen: boolean;
	corpusFrozen: boolean;
	repetitions: number;
	arms: string[];
	targets: {
		maxPassRateGapFromSolPoints: number;
		minCostOrTimeImprovementPercent: number;
		minPassRateLeadOverLunaPoints: number;
		maxNonWinningMetricRegressionPercent: number;
		maxLookupAttemptRateGapFromSolPoints: number;
	};
	tasks: BenchmarkTask[];
}
export interface BenchmarkProtocol {
	piVersion: string;
	conversionVersion: string;
	promptDigests: { plan: string; continue: string; checklist: string };
	activeTools: string[];
	arms: Record<
		string,
		{
			selectedModel: string;
			thinking: string;
			prewalk: boolean;
			executorThinking?: string;
		}
	>;
	retryPolicy: { autoRetry: boolean };
	cachePolicy: { forceCachedWebSockets: boolean };
	sandbox: {
		network: string;
		readOnlyRoot: boolean;
		user: string;
		capabilities: string[];
		pids: number;
		memoryBytes: number;
		cpus: number;
		workspaceBytes: number;
	};
	analysis: {
		unit: string;
		method: string;
		confidenceLevel: number;
		bootstrapSamples: number;
		bootstrapSeed: string;
	};
}
export interface BenchmarkResult {
	taskId: string;
	repetition: number;
	arm: string;
	outcome: BenchmarkOutcome;
	cost: number;
	elapsedMs: number;
	lookupAttempts: number;
}
export interface BenchmarkOptions {
	confirmation?: string;
	manifestPath?: string;
	repetitions?: number;
	authFile?: string;
	piExecutable?: string;
	outputDirectory?: string;
	controlDirectory?: string;
}
export function parseBenchmarkArgs(argv: string[]): BenchmarkOptions;
export function validateBenchmarkOptions(options: BenchmarkOptions): BenchmarkOptions;
export function corpusDigest(manifest: BenchmarkManifest): string;
export function taskEnvironmentDigest(
	task: Omit<BenchmarkTask, "environmentDigest"> | BenchmarkTask,
): string;
export function benchmarkMetricsFor(
	rows: Array<{
		outcome: BenchmarkOutcome;
		cost: number;
		elapsedMs: number;
		lookupAttempts: number;
	}>,
): {
	passRate: number;
	outcomes: Record<BenchmarkOutcome, number>;
	medianCost: number;
	medianElapsedMs: number;
	lookupAttemptRate: number;
};
export function validateManifest(manifest: BenchmarkManifest): BenchmarkManifest;
export function evaluateStudyMetrics(
	metrics: Record<
		"sol" | "luna" | "prewalk",
		{
			passRate: number;
			medianCost: number;
			medianElapsedMs: number;
			lookupAttemptRate: number;
		}
	>,
): {
	improvements: {
		costImprovement: number;
		timeImprovement: number;
		otherRegression: number;
	};
	targetsMet: {
		solQuality: boolean;
		costOrTime: boolean;
		lunaQuality: boolean;
		otherMetric: boolean;
		lookup: boolean;
	};
	allTargetsMet: boolean;
	directionalOnly: true;
};
export function evaluateResults(
	manifest: BenchmarkManifest,
	results: BenchmarkResult[],
): {
	schemaVersion: 2;
	corpusDigest: string;
	runCount: number;
	metrics: Record<
		string,
		{
			passRate: number;
			outcomes: Record<BenchmarkOutcome, number>;
			medianCost: number;
			medianElapsedMs: number;
			lookupAttemptRate: number;
		}
	>;
	improvements: {
		costImprovement: number;
		timeImprovement: number;
		otherRegression: number;
	};
	targetsMet: {
		solQuality: boolean;
		costOrTime: boolean;
		lunaQuality: boolean;
		otherMetric: boolean;
		lookup: boolean;
	};
	allTargetsMet: boolean;
	directionalOnly: true;
};
