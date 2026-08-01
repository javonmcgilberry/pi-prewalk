import {
	type PricingEvidence,
	type RunReceipt,
	type SavingsEstimate,
	summarizeActualCost,
	type TaskTreeReport,
	type UnavailabilityReason,
	type VerifiedBenchmarkSummary,
} from "./analytics.js";
import type { AnalyticsAggregate } from "./analytics-store.js";

export interface AnalyticsOverview {
	lifetime: AnalyticsAggregate;
	month: AnalyticsAggregate;
	week: AnalyticsAggregate;
	session: AnalyticsAggregate;
	verifiedBenchmark?: VerifiedBenchmarkSummary;
}

export function renderAnalyticsOverview(overview: AnalyticsOverview): string {
	return [
		"Prewalk personal savings analytics",
		renderAggregateLine("Lifetime", overview.lifetime),
		renderAggregateLine("Current month", overview.month),
		renderAggregateLine("Current week", overview.week),
		renderAggregateLine("Current session", overview.session),
		...(overview.verifiedBenchmark === undefined
			? []
			: [renderVerifiedBenchmarkSummary(overview.verifiedBenchmark)]),
		"Recent receipts:",
		...(overview.lifetime.recentReceipts.length === 0
			? ["  none"]
			: overview.lifetime.recentReceipts.map(
					(receipt) =>
						`  ${receipt.runId}: ${receipt.outcome}; actual ${formatUsd(receipt.actualCost)}; ${compactEstimate(receipt.estimate)}`,
				)),
		...(overview.lifetime.unfinished.length === 0
			? []
			: [
					"Unfinished runs (actual observed spend only):",
					...overview.lifetime.unfinished.map(
						(run) => `  ${run.runId}: unfinished; actual ${formatUsd(run.actualCost)}`,
					),
				]),
	].join("\n");
}

function renderAggregateLine(label: string, aggregate: AnalyticsAggregate): string {
	return `${label}: ${aggregate.receiptCount} receipts; actual ${formatUsd(aggregate.actualCost)}; estimated savings ${formatUsd(aggregate.estimatedSavings)}; estimated extra cost ${formatUsd(aggregate.estimatedExtraCost)}; unavailable ${aggregate.unavailableSavingsCount}; unfinished ${aggregate.unfinished.length}.`;
}

function compactEstimate(estimate: SavingsEstimate): string {
	if (estimate.kind === "unavailable")
		return `savings unavailable (${unavailabilityLabel(estimate.reason)})`;
	if (estimate.savings < 0) {
		return `${estimate.kind === "catalog-estimated" ? "catalog-estimated" : "estimated"} extra cost ${formatUsd(-estimate.savings)}`;
	}
	return `${estimate.kind === "catalog-estimated" ? "catalog-estimated" : "estimated"} savings ${formatUsd(estimate.savings)}`;
}

export function renderVerifiedBenchmarkSummary(summary: VerifiedBenchmarkSummary): string {
	return [
		"Verified benchmark comparison:",
		`  evidence: verified; fingerprint ${summary.evidenceFingerprint}; completed ${summary.completedAt}`,
		`  runs: Sol ${summary.runCounts.solOnly}; Luna ${summary.runCounts.lunaOnly}; Prewalk ${summary.runCounts.prewalk}`,
		`  median cost: Sol ${formatUsd(summary.comparisons.solOnlyCost)}; Luna ${formatUsd(summary.comparisons.lunaOnlyCost)}; Prewalk ${formatUsd(summary.comparisons.prewalkCost)}`,
	].join("\n");
}

export function renderTaskTreeReport(report: TaskTreeReport): string {
	return [
		`Prewalk task tree for root session ${report.rootSessionId}`,
		`Root session actual cost: ${formatUsd(report.rootActualCost)}.`,
		`Unique direct-child actual cost: ${formatUsd(report.directChildActualCost)}.`,
		`Unique nested-child actual cost: ${formatUsd(report.nestedChildActualCost)}.`,
		`Known task-tree actual cost: ${formatUsd(report.knownTaskTreeActualCost)} = ${formatUsd(report.rootActualCost)} + ${formatUsd(report.directChildActualCost)} + ${formatUsd(report.nestedChildActualCost)}.`,
		`Reported children: ${report.reportedChildCount} of ${report.expectedChildCount} expected.`,
		`Cost coverage: ${report.costCoverage}. Token-breakdown coverage: ${report.tokenCoverage}.`,
		`Task-tree estimate: savings ${formatUsd(report.estimatedSavings)}; extra cost ${formatUsd(report.estimatedExtraCost)}; estimate coverage ${report.estimateCoverage}.`,
		...(report.unresolved.length === 0
			? []
			: [
					`Incomplete or unfinished children: ${report.unresolved.map((item) => `${item.delegationRunId}/${item.childIndex} (${item.reason})`).join(", ")}.`,
				]),
	].join("\n");
}

export function renderReceiptReport(receipt: RunReceipt): string {
	const actual = summarizeActualCost(receipt.usage);
	return [
		`Run ${receipt.runId}: outcome ${receipt.outcome}; handoff ${receipt.handoffState}`,
		`Models: planner ${formatModel(receipt.planner.provider, receipt.planner.model)} -> executor ${formatModel(receipt.executor.provider, receipt.executor.model)}`,
		`Actual spend (Pi-reported): ${formatUsd(receipt.actualCost)}`,
		`Actual detail: planner primary ${formatUsd(actual.plannerPrimary)}; executor primary ${formatUsd(actual.executorPrimary)}; auxiliary ${formatUsd(actual.auxiliary)}`,
		renderSavingsEstimate(receipt.estimate, receipt.pricingEvidence),
	].join("\n");
}

export function renderSavingsEstimate(
	estimate: SavingsEstimate,
	pricingEvidence: PricingEvidence,
): string {
	if (estimate.kind === "unavailable") {
		return `Savings unavailable: ${unavailabilityLabel(estimate.reason)}.`;
	}

	const source = pricingSourceLabel(pricingEvidence);
	if (estimate.savings < 0) {
		return `${estimateLabel(estimate.kind)} (${source}): estimated extra cost ${formatUsd(-estimate.savings)}; planner-only cost ${formatUsd(estimate.plannerOnlyCost)}.`;
	}
	return `${estimateLabel(estimate.kind)} (${source}): estimated savings ${formatUsd(estimate.savings)}; planner-only cost ${formatUsd(estimate.plannerOnlyCost)}.`;
}

function estimateLabel(kind: Exclude<SavingsEstimate["kind"], "unavailable">): string {
	if (kind === "catalog-estimated") return "Catalog estimate";
	return "Session counterfactual estimate";
}

function pricingSourceLabel(evidence: PricingEvidence): string {
	if (evidence.source === "model-metadata") {
		return `model metadata captured ${evidence.capturedAt}`;
	}
	if (evidence.source === "catalog") return `catalog dated ${evidence.catalogDate}`;
	if (evidence.source === "pi-reported-actual") return "Pi-reported actual only";
	return `unavailable: ${unavailabilityLabel(evidence.reason)}`;
}

function unavailabilityLabel(reason: UnavailabilityReason): string {
	if (reason === "run-not-successful") return "run was not successful";
	if (reason === "pricing-missing") return "pricing is missing";
	if (reason === "pricing-incomplete") return "pricing is incomplete for used token categories";
	if (reason === "pricing-zero") return "pricing contains a zero or invalid rate";
	if (reason === "usage-incomplete") return "executor usage is incomplete";
	if (reason === "analytics-disabled") return "analytics collection was disabled";
	return "run is active or unfinished";
}

function formatModel(provider: string, model: string): string {
	return `${provider}/${model}`;
}

function formatUsd(value: number): string {
	return `$${value.toFixed(6)}`;
}
