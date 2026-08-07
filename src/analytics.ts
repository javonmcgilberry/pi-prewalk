import { createHash } from "node:crypto";
import { isRecord } from "./guards.js";

export const ANALYTICS_SCHEMA_VERSION = 1;
export const DEFAULT_RECENT_RECEIPT_COUNT = 10;

export interface AnalyticsConfig {
	enabled: boolean;
	catalogFallbackEnabled: boolean;
	recentReceiptCount: number;
	schemaVersion: number;
}

export const DEFAULT_ANALYTICS_CONFIG: AnalyticsConfig = {
	enabled: true,
	catalogFallbackEnabled: false,
	recentReceiptCount: DEFAULT_RECENT_RECEIPT_COUNT,
	schemaVersion: ANALYTICS_SCHEMA_VERSION,
};

export type RunOutcome =
	| "active"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "released"
	| "session-ended"
	| "interrupted"
	| "unfinished";
export const RUN_OUTCOMES: readonly RunOutcome[] = [
	"active",
	"succeeded",
	"failed",
	"cancelled",
	"released",
	"session-ended",
	"interrupted",
	"unfinished",
];

export type HandoffState = "not-started" | "pending" | "completed" | "failed";
export const HANDOFF_STATES: readonly HandoffState[] = [
	"not-started",
	"pending",
	"completed",
	"failed",
];

export type UsageRole = "planner-primary" | "executor-primary" | "auxiliary" | "compaction";
export const USAGE_ROLES: readonly UsageRole[] = [
	"planner-primary",
	"executor-primary",
	"auxiliary",
	"compaction",
];

export type PricingSource = "pi-reported-actual" | "model-metadata" | "catalog" | "unavailable";
export const PRICING_SOURCES: readonly PricingSource[] = [
	"pi-reported-actual",
	"model-metadata",
	"catalog",
	"unavailable",
];

export type UnavailabilityReason =
	| "run-not-successful"
	| "pricing-missing"
	| "pricing-incomplete"
	| "pricing-zero"
	| "usage-incomplete"
	| "analytics-disabled"
	| "unfinished-run";
export const UNAVAILABILITY_REASONS: readonly UnavailabilityReason[] = [
	"run-not-successful",
	"pricing-missing",
	"pricing-incomplete",
	"pricing-zero",
	"usage-incomplete",
	"analytics-disabled",
	"unfinished-run",
];

export interface ModelIdentity {
	provider: string;
	model: string;
}

export interface UsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface UsageSlice {
	sequence: number;
	provider: string;
	model: string;
	role: UsageRole;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cacheWrite1hTokens?: number;
	reasoningTokens: number;
	totalTokens: number;
	cost: UsageCost;
}

export interface SessionLineage {
	rootSessionId: string;
	parentSessionId?: string;
	delegationRunId?: string;
	childIndex?: number;
}

export type DelegationLifecycle =
	| "running"
	| "completed"
	| "failed"
	| "interrupted"
	| "timed-out"
	| "stopped"
	| "incomplete";

export interface DelegationUsageSlice {
	evidenceKey: string;
	category: "child";
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	totalTokens: number;
	turns: number;
	costUsd: number;
	tokenCoverage: "complete" | "partial";
}

export interface DelegationEvidence {
	schemaVersion: number;
	generation?: string;
	eventId: string;
	phase: "start" | "progress" | "terminal";
	rootSessionId: string;
	parentSessionId: string;
	invocationId: string;
	delegationRunId: string;
	childIndex: number;
	relationship: "direct" | "nested";
	childSessionId?: string;
	lifecycle: DelegationLifecycle;
	observedAt: number;
	usage: DelegationUsageSlice[];
}

export type CoverageState =
	| "complete"
	| "pending"
	| "overlap-unresolved"
	| "unsupported"
	| "incomplete";
export type ActualCostCoverage = CoverageState;
export type EstimateCoverage = CoverageState;
export type TaskTreeUnresolvedReason =
	| "pending"
	| "missing-cost"
	| "partial-token-breakdown"
	| "overlap-unresolved"
	| "unsupported";

export interface TaskTreeUnresolvedDescendant {
	delegationRunId: string;
	childIndex: number;
	childSessionId?: string;
	reason: TaskTreeUnresolvedReason;
}

export interface TaskTreeReport {
	rootSessionId: string;
	rootReceipts: RunReceipt[];
	descendantReceipts: RunReceipt[];
	fallbackEvidence: DelegationEvidence[];
	unresolved: TaskTreeUnresolvedDescendant[];
	rootActualCost: number;
	directChildActualCost: number;
	nestedChildActualCost: number;
	knownTaskTreeActualCost: number;
	reportedChildCount: number;
	expectedChildCount: number;
	estimatedSavings: number;
	estimatedExtraCost: number;
	costCoverage: ActualCostCoverage;
	tokenCoverage: CoverageState;
	estimateCoverage: EstimateCoverage;
}

export interface RunConfigurationSnapshot {
	analytics: AnalyticsConfig;
	planner: ModelIdentity;
	executor: ModelIdentity;
}

export interface RunJournal {
	schemaVersion: number;
	runId: string;
	epoch: string;
	sessionId: string;
	generation: string;
	configuration: RunConfigurationSnapshot;
	startedAt: string;
	lastObservedSequence: number;
	evidenceKeys?: string[];
	lineage?: SessionLineage;
	outcome: RunOutcome;
	handoffState: HandoffState;
	usage: UsageSlice[];
}

export interface ActualPricingEvidence {
	source: "pi-reported-actual";
}

export interface ModelMetadataPricingEvidence {
	source: "model-metadata";
	capturedAt: string;
}

export interface CatalogPricingEvidence {
	source: "catalog";
	catalogDate: string;
}

export interface UnavailablePricingEvidence {
	source: "unavailable";
	reason: UnavailabilityReason;
}

export type PricingEvidence =
	| ActualPricingEvidence
	| ModelMetadataPricingEvidence
	| CatalogPricingEvidence
	| UnavailablePricingEvidence;

export interface SessionCounterfactualEstimate {
	kind: "session-counterfactual";
	plannerOnlyCost: number;
	savings: number;
}

export interface CatalogEstimate {
	kind: "catalog-estimated";
	plannerOnlyCost: number;
	savings: number;
}

export interface UnavailableEstimate {
	kind: "unavailable";
	reason: UnavailabilityReason;
}

export type SavingsEstimate = SessionCounterfactualEstimate | CatalogEstimate | UnavailableEstimate;

export interface RunReceipt {
	schemaVersion: number;
	runId: string;
	epoch: string;
	sessionId: string;
	generation: string;
	startedAt: string;
	completedAt: string | null;
	outcome: RunOutcome;
	handoffState: HandoffState;
	planner: ModelIdentity;
	executor: ModelIdentity;
	usage: UsageSlice[];
	actualCost: number;
	estimate: SavingsEstimate;
	pricingEvidence: PricingEvidence;
	/**
	 * Rates the estimate was priced with. Storing them lets a later Prewalk
	 * recompute an estimate that was refused when the receipt was written, which
	 * is what left earlier released and session-ended runs permanently
	 * uncomparable. Optional so receipts written before this field stay valid.
	 */
	pricing?: ModelPricingPair;
	evidenceKeys?: string[];
	lineage?: SessionLineage;
}

export interface BenchmarkRunCounts {
	solOnly: number;
	lunaOnly: number;
	prewalk: number;
}

export interface BenchmarkComparisons {
	solOnlyCost: number;
	lunaOnlyCost: number;
	prewalkCost: number;
	prewalkVsSolSavings: number;
	prewalkVsLunaSavings: number;
}

export const VERIFIED_BENCHMARK_SCHEMA_VERSION = 1;

export interface VerifiedBenchmarkSummary {
	schemaVersion: typeof VERIFIED_BENCHMARK_SCHEMA_VERSION;
	benchmarkContractVersion: string;
	evidenceFingerprint: string;
	completedAt: string;
	runCounts: BenchmarkRunCounts;
	comparisons: BenchmarkComparisons;
}

export type UsageObservationSource = "assistant" | "tool-result" | "compaction";

export interface ProviderReportedUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: UsageCost;
}

export interface UsageObservation {
	sequence: number;
	evidenceId?: string;
	source: UsageObservationSource;
	provider: string;
	model: string;
	role: UsageRole;
	final: boolean;
	usage: ProviderReportedUsage;
}

export interface ActualCostSummary extends UsageCost {
	plannerPrimary: number;
	executorPrimary: number;
	auxiliary: number;
}

export interface ModelPricingRates {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface ModelPricingTier extends ModelPricingRates {
	inputTokensAbove: number;
}

export interface ModelPricingSchedule extends ModelPricingRates {
	tiers?: ModelPricingTier[];
}

export interface ModelPricingPair {
	planner: ModelPricingSchedule;
	executor: ModelPricingSchedule;
}

export interface SessionPricingInput {
	capturedAt: string;
	rates: ModelPricingPair;
}

export interface CatalogPricingInput {
	catalogDate: string;
	rates: ModelPricingPair;
}

export interface SavingsCalculationInput {
	outcome: RunOutcome;
	handoffState: HandoffState;
	usage: readonly UsageSlice[];
	modelMetadata?: SessionPricingInput;
	catalog?: CatalogPricingInput;
	catalogFallbackEnabled: boolean;
}

export interface SavingsCalculation {
	actualCost: number;
	estimate: SavingsEstimate;
	pricingEvidence: PricingEvidence;
}

export interface ComparisonSummary {
	finishedRuns: number;
	comparedRuns: number;
	noHandoffRuns: number;
	unavailableRuns: number;
	plannerOnlyCost: number;
	actualPrimaryCost: number;
	difference: number;
	/**
	 * Recorded spend of the runs behind `difference`. Reporting this alongside a
	 * period's total recorded spend keeps the difference from being read as a
	 * rate over spend it never covered.
	 */
	comparedActualCost: number;
	/** Recorded spend of every finished run considered, compared or not. */
	finishedActualCost: number;
	unavailableReasons: Partial<Record<UnavailabilityReason, number>>;
}

const TOKENS_PER_MILLION = 1_000_000;

export function normalizeUsageObservations(
	observations: readonly UsageObservation[],
): UsageSlice[] {
	const evidenceKeys = new Set<string>();
	const slices: UsageSlice[] = [];
	const ordered = [...observations].sort(compareUsageObservations);

	for (const observation of ordered) {
		if (!observation.final) continue;
		const evidenceKey = usageEvidenceKey(observation);
		if (evidenceKeys.has(evidenceKey)) continue;
		evidenceKeys.add(evidenceKey);
		slices.push({
			sequence: observation.sequence,
			provider: observation.provider,
			model: observation.model,
			role: observation.role,
			inputTokens: observation.usage.input,
			outputTokens: observation.usage.output,
			cacheReadTokens: observation.usage.cacheRead,
			cacheWriteTokens: observation.usage.cacheWrite,
			...(observation.usage.cacheWrite1h === undefined
				? {}
				: { cacheWrite1hTokens: observation.usage.cacheWrite1h }),
			reasoningTokens: observation.usage.reasoning ?? 0,
			totalTokens: observation.usage.totalTokens,
			cost: { ...observation.usage.cost },
		});
	}

	return slices;
}

export function summarizeActualCost(usage: readonly UsageSlice[]): ActualCostSummary {
	const summary: ActualCostSummary = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		plannerPrimary: 0,
		executorPrimary: 0,
		auxiliary: 0,
	};

	for (const slice of usage) {
		summary.input += slice.cost.input;
		summary.output += slice.cost.output;
		summary.cacheRead += slice.cost.cacheRead;
		summary.cacheWrite += slice.cost.cacheWrite;
		summary.total += slice.cost.total;
		if (slice.role === "planner-primary") summary.plannerPrimary += slice.cost.total;
		else if (slice.role === "executor-primary") summary.executorPrimary += slice.cost.total;
		else summary.auxiliary += slice.cost.total;
	}

	return summary;
}

export function calculateSavings(input: SavingsCalculationInput): SavingsCalculation {
	const actual = summarizeActualCost(input.usage);
	const unavailableReason = outcomeUnavailabilityReason(input.outcome);
	if (unavailableReason !== null) {
		return unavailableCalculation(actual.total, unavailableReason);
	}

	const primaryUsage = input.usage.filter(
		(slice) => slice.role === "planner-primary" || slice.role === "executor-primary",
	);
	const executorUsage = primaryUsage.filter((slice) => slice.role === "executor-primary");
	if (executorUsage.length === 0) {
		if (input.handoffState === "not-started" && input.modelMetadata !== undefined) {
			return {
				actualCost: actual.total,
				estimate: {
					kind: "session-counterfactual",
					plannerOnlyCost: actual.plannerPrimary,
					savings: 0,
				},
				pricingEvidence: {
					source: "model-metadata",
					capturedAt: input.modelMetadata.capturedAt,
				},
			};
		}
		return unavailableCalculation(actual.total, "usage-incomplete");
	}

	const sessionFailure = pricingFailure(input.modelMetadata?.rates, executorUsage);
	if (sessionFailure === null && input.modelMetadata !== undefined) {
		return pricedCalculation(
			actual,
			executorUsage,
			input.modelMetadata.rates.planner,
			"session-counterfactual",
			{ source: "model-metadata", capturedAt: input.modelMetadata.capturedAt },
		);
	}

	if (input.catalogFallbackEnabled && input.catalog !== undefined) {
		const catalogFailure = pricingFailure(input.catalog.rates, executorUsage);
		if (catalogFailure === null) {
			return pricedCalculation(
				actual,
				executorUsage,
				input.catalog.rates.planner,
				"catalog-estimated",
				{ source: "catalog", catalogDate: input.catalog.catalogDate },
			);
		}
		return unavailableCalculation(actual.total, catalogFailure);
	}

	return unavailableCalculation(actual.total, sessionFailure ?? "pricing-missing");
}

/**
 * Makes receipts written before planning-only runs were comparable behave like
 * new receipts without rewriting the local ledger.
 */
export function comparisonEstimate(receipt: RunReceipt): SavingsEstimate {
	if (
		isPlanningOnlyReceipt(receipt) &&
		receipt.estimate.kind === "unavailable" &&
		receipt.estimate.reason === "usage-incomplete"
	) {
		return {
			kind: "session-counterfactual",
			plannerOnlyCost: summarizeActualCost(receipt.usage).plannerPrimary,
			savings: 0,
		};
	}
	// A receipt that recorded its rates can be repriced when the run has since
	// become comparable, so a rule change no longer strands finished handoffs.
	if (
		receipt.estimate.kind === "unavailable" &&
		receipt.pricing !== undefined &&
		outcomeUnavailabilityReason(receipt.outcome) === null
	) {
		const executorUsage = receipt.usage.filter((slice) => slice.role === "executor-primary");
		if (executorUsage.length > 0 && pricingFailure(receipt.pricing, executorUsage) === null) {
			return pricedCalculation(
				summarizeActualCost(receipt.usage),
				executorUsage,
				receipt.pricing.planner,
				"session-counterfactual",
				{ source: "model-metadata", capturedAt: receipt.startedAt },
			).estimate;
		}
	}
	return receipt.estimate;
}

export function isPlanningOnlyReceipt(receipt: RunReceipt): boolean {
	return (
		isComparisonFinished(receipt) &&
		receipt.handoffState === "not-started" &&
		!receipt.usage.some((slice) => slice.role === "executor-primary")
	);
}

export function summarizeComparisons(receipts: readonly RunReceipt[]): ComparisonSummary {
	const finished = receipts.filter(isComparisonFinished);
	const noHandoffRuns = finished.filter(isPlanningOnlyReceipt);
	const candidates = finished.filter((receipt) => !isPlanningOnlyReceipt(receipt));
	const evaluations = candidates.map((receipt) => ({
		receipt,
		estimate: comparisonEstimate(receipt),
	}));
	const comparable = evaluations.filter(({ estimate }) => estimate.kind !== "unavailable");
	const unavailable = evaluations.filter(({ estimate }) => estimate.kind === "unavailable");
	const unavailableReasons: Partial<Record<UnavailabilityReason, number>> = {};
	for (const { estimate } of unavailable) {
		if (estimate.kind === "unavailable") {
			unavailableReasons[estimate.reason] = (unavailableReasons[estimate.reason] ?? 0) + 1;
		}
	}
	let plannerOnlyCost = 0;
	let difference = 0;
	let comparedActualCost = 0;
	for (const { receipt, estimate } of comparable) {
		if (estimate.kind === "unavailable") continue;
		plannerOnlyCost += estimate.plannerOnlyCost;
		difference += estimate.savings;
		comparedActualCost += receipt.actualCost;
	}
	return {
		finishedRuns: finished.length,
		comparedRuns: comparable.length,
		noHandoffRuns: noHandoffRuns.length,
		unavailableRuns: unavailable.length,
		plannerOnlyCost,
		actualPrimaryCost: plannerOnlyCost - difference,
		difference,
		comparedActualCost,
		finishedActualCost: finished.reduce((total, receipt) => total + receipt.actualCost, 0),
		unavailableReasons,
	};
}

function isComparisonFinished(receipt: RunReceipt): boolean {
	return (
		receipt.outcome === "succeeded" ||
		receipt.outcome === "released" ||
		receipt.outcome === "session-ended" ||
		receipt.outcome === "interrupted"
	);
}

function compareUsageObservations(left: UsageObservation, right: UsageObservation): number {
	const sequenceDifference = left.sequence - right.sequence;
	if (sequenceDifference !== 0) return sequenceDifference;
	return usageSourcePriority(left.source) - usageSourcePriority(right.source);
}

function usageSourcePriority(source: UsageObservationSource): number {
	if (source === "assistant") return 0;
	if (source === "tool-result") return 1;
	return 2;
}

export function usageEvidenceKey(observation: UsageObservation): string {
	const usage = observation.usage;
	const evidence = JSON.stringify([
		observation.evidenceId ?? `sequence:${observation.sequence}`,
		observation.provider,
		observation.model,
		observation.role,
		usage.input,
		usage.output,
		usage.cacheRead,
		usage.cacheWrite,
		usage.cacheWrite1h ?? 0,
		usage.reasoning ?? 0,
		usage.totalTokens,
		usage.cost.input,
		usage.cost.output,
		usage.cost.cacheRead,
		usage.cost.cacheWrite,
		usage.cost.total,
	]);
	return createHash("sha256").update(evidence).digest("hex");
}

/**
 * Comparability follows the recorded evidence rather than how the run ended. An
 * interrupted run still executed real executor work at recorded prices, so it
 * can be priced against the planner; `calculateSavings` separately refuses any
 * run that has no executor usage.
 */
function outcomeUnavailabilityReason(outcome: RunOutcome): UnavailabilityReason | null {
	if (
		outcome === "succeeded" ||
		outcome === "released" ||
		outcome === "session-ended" ||
		outcome === "interrupted"
	)
		return null;
	if (outcome === "unfinished" || outcome === "active") return "unfinished-run";
	return "run-not-successful";
}

function unavailableCalculation(
	actualCost: number,
	reason: UnavailabilityReason,
): SavingsCalculation {
	return {
		actualCost,
		estimate: { kind: "unavailable", reason },
		pricingEvidence: { source: "unavailable", reason },
	};
}

function pricedCalculation(
	actual: ActualCostSummary,
	executorUsage: readonly UsageSlice[],
	plannerRates: ModelPricingSchedule,
	kind: "session-counterfactual" | "catalog-estimated",
	pricingEvidence: ModelMetadataPricingEvidence | CatalogPricingEvidence,
): SavingsCalculation {
	let repricedExecutorCost = 0;
	for (const request of executorUsage) {
		repricedExecutorCost += priceUsage(request, selectPricingRates(plannerRates, request));
	}
	const plannerOnlyCost = actual.plannerPrimary + repricedExecutorCost;
	const primaryActualCost = actual.plannerPrimary + actual.executorPrimary;
	return {
		actualCost: actual.total,
		estimate: { kind, plannerOnlyCost, savings: plannerOnlyCost - primaryActualCost },
		pricingEvidence,
	};
}

function pricingFailure(
	pair: ModelPricingPair | undefined,
	usageToPrice: readonly UsageSlice[],
): UnavailabilityReason | null {
	if (pair === undefined) return "pricing-missing";
	for (const request of usageToPrice) {
		const usedCategories = usedTokenCategories([request]);
		const plannerFailure = ratesFailure(
			selectPricingRates(pair.planner, request),
			usedCategories,
		);
		if (plannerFailure !== null) return plannerFailure;
		const executorFailure = ratesFailure(
			selectPricingRates(pair.executor, request),
			usedCategories,
		);
		if (executorFailure !== null) return executorFailure;
	}
	return null;
}

interface UsedTokenCategories {
	input: boolean;
	output: boolean;
	cacheRead: boolean;
	cacheWrite: boolean;
	cacheWrite1h: boolean;
}

function usedTokenCategories(usage: readonly UsageSlice[]): UsedTokenCategories {
	return {
		input: usage.some((slice) => slice.inputTokens > 0),
		output: usage.some((slice) => slice.outputTokens > 0),
		cacheRead: usage.some((slice) => slice.cacheReadTokens > 0),
		cacheWrite: usage.some((slice) => slice.cacheWriteTokens > 0),
		cacheWrite1h: usage.some((slice) => (slice.cacheWrite1hTokens ?? 0) > 0),
	};
}

function ratesFailure(
	rates: ModelPricingRates,
	used: UsedTokenCategories,
): UnavailabilityReason | null {
	const values = [
		used.input ? rates.input : 1,
		used.output ? rates.output : 1,
		used.cacheRead ? rates.cacheRead : 1,
		used.cacheWrite ? rates.cacheWrite : 1,
		used.cacheWrite1h ? rates.input : 1,
	];
	if (values.some((value) => value === undefined || !Number.isFinite(value))) {
		return "pricing-incomplete";
	}
	if (values.some((value) => value !== undefined && value <= 0)) return "pricing-zero";
	return null;
}

function selectPricingRates(schedule: ModelPricingSchedule, usage: UsageSlice): ModelPricingRates {
	const requestInputTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
	let selected: ModelPricingRates = schedule;
	let selectedThreshold = -1;
	for (const tier of schedule.tiers ?? []) {
		if (requestInputTokens > tier.inputTokensAbove && tier.inputTokensAbove > selectedThreshold) {
			selected = tier;
			selectedThreshold = tier.inputTokensAbove;
		}
	}
	return selected;
}

function priceUsage(usage: UsageSlice, rates: ModelPricingRates): number {
	return (
		(usage.inputTokens * (rates.input ?? 0) +
			usage.outputTokens * (rates.output ?? 0) +
			usage.cacheReadTokens * (rates.cacheRead ?? 0) +
			(usage.cacheWriteTokens - (usage.cacheWrite1hTokens ?? 0)) * (rates.cacheWrite ?? 0) +
			(usage.cacheWrite1hTokens ?? 0) * (rates.input ?? 0) * 2) /
		TOKENS_PER_MILLION
	);
}

const ANALYTICS_CONFIG_KEYS = new Set([
	"enabled",
	"catalogFallbackEnabled",
	"recentReceiptCount",
	"schemaVersion",
]);
const JOURNAL_KEYS = new Set([
	"schemaVersion",
	"runId",
	"epoch",
	"sessionId",
	"generation",
	"configuration",
	"startedAt",
	"lastObservedSequence",
	"evidenceKeys",
	"lineage",
	"outcome",
	"handoffState",
	"usage",
]);
const RECEIPT_KEYS = new Set([
	"schemaVersion",
	"runId",
	"epoch",
	"sessionId",
	"generation",
	"startedAt",
	"completedAt",
	"outcome",
	"handoffState",
	"planner",
	"executor",
	"usage",
	"actualCost",
	"estimate",
	"pricingEvidence",
	"pricing",
	"evidenceKeys",
	"lineage",
]);
const PRICING_PAIR_KEYS = new Set(["planner", "executor"]);
const PRICING_RATE_KEYS = new Set(["input", "output", "cacheRead", "cacheWrite"]);
const PRICING_SCHEDULE_KEYS = new Set([...PRICING_RATE_KEYS, "tiers"]);
const PRICING_TIER_KEYS = new Set([...PRICING_RATE_KEYS, "inputTokensAbove"]);
const CONFIGURATION_KEYS = new Set(["analytics", "planner", "executor"]);
const SESSION_LINEAGE_KEYS = new Set([
	"rootSessionId",
	"parentSessionId",
	"delegationRunId",
	"childIndex",
]);
const MODEL_KEYS = new Set(["provider", "model"]);
const USAGE_KEYS = new Set([
	"sequence",
	"provider",
	"model",
	"role",
	"inputTokens",
	"outputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"cacheWrite1hTokens",
	"reasoningTokens",
	"totalTokens",
	"cost",
]);
const COST_KEYS = new Set(["input", "output", "cacheRead", "cacheWrite", "total"]);

const VERIFIED_BENCHMARK_KEYS = new Set([
	"schemaVersion",
	"benchmarkContractVersion",
	"evidenceFingerprint",
	"completedAt",
	"runCounts",
	"comparisons",
]);
const BENCHMARK_RUN_COUNT_KEYS = new Set(["solOnly", "lunaOnly", "prewalk"]);
const BENCHMARK_COMPARISON_KEYS = new Set([
	"solOnlyCost",
	"lunaOnlyCost",
	"prewalkCost",
	"prewalkVsSolSavings",
	"prewalkVsLunaSavings",
]);

export function parseVerifiedBenchmarkSummary(value: unknown): VerifiedBenchmarkSummary {
	const record = requireRecord(value, "Verified benchmark summary");
	rejectUnknownKeys(record, VERIFIED_BENCHMARK_KEYS, "verified benchmark summary");
	if (record.schemaVersion !== VERIFIED_BENCHMARK_SCHEMA_VERSION) {
		throw new Error("Verified benchmark summary schema version is unsupported.");
	}
	const benchmarkContractVersion = requireNonEmptyString(
		record.benchmarkContractVersion,
		"Verified benchmark summary benchmarkContractVersion",
	);
	const evidenceFingerprint = requireSafeIdentifier(
		record.evidenceFingerprint,
		"Verified benchmark summary evidenceFingerprint",
	);
	const completedAt = requireTimestamp(
		record.completedAt,
		"Verified benchmark summary completedAt",
	);
	const runCountsRecord = requireRecord(record.runCounts, "Verified benchmark summary runCounts");
	rejectUnknownKeys(runCountsRecord, BENCHMARK_RUN_COUNT_KEYS, "verified benchmark runCounts");
	const runCounts = {
		solOnly: requireNonNegativeInteger(
			runCountsRecord.solOnly,
			"Verified benchmark solOnly count",
		),
		lunaOnly: requireNonNegativeInteger(
			runCountsRecord.lunaOnly,
			"Verified benchmark lunaOnly count",
		),
		prewalk: requireNonNegativeInteger(
			runCountsRecord.prewalk,
			"Verified benchmark prewalk count",
		),
	};
	const comparisonsRecord = requireRecord(
		record.comparisons,
		"Verified benchmark summary comparisons",
	);
	rejectUnknownKeys(
		comparisonsRecord,
		BENCHMARK_COMPARISON_KEYS,
		"verified benchmark comparisons",
	);
	const comparisons = {
		solOnlyCost: requireNonNegativeNumber(
			comparisonsRecord.solOnlyCost,
			"Verified benchmark solOnlyCost",
		),
		lunaOnlyCost: requireNonNegativeNumber(
			comparisonsRecord.lunaOnlyCost,
			"Verified benchmark lunaOnlyCost",
		),
		prewalkCost: requireNonNegativeNumber(
			comparisonsRecord.prewalkCost,
			"Verified benchmark prewalkCost",
		),
		prewalkVsSolSavings: requireFiniteNumber(
			comparisonsRecord.prewalkVsSolSavings,
			"Verified benchmark prewalkVsSolSavings",
		),
		prewalkVsLunaSavings: requireFiniteNumber(
			comparisonsRecord.prewalkVsLunaSavings,
			"Verified benchmark prewalkVsLunaSavings",
		),
	};
	return {
		schemaVersion: VERIFIED_BENCHMARK_SCHEMA_VERSION,
		benchmarkContractVersion,
		evidenceFingerprint,
		completedAt,
		runCounts,
		comparisons,
	};
}

export function serializeVerifiedBenchmarkSummary(value: unknown): string {
	return JSON.stringify(parseVerifiedBenchmarkSummary(value));
}

export function deserializeVerifiedBenchmarkSummary(value: string): VerifiedBenchmarkSummary {
	return parseVerifiedBenchmarkSummary(parseJson(value, "verified benchmark summary"));
}

export function parseAnalyticsConfig(value: unknown): AnalyticsConfig {
	const record = requireRecord(value, "Analytics config");
	rejectUnknownKeys(record, ANALYTICS_CONFIG_KEYS, "analytics config");
	const schemaVersion = requireSchemaVersion(record.schemaVersion, "Analytics config");
	if (typeof record.enabled !== "boolean") {
		throw new Error("Analytics config enabled must be boolean.");
	}
	if (typeof record.catalogFallbackEnabled !== "boolean") {
		throw new Error("Analytics config catalogFallbackEnabled must be boolean.");
	}
	const recentReceiptCount = requireNonNegativeInteger(
		record.recentReceiptCount,
		"Analytics config recentReceiptCount",
	);
	if (recentReceiptCount === 0) {
		throw new Error("Analytics config recentReceiptCount must be greater than zero.");
	}
	return {
		enabled: record.enabled,
		catalogFallbackEnabled: record.catalogFallbackEnabled,
		recentReceiptCount,
		schemaVersion,
	};
}

export function parseRunJournal(value: unknown): RunJournal {
	const record = requireRecord(value, "Analytics journal");
	rejectUnknownKeys(record, JOURNAL_KEYS, "analytics journal");
	return {
		schemaVersion: requireSchemaVersion(record.schemaVersion, "Analytics journal"),
		runId: requireSafeIdentifier(record.runId, "Analytics journal runId"),
		epoch: requireSafeIdentifier(record.epoch, "Analytics journal epoch"),
		sessionId: requireSafeIdentifier(record.sessionId, "Analytics journal sessionId"),
		generation: requireSafeIdentifier(record.generation, "Analytics journal generation"),
		configuration: parseRunConfiguration(record.configuration),
		startedAt: requireTimestamp(record.startedAt, "Analytics journal startedAt"),
		lastObservedSequence: requireNonNegativeInteger(
			record.lastObservedSequence,
			"Analytics journal lastObservedSequence",
		),
		...(record.evidenceKeys === undefined
			? {}
			: { evidenceKeys: parseEvidenceKeys(record.evidenceKeys) }),
		...(record.lineage === undefined ? {} : { lineage: parseSessionLineage(record.lineage) }),
		outcome: requireRunOutcome(record.outcome, "Analytics journal outcome"),
		handoffState: requireHandoffState(record.handoffState, "Analytics journal handoffState"),
		usage: parseUsage(record.usage, "Analytics journal usage"),
	};
}

export function parseRunReceipt(value: unknown): RunReceipt {
	const record = requireRecord(value, "Analytics receipt");
	rejectUnknownKeys(record, RECEIPT_KEYS, "analytics receipt");
	const receipt = normalizeLegacyReceipt({
		schemaVersion: requireSchemaVersion(record.schemaVersion, "Analytics receipt"),
		runId: requireSafeIdentifier(record.runId, "Analytics receipt runId"),
		epoch: requireSafeIdentifier(record.epoch, "Analytics receipt epoch"),
		sessionId: requireSafeIdentifier(record.sessionId, "Analytics receipt sessionId"),
		generation: requireSafeIdentifier(record.generation, "Analytics receipt generation"),
		startedAt: requireTimestamp(record.startedAt, "Analytics receipt startedAt"),
		completedAt: requireNullableTimestamp(record.completedAt, "Analytics receipt completedAt"),
		outcome: requireRunOutcome(record.outcome, "Analytics receipt outcome"),
		handoffState: requireHandoffState(record.handoffState, "Analytics receipt handoffState"),
		planner: parseModelIdentity(record.planner, "Analytics receipt planner"),
		executor: parseModelIdentity(record.executor, "Analytics receipt executor"),
		usage: parseUsage(record.usage, "Analytics receipt usage"),
		actualCost: requireNonNegativeNumber(record.actualCost, "Analytics receipt actualCost"),
		estimate: parseSavingsEstimate(record.estimate),
		pricingEvidence: parsePricingEvidence(record.pricingEvidence),
		...(record.pricing === undefined ? {} : { pricing: parseModelPricingPair(record.pricing) }),
		...(record.evidenceKeys === undefined
			? {}
			: { evidenceKeys: parseReceiptEvidenceKeys(record.evidenceKeys) }),
		...(record.lineage === undefined ? {} : { lineage: parseSessionLineage(record.lineage) }),
	});
	validateReceiptFinancials(receipt);
	return receipt;
}

export function serializeRunJournal(value: unknown): string {
	return JSON.stringify(parseRunJournal(value));
}

export function serializeRunReceipt(value: unknown): string {
	return JSON.stringify(parseRunReceipt(value));
}

export function deserializeRunJournal(value: string): RunJournal {
	return parseRunJournal(parseJson(value, "analytics journal"));
}

export function deserializeRunReceipt(value: string): RunReceipt {
	return parseRunReceipt(parseJson(value, "analytics receipt"));
}

/**
 * Preserves receipts written before released, session-ended, and interrupted
 * became comparable outcomes. Their stored reason still says the run was not
 * successful, which no longer reconciles with the outcome, so it is restated as
 * missing pricing: these receipts recorded no rates and cannot be repriced.
 */
function normalizeLegacyReceipt(receipt: RunReceipt): RunReceipt {
	if (
		(receipt.outcome === "released" ||
			receipt.outcome === "session-ended" ||
			receipt.outcome === "interrupted") &&
		receipt.estimate.kind === "unavailable" &&
		receipt.estimate.reason === "run-not-successful" &&
		receipt.pricingEvidence.source === "unavailable" &&
		receipt.pricingEvidence.reason === "run-not-successful"
	) {
		return {
			...receipt,
			estimate: { kind: "unavailable", reason: "pricing-missing" },
			pricingEvidence: { source: "unavailable", reason: "pricing-missing" },
		};
	}
	return receipt;
}

function parseRunConfiguration(value: unknown): RunConfigurationSnapshot {
	const record = requireRecord(value, "Analytics run configuration");
	rejectUnknownKeys(record, CONFIGURATION_KEYS, "analytics run configuration");
	return {
		analytics: parseAnalyticsConfig(record.analytics),
		planner: parseModelIdentity(record.planner, "Analytics run configuration planner"),
		executor: parseModelIdentity(record.executor, "Analytics run configuration executor"),
	};
}

function parseModelIdentity(value: unknown, name: string): ModelIdentity {
	const record = requireRecord(value, name);
	rejectUnknownKeys(record, MODEL_KEYS, name.toLowerCase());
	return {
		provider: requireNonEmptyString(record.provider, `${name} provider`),
		model: requireNonEmptyString(record.model, `${name} model`),
	};
}

function parseEvidenceKeys(value: unknown): string[] {
	return parseUniqueEvidenceKeys(value, "Analytics journal");
}

function parseReceiptEvidenceKeys(value: unknown): string[] {
	return parseUniqueEvidenceKeys(value, "Analytics receipt");
}

function parseUniqueEvidenceKeys(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${label} evidenceKeys must be an array.`);
	const keys = value.map((item, index) =>
		requireSafeIdentifier(item, `${label} evidenceKeys[${index}]`),
	);
	if (new Set(keys).size !== keys.length) {
		throw new Error(`${label} evidenceKeys must not contain duplicates.`);
	}
	return keys;
}

function parseSessionLineage(value: unknown): SessionLineage {
	const record = requireRecord(value, "Analytics receipt lineage");
	rejectUnknownKeys(record, SESSION_LINEAGE_KEYS, "analytics receipt lineage");
	return {
		rootSessionId: requireSafeIdentifier(
			record.rootSessionId,
			"Analytics receipt lineage rootSessionId",
		),
		...(record.parentSessionId === undefined
			? {}
			: {
					parentSessionId: requireSafeIdentifier(
						record.parentSessionId,
						"Analytics receipt lineage parentSessionId",
					),
				}),
		...(record.delegationRunId === undefined
			? {}
			: {
					delegationRunId: requireSafeIdentifier(
						record.delegationRunId,
						"Analytics receipt lineage delegationRunId",
					),
				}),
		...(record.childIndex === undefined
			? {}
			: {
					childIndex: requireNonNegativeInteger(
						record.childIndex,
						"Analytics receipt lineage childIndex",
					),
				}),
	};
}

function parseUsage(value: unknown, name: string): UsageSlice[] {
	if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
	return value.map((item, index) => parseUsageSlice(item, `${name}[${index}]`));
}

function parseUsageSlice(value: unknown, name: string): UsageSlice {
	const record = requireRecord(value, name);
	rejectUnknownKeys(record, USAGE_KEYS, name.toLowerCase());
	const cacheWriteTokens = requireNonNegativeInteger(
		record.cacheWriteTokens,
		`${name} cacheWriteTokens`,
	);
	const cacheWrite1hTokens =
		record.cacheWrite1hTokens === undefined
			? undefined
			: requireNonNegativeInteger(record.cacheWrite1hTokens, `${name} cacheWrite1hTokens`);
	if (cacheWrite1hTokens !== undefined && cacheWrite1hTokens > cacheWriteTokens) {
		throw new Error(`${name} cacheWrite1hTokens cannot exceed cacheWriteTokens.`);
	}
	return {
		sequence: requireNonNegativeInteger(record.sequence, `${name} sequence`),
		provider: requireNonEmptyString(record.provider, `${name} provider`),
		model: requireNonEmptyString(record.model, `${name} model`),
		role: requireUsageRole(record.role, `${name} role`),
		inputTokens: requireNonNegativeInteger(record.inputTokens, `${name} inputTokens`),
		outputTokens: requireNonNegativeInteger(record.outputTokens, `${name} outputTokens`),
		cacheReadTokens: requireNonNegativeInteger(record.cacheReadTokens, `${name} cacheReadTokens`),
		cacheWriteTokens,
		...(cacheWrite1hTokens === undefined ? {} : { cacheWrite1hTokens }),
		reasoningTokens: requireNonNegativeInteger(record.reasoningTokens, `${name} reasoningTokens`),
		totalTokens: requireNonNegativeInteger(record.totalTokens, `${name} totalTokens`),
		cost: parseUsageCost(record.cost, `${name} cost`),
	};
}

function parseUsageCost(value: unknown, name: string): UsageCost {
	const record = requireRecord(value, name);
	rejectUnknownKeys(record, COST_KEYS, name.toLowerCase());
	const cost = {
		input: requireNonNegativeNumber(record.input, `${name} input`),
		output: requireNonNegativeNumber(record.output, `${name} output`),
		cacheRead: requireNonNegativeNumber(record.cacheRead, `${name} cacheRead`),
		cacheWrite: requireNonNegativeNumber(record.cacheWrite, `${name} cacheWrite`),
		total: requireNonNegativeNumber(record.total, `${name} total`),
	};
	const categorizedTotal = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
	if (!financiallyEqual(cost.total, categorizedTotal)) {
		throw new Error(`${name} total does not reconcile with categorized costs.`);
	}
	return cost;
}

function validateReceiptFinancials(receipt: RunReceipt): void {
	const actual = summarizeActualCost(receipt.usage);
	if (!financiallyEqual(receipt.actualCost, actual.total)) {
		throw new Error("Analytics receipt actualCost does not reconcile with usage costs.");
	}

	if (receipt.estimate.kind === "unavailable") {
		if (
			receipt.pricingEvidence.source !== "unavailable" ||
			receipt.pricingEvidence.reason !== receipt.estimate.reason
		) {
			throw new Error(
				"Analytics receipt unavailable estimate does not reconcile with pricing evidence.",
			);
		}
		const expectedReason = outcomeUnavailabilityReason(receipt.outcome);
		if (expectedReason !== null && receipt.estimate.reason !== expectedReason) {
			throw new Error(
				"Analytics receipt unavailable reason does not reconcile with its outcome.",
			);
		}
		if (
			isComparisonFinished(receipt) &&
			(receipt.estimate.reason === "run-not-successful" ||
				receipt.estimate.reason === "unfinished-run")
		) {
			throw new Error(
				"Analytics receipt unavailable reason does not reconcile with its outcome.",
			);
		}
		return;
	}

	if (!isComparisonFinished(receipt)) {
		throw new Error("Analytics receipt unsuccessful outcome cannot contain an estimate.");
	}
	const hasExecutorUsage = receipt.usage.some((slice) => slice.role === "executor-primary");
	if (!hasExecutorUsage) {
		if (!isPlanningOnlyReceipt(receipt)) {
			throw new Error("Analytics receipt estimate requires executor usage after handoff.");
		}
		if (
			receipt.estimate.plannerOnlyCost !== actual.plannerPrimary ||
			receipt.estimate.savings !== 0
		) {
			throw new Error(
				"Analytics planning-only estimate must match planner spend with no savings.",
			);
		}
	}
	if (
		(receipt.estimate.kind === "session-counterfactual" &&
			receipt.pricingEvidence.source !== "model-metadata") ||
		(receipt.estimate.kind === "catalog-estimated" &&
			receipt.pricingEvidence.source !== "catalog")
	) {
		throw new Error("Analytics receipt estimate kind does not reconcile with pricing evidence.");
	}
	const primaryActualCost = actual.plannerPrimary + actual.executorPrimary;
	const expectedSavings = receipt.estimate.plannerOnlyCost - primaryActualCost;
	if (!financiallyEqual(receipt.estimate.savings, expectedSavings)) {
		throw new Error("Analytics receipt savings does not reconcile with its usage and estimate.");
	}
}

function financiallyEqual(left: number, right: number): boolean {
	const scale = Math.max(1, Math.abs(left), Math.abs(right));
	return Math.abs(left - right) <= Number.EPSILON * 16 * scale;
}

function parseSavingsEstimate(value: unknown): SavingsEstimate {
	const record = requireRecord(value, "Analytics receipt estimate");
	if (record.kind === "unavailable") {
		rejectUnknownKeys(record, new Set(["kind", "reason"]), "analytics receipt estimate");
		return {
			kind: "unavailable",
			reason: requireUnavailabilityReason(record.reason, "Analytics receipt estimate reason"),
		};
	}
	if (record.kind === "session-counterfactual" || record.kind === "catalog-estimated") {
		rejectUnknownKeys(
			record,
			new Set(["kind", "plannerOnlyCost", "savings"]),
			"analytics receipt estimate",
		);
		const plannerOnlyCost = requireNonNegativeNumber(
			record.plannerOnlyCost,
			"Analytics receipt estimate plannerOnlyCost",
		);
		const savings = requireFiniteNumber(record.savings, "Analytics receipt estimate savings");
		if (record.kind === "session-counterfactual") {
			return { kind: "session-counterfactual", plannerOnlyCost, savings };
		}
		return { kind: "catalog-estimated", plannerOnlyCost, savings };
	}
	throw new Error("Analytics receipt estimate kind is invalid.");
}

function parseModelPricingPair(value: unknown): ModelPricingPair {
	const record = requireRecord(value, "Analytics receipt pricing");
	rejectUnknownKeys(record, PRICING_PAIR_KEYS, "analytics receipt pricing");
	return {
		planner: parseModelPricingSchedule(record.planner, "Analytics receipt pricing planner"),
		executor: parseModelPricingSchedule(record.executor, "Analytics receipt pricing executor"),
	};
}

function parseModelPricingSchedule(value: unknown, name: string): ModelPricingSchedule {
	const record = requireRecord(value, name);
	rejectUnknownKeys(record, PRICING_SCHEDULE_KEYS, name);
	if (record.tiers !== undefined && !Array.isArray(record.tiers)) {
		throw new Error(`${name} tiers must be an array.`);
	}
	return {
		...parseModelPricingRates(record, name),
		...(record.tiers === undefined
			? {}
			: {
					tiers: record.tiers.map((tier, index) => {
						const tierName = `${name} tier ${index}`;
						const tierRecord = requireRecord(tier, tierName);
						rejectUnknownKeys(tierRecord, PRICING_TIER_KEYS, tierName);
						return {
							...parseModelPricingRates(tierRecord, tierName),
							inputTokensAbove: requireNonNegativeNumber(
								tierRecord.inputTokensAbove,
								`${tierName} inputTokensAbove`,
							),
						};
					}),
				}),
	};
}

function parseModelPricingRates(record: Record<string, unknown>, name: string): ModelPricingRates {
	const rates: ModelPricingRates = {};
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const value = record[key];
		if (value === undefined) continue;
		rates[key] = requireNonNegativeNumber(value, `${name} ${key}`);
	}
	return rates;
}

function parsePricingEvidence(value: unknown): PricingEvidence {
	const record = requireRecord(value, "Analytics receipt pricingEvidence");
	if (record.source === "pi-reported-actual") {
		rejectUnknownKeys(record, new Set(["source"]), "analytics receipt pricingEvidence");
		return { source: "pi-reported-actual" };
	}
	if (record.source === "model-metadata") {
		rejectUnknownKeys(
			record,
			new Set(["source", "capturedAt"]),
			"analytics receipt pricingEvidence",
		);
		return {
			source: "model-metadata",
			capturedAt: requireTimestamp(
				record.capturedAt,
				"Analytics receipt pricingEvidence capturedAt",
			),
		};
	}
	if (record.source === "catalog") {
		rejectUnknownKeys(
			record,
			new Set(["source", "catalogDate"]),
			"analytics receipt pricingEvidence",
		);
		return {
			source: "catalog",
			catalogDate: requireDate(
				record.catalogDate,
				"Analytics receipt pricingEvidence catalogDate",
			),
		};
	}
	if (record.source === "unavailable") {
		rejectUnknownKeys(record, new Set(["source", "reason"]), "analytics receipt pricingEvidence");
		return {
			source: "unavailable",
			reason: requireUnavailabilityReason(
				record.reason,
				"Analytics receipt pricingEvidence reason",
			),
		};
	}
	throw new Error("Analytics receipt pricingEvidence source is invalid.");
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${name} must be a JSON object.`);
	return value;
}

function rejectUnknownKeys(
	record: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	name: string,
): void {
	const unknownKeys = Object.keys(record).filter((key) => !allowed.has(key));
	if (unknownKeys.length > 0) {
		throw new Error(`Unknown ${name} field: ${unknownKeys.join(", ")}.`);
	}
}

function requireSchemaVersion(value: unknown, name: string): number {
	if (value !== ANALYTICS_SCHEMA_VERSION) {
		throw new Error(`${name} schemaVersion ${String(value)} is unsupported.`);
	}
	return ANALYTICS_SCHEMA_VERSION;
}

function requireNonEmptyString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${name} must be a non-empty string.`);
	}
	return value;
}

function requireSafeIdentifier(value: unknown, name: string): string {
	const identifier = requireNonEmptyString(value, name);
	if (!/^[A-Za-z0-9._:-]+$/.test(identifier)) {
		throw new Error(`${name} must be an opaque identifier without a filesystem path.`);
	}
	return identifier;
}

function requireTimestamp(value: unknown, name: string): string {
	const timestamp = requireNonEmptyString(value, name);
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp)) {
		throw new Error(`${name} must be an ISO 8601 UTC timestamp.`);
	}
	return timestamp;
}

function requireNullableTimestamp(value: unknown, name: string): string | null {
	if (value === null) return null;
	return requireTimestamp(value, name);
}

function requireDate(value: unknown, name: string): string {
	const date = requireNonEmptyString(value, name);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new Error(`${name} must be an ISO 8601 date.`);
	}
	return date;
}

function requireFiniteNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${name} must be a finite number.`);
	}
	return value;
}

function requireNonNegativeNumber(value: unknown, name: string): number {
	const number = requireFiniteNumber(value, name);
	if (number < 0) throw new Error(`${name} must not be negative.`);
	return number;
}

function requireNonNegativeInteger(value: unknown, name: string): number {
	const number = requireNonNegativeNumber(value, name);
	if (!Number.isInteger(number)) throw new Error(`${name} must be an integer.`);
	return number;
}

function requireRunOutcome(value: unknown, name: string): RunOutcome {
	if (value === "active") return "active";
	if (value === "succeeded") return "succeeded";
	if (value === "failed") return "failed";
	if (value === "cancelled") return "cancelled";
	if (value === "released") return "released";
	if (value === "session-ended") return "session-ended";
	if (value === "interrupted") return "interrupted";
	if (value === "unfinished") return "unfinished";
	throw new Error(`${name} is invalid.`);
}

function requireHandoffState(value: unknown, name: string): HandoffState {
	if (value === "not-started") return "not-started";
	if (value === "pending") return "pending";
	if (value === "completed") return "completed";
	if (value === "failed") return "failed";
	throw new Error(`${name} is invalid.`);
}

function requireUsageRole(value: unknown, name: string): UsageRole {
	if (value === "planner-primary") return "planner-primary";
	if (value === "executor-primary") return "executor-primary";
	if (value === "auxiliary") return "auxiliary";
	if (value === "compaction") return "compaction";
	throw new Error(`${name} is invalid.`);
}

function requireUnavailabilityReason(value: unknown, name: string): UnavailabilityReason {
	if (value === "run-not-successful") return "run-not-successful";
	if (value === "pricing-missing") return "pricing-missing";
	if (value === "pricing-incomplete") return "pricing-incomplete";
	if (value === "pricing-zero") return "pricing-zero";
	if (value === "usage-incomplete") return "usage-incomplete";
	if (value === "analytics-disabled") return "analytics-disabled";
	if (value === "unfinished-run") return "unfinished-run";
	throw new Error(`${name} is invalid.`);
}

function parseJson(value: string, name: string): unknown {
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed;
	} catch {
		throw new Error(`Stored ${name} is not valid JSON.`);
	}
}
