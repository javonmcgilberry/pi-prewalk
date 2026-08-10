import {
	type ComparisonSummary,
	comparisonEstimate,
	isPlanningOnlyReceipt,
	type PricingEvidence,
	type RunReceipt,
	type SavingsEstimate,
	summarizeActualCost,
	type TaskTreeReport,
	type VerifiedBenchmarkSummary,
} from "./index.js";
import type { AnalyticsAggregate } from "./store.js";

export interface AnalyticsOverview {
	generatedAt: string;
	sessionId: string;
	lifetime: AnalyticsAggregate;
	month: AnalyticsAggregate;
	week: AnalyticsAggregate;
	session: AnalyticsAggregate;
	verifiedBenchmark?: VerifiedBenchmarkSummary;
	sessionTitles?: ReadonlyMap<string, string>;
}

export function renderAnalyticsOverview(overview: AnalyticsOverview): string {
	return [
		"Prewalk analytics",
		"Spent counts every run. Savings only count runs that switched models and had price data.",
		"Those cover different runs. Judge savings against the compared figure on the same row, not against everything you spent.",
		"",
		`Current Pi session: ${sessionLabel(overview.sessionId, overview.sessionTitles)}`,
		`Snapshot: ${overview.generatedAt}`,
		`Recorded spend: ${formatCompactUsd(overview.session.actualCost)}`,
		`Active runs: ${overview.session.unfinished.length}`,
		`Finished runs: ${overview.session.receiptCount}`,
		...(overview.session.unfinished.length === 0
			? ["No active Prewalk run in this Pi session."]
			: [
					renderTable(
						["ACTIVE RUN", "STARTED", "RECORDED SPEND"],
						overview.session.unfinished.map((run) => [
							run.runId,
							run.startedAt,
							formatCompactUsd(run.actualCost),
						]),
					),
				]),
		...(overview.session.receipts.length === 0
			? ["No finished Prewalk runs in this Pi session."]
			: [
					renderTable(
						["FINISHED RUN", "OUTCOME", "SPENT", "ESTIMATED DIFFERENCE"],
						overview.session.receipts.map((receipt) => [
							receipt.runId,
							receipt.outcome,
							formatCompactUsd(receipt.actualCost),
							compactEstimate(receipt),
						]),
					),
				]),
		"This current-session section excludes delegated child sessions. Use /prewalk stats task for the whole task tree.",
		"",
		"History \u00b7 what you spent",
		renderTable(
			["PERIOD", "RUNS DONE", "SPENT", "ACTIVE"],
			[
				renderObservedSpendRow("This week", overview.week),
				renderObservedSpendRow("This month", overview.month),
				renderObservedSpendRow("All time", overview.lifetime),
			],
		),
		"",
		"History \u00b7 what switching saved",
		renderTable(
			[
				"PERIOD",
				"RUNS COMPARED",
				"COMPARED",
				"IF NEVER SWITCHED",
				"ACTUALLY PAID",
				"SAVED BY SWITCHING",
			],
			[
				renderComparisonRow("This week", overview.week),
				renderComparisonRow("This month", overview.month),
				renderComparisonRow("All time", overview.lifetime),
			],
		),
		...(overview.verifiedBenchmark === undefined
			? []
			: ["", renderVerifiedBenchmarkSummary(overview.verifiedBenchmark)]),
		"",
		`Recent activity (${overview.lifetime.recentReceipts.length} finished ${overview.lifetime.recentReceipts.length === 1 ? "run" : "runs"})`,
		...(overview.lifetime.recentReceipts.length === 0
			? ["No finished runs yet."]
			: [
					renderTable(
						["SESSION", "RUN ID", "OUTCOME", "SPENT", "ESTIMATED DIFFERENCE"],
						overview.lifetime.recentReceipts.map((receipt) => [
							sessionLabel(receipt.sessionId, overview.sessionTitles),
							receipt.runId,
							receipt.outcome,
							formatCompactUsd(receipt.actualCost),
							compactEstimate(receipt),
						]),
					),
				]),
	].join("\n");
}

function renderObservedSpendRow(label: string, aggregate: AnalyticsAggregate): string[] {
	return [
		label,
		String(aggregate.receiptCount),
		formatCompactUsd(aggregate.actualCost),
		String(aggregate.unfinished.length),
	];
}

function renderComparisonRow(label: string, aggregate: AnalyticsAggregate): string[] {
	const summary = aggregate.comparison;
	const evidence = comparisonCoverage(summary);
	if (summary.comparedRuns === 0) {
		return [
			label,
			evidence,
			coveredSpend(summary, aggregate),
			"—",
			"—",
			summary.finishedRuns === 0
				? aggregate.receipts.length === 0
					? "No finished runs yet"
					: `No finished runs: ${unsuccessfulSummary(aggregate.receipts)}`
				: summary.noHandoffRuns === summary.finishedRuns
					? "Never switched models"
					: `Cannot compare: ${unavailableSummary(summary)}`,
		];
	}
	return [
		label,
		evidence,
		coveredSpend(summary, aggregate),
		formatCompactUsd(summary.plannerOnlyCost),
		formatCompactUsd(summary.actualPrimaryCost),
		formatNetResult(summary.difference, summary.plannerOnlyCost),
	];
}

/**
 * States how much of the period's recorded spend the difference is built from,
 * so a small difference beside a large recorded total reads as narrow coverage
 * rather than a poor result.
 */
function coveredSpend(summary: ComparisonSummary, aggregate: AnalyticsAggregate): string {
	if (aggregate.actualCost === 0) return "—";
	const share = (summary.comparedActualCost / aggregate.actualCost) * 100;
	return `${formatCompactUsd(summary.comparedActualCost)} of ${formatCompactUsd(aggregate.actualCost)} (${share.toFixed(0)}%)`;
}

function comparisonCoverage(summary: ComparisonSummary): string {
	const parts = [
		`${summary.comparedRuns} ${summary.comparedRuns === 1 ? "run" : "runs"} compared`,
	];
	if (summary.noHandoffRuns > 0) {
		parts.push(
			`${summary.noHandoffRuns} ${summary.noHandoffRuns === 1 ? "run" : "runs"} never switched`,
		);
	}
	if (summary.unavailableRuns > 0) parts.push(unavailableSummary(summary));
	return parts.join("; ");
}

function renderTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
	);
	const renderRow = (row: string[]) =>
		row
			.map((cell, index) => cell.padEnd(widths[index] ?? 0))
			.join("  ")
			.trimEnd();
	return [
		renderRow(headers),
		widths.map((width) => "─".repeat(width)).join("  "),
		...rows.map(renderRow),
	].join("\n");
}

function compactEstimate(receipt: RunReceipt): string {
	const estimate = comparisonEstimate(receipt);
	if (isPlanningOnlyReceipt(receipt)) return "Never switched models; nothing to compare";
	if (estimate.kind === "unavailable" && estimate.reason === "run-not-successful") {
		return `${finishedOutcomeLabel(receipt.outcome)}, so not compared`;
	}
	if (estimate.kind === "unavailable")
		return `Not compared: ${unavailabilityLabel(estimate.reason)}`;
	if (estimate.savings < 0) {
		return `cost ${formatCompactUsd(-estimate.savings)} extra`;
	}
	return `saved up to ${formatCompactUsd(estimate.savings)}`;
}

function formatNetResult(netSavings: number, plannerOnlyCost: number): string {
	if (netSavings === 0) return "No cost difference";
	if (plannerOnlyCost === 0) return "No percentage available";
	const percentage = `${Math.abs((netSavings / plannerOnlyCost) * 100).toFixed(1)}%`;
	return netSavings < 0
		? `cost ${formatCompactUsd(-netSavings)} extra (${percentage})`
		: `saved up to ${formatCompactUsd(netSavings)} (${percentage})`;
}

export function renderVerifiedBenchmarkSummary(summary: VerifiedBenchmarkSummary): string {
	return [
		"Verified benchmark comparison:",
		`  evidence: verified; fingerprint ${summary.evidenceFingerprint}; completed ${summary.completedAt}`,
		`  runs: Sol ${summary.runCounts.solOnly}; Luna ${summary.runCounts.lunaOnly}; Prewalk ${summary.runCounts.prewalk}`,
		`  median cost: Sol ${formatUsd(summary.comparisons.solOnlyCost)}; Luna ${formatUsd(summary.comparisons.lunaOnlyCost)}; Prewalk ${formatUsd(summary.comparisons.prewalkCost)}`,
	].join("\n");
}

export function renderTaskTreeReport(
	report: TaskTreeReport,
	sessionTitles?: ReadonlyMap<string, string>,
): string {
	return [
		`Prewalk task tree for root session ${sessionLabel(report.rootSessionId, sessionTitles)}`,
		`Root session recorded spend: ${formatUsd(report.rootActualCost)}.`,
		`Unique direct-child recorded spend: ${formatUsd(report.directChildActualCost)}.`,
		`Unique nested-child recorded spend: ${formatUsd(report.nestedChildActualCost)}.`,
		`Known task-tree recorded spend: ${formatUsd(report.knownTaskTreeActualCost)} = ${formatUsd(report.rootActualCost)} + ${formatUsd(report.directChildActualCost)} + ${formatUsd(report.nestedChildActualCost)}.`,
		`Reported children: ${report.reportedChildCount} of ${report.expectedChildCount} expected.`,
		`Cost coverage: ${report.costCoverage}. Token-breakdown coverage: ${report.tokenCoverage}.`,
		`Across this task: switching saved up to ${formatUsd(report.estimatedSavings)}; extra cost ${formatUsd(report.estimatedExtraCost)}; coverage ${report.estimateCoverage}.`,
		...(report.unresolved.length === 0
			? []
			: [
					`Incomplete or unfinished children: ${report.unresolved.map((item) => `${item.delegationRunId}/${item.childIndex} (${item.reason})`).join(", ")}.`,
				]),
	].join("\n");
}

export function renderReceiptReport(
	receipt: RunReceipt,
	sessionTitles?: ReadonlyMap<string, string>,
): string {
	const actual = summarizeActualCost(receipt.usage);
	const estimate = comparisonEstimate(receipt);
	return [
		`Run ${receipt.runId}: ${receipt.outcome}; ${handoffPhrase(receipt.handoffState)}`,
		`Session: ${sessionLabel(receipt.sessionId, sessionTitles)}`,
		`Models: started on ${formatModel(receipt.planner.provider, receipt.planner.model)}, switched to ${formatModel(receipt.executor.provider, receipt.executor.model)}`,
		`Spent: ${formatUsd(receipt.actualCost)}`,
		`Spent before the switch ${formatUsd(actual.plannerPrimary)}; after the switch ${formatUsd(actual.executorPrimary)}; background calls ${formatUsd(actual.auxiliary)}`,
		renderReceiptComparison(receipt, estimate),
	].join("\n");
}

/** Says what happened to the model switch without exposing the internal state name. */
function handoffPhrase(state: RunReceipt["handoffState"]): string {
	if (state === "completed") return "switched models";
	if (state === "pending") return "switch was still in progress";
	if (state === "failed") return "the switch failed";
	return "never switched";
}

function renderReceiptComparison(receipt: RunReceipt, estimate: SavingsEstimate): string {
	if (isPlanningOnlyReceipt(receipt)) {
		return "This run never switched models, so there is nothing to compare.";
	}
	if (estimate.kind === "unavailable" && estimate.reason === "run-not-successful") {
		return `Not compared because this run ended as ${finishedOutcomeLabel(receipt.outcome).toLowerCase()}.`;
	}
	return renderSavingsEstimate(estimate, receipt.pricingEvidence);
}

export function renderSavingsEstimate(
	estimate: SavingsEstimate,
	pricingEvidence: PricingEvidence,
): string {
	if (estimate.kind === "unavailable") {
		return `Not compared: ${unavailabilityLabel(estimate.reason)}.`;
	}

	const source = pricingSourceLabel(pricingEvidence);
	if (estimate.savings < 0) {
		return `${estimateLabel(estimate.kind)} (${source}): switching cost ${formatUsd(-estimate.savings)} extra; without switching this run was worth ${formatUsd(estimate.plannerOnlyCost)}.`;
	}
	return `${estimateLabel(estimate.kind)} (${source}): switching saved up to ${formatUsd(estimate.savings)}; without switching this run was worth ${formatUsd(estimate.plannerOnlyCost)}.`;
}

function estimateLabel(kind: Exclude<SavingsEstimate["kind"], "unavailable">): string {
	if (kind === "catalog-estimated") return "Estimate from the price catalog";
	return "Estimate from recorded prices";
}

function pricingSourceLabel(evidence: PricingEvidence): string {
	if (evidence.source === "model-metadata") {
		return `model pricing captured ${evidence.capturedAt}`;
	}
	if (evidence.source === "catalog") return `catalog dated ${evidence.catalogDate}`;
	if (evidence.source === "pi-reported-actual") return "Pi-reported spend only";
	return `unavailable: ${unavailabilityLabel(evidence.reason)}`;
}

function unavailabilityLabel(reason: string): string {
	if (reason === "run-not-successful") return "the run stopped early";
	if (reason === "pricing-missing") return "model prices were not available";
	if (reason === "pricing-incomplete") return "we had no price for part of what this run used";
	if (reason === "pricing-zero") return "a recorded price was zero, which cannot be right";
	if (reason === "usage-incomplete") return "no work was recorded after the switch";
	if (reason === "analytics-disabled") return "tracking was turned off";
	return "the run is still going";
}

function unavailableSummary(summary: ComparisonSummary): string {
	return Object.entries(summary.unavailableReasons)
		.map(
			([reason, count]) =>
				`${count} ${count === 1 ? "run" : "runs"}: ${unavailabilityLabel(reason)}`,
		)
		.join("; ");
}

function unsuccessfulSummary(receipts: readonly RunReceipt[]): string {
	const outcomes = new Map<string, number>();
	for (const receipt of receipts) {
		const label = receipt.outcome === "session-ended" ? "session ended" : receipt.outcome;
		outcomes.set(label, (outcomes.get(label) ?? 0) + 1);
	}
	return [...outcomes.entries()]
		.map(([label, count]) => `${count} ${label} ${count === 1 ? "run" : "runs"}`)
		.join("; ");
}

function finishedOutcomeLabel(outcome: RunReceipt["outcome"]): string {
	if (outcome === "session-ended") return "Session ended";
	return outcome.charAt(0).toUpperCase() + outcome.slice(1);
}

function formatModel(provider: string, model: string): string {
	return `${provider}/${model}`;
}

function sessionLabel(sessionId: string, titles?: ReadonlyMap<string, string>): string {
	const title = titles?.get(sessionId);
	return title ? `${title} (${sessionId})` : sessionId;
}

function formatUsd(value: number): string {
	return `$${value.toFixed(6)}`;
}

function formatCompactUsd(value: number): string {
	return `$${value.toFixed(2)}`;
}
