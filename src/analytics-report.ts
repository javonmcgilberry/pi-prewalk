import {
	comparisonEstimate,
	isPlanningOnlyReceipt,
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
		"Actual spend includes every recorded run. Price comparisons use completed runs with the required usage and pricing.",
		"",
		`Current Pi session: ${sessionLabel(overview.sessionId, overview.sessionTitles)}`,
		`Snapshot: ${overview.generatedAt}`,
		`Actual spend: ${formatCompactUsd(overview.session.actualCost)}`,
		`Active runs: ${overview.session.unfinished.length}`,
		`Finished runs: ${overview.session.receiptCount}`,
		...(overview.session.unfinished.length === 0
			? ["No active Prewalk run in this Pi session."]
			: [
					renderTable(
						["ACTIVE RUN", "STARTED", "ACTUAL SPEND"],
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
						["FINISHED RUN", "OUTCOME", "ACTUAL SPEND", "VS PLANNER ALONE"],
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
		"History · actual spend",
		renderTable(
			["PERIOD", "FINISHED RUNS", "ACTUAL SPEND", "ACTIVE"],
			[
				renderObservedSpendRow("This week", overview.week),
				renderObservedSpendRow("This month", overview.month),
				renderObservedSpendRow("All time", overview.lifetime),
			],
		),
		"",
		"History · planner-alone price comparison",
		renderTable(
			["PERIOD", "RUNS COMPARED", "PLANNER ALONE", "PLANNER + EXECUTOR", "DIFFERENCE"],
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
						["SESSION", "RUN ID", "OUTCOME", "ACTUAL SPEND", "VS PLANNER ALONE"],
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
	const successful = aggregate.receipts.filter((receipt) => receipt.outcome === "succeeded");
	const comparable = successful
		.map((receipt) => ({ receipt, estimate: comparisonEstimate(receipt) }))
		.filter(({ estimate }) => estimate.kind !== "unavailable");
	const evidence = `${comparable.length} of ${successful.length} completed${
		comparable.length < successful.length ? `; ${unavailableSummary(successful)}` : ""
	}`;
	if (comparable.length === 0) {
		return [
			label,
			evidence,
			"—",
			"—",
			successful.length === 0
				? aggregate.receipts.length === 0
					? "No completed runs yet"
					: `No completed runs: ${unsuccessfulSummary(aggregate.receipts)}`
				: `Cannot compare: ${unavailableSummary(successful)}`,
		];
	}
	const plannerOnlyCost = comparable.reduce(
		(total, { estimate }) =>
			total + (estimate.kind === "unavailable" ? 0 : estimate.plannerOnlyCost),
		0,
	);
	const netSavings = comparable.reduce(
		(total, { estimate }) => total + (estimate.kind === "unavailable" ? 0 : estimate.savings),
		0,
	);
	const prewalkPrimaryCost = plannerOnlyCost - netSavings;
	return [
		label,
		evidence,
		formatCompactUsd(plannerOnlyCost),
		formatCompactUsd(prewalkPrimaryCost),
		formatNetResult(netSavings, plannerOnlyCost),
	];
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
	if (isPlanningOnlyReceipt(receipt)) return "No executor handoff; no cost difference";
	if (estimate.kind === "unavailable" && estimate.reason === "run-not-successful") {
		return `${finishedOutcomeLabel(receipt.outcome)} run not compared`;
	}
	if (estimate.kind === "unavailable")
		return `Cannot compare: ${unavailabilityLabel(estimate.reason)}`;
	if (estimate.savings < 0) {
		return `${formatCompactUsd(-estimate.savings)} more than planner alone`;
	}
	return `${formatCompactUsd(estimate.savings)} less than planner alone`;
}

function formatNetResult(netSavings: number, plannerOnlyCost: number): string {
	if (netSavings === 0) return "No cost difference";
	if (plannerOnlyCost === 0) return "Cannot calculate percentage";
	const percentage = `${Math.abs((netSavings / plannerOnlyCost) * 100).toFixed(1)}%`;
	return netSavings < 0
		? `${formatCompactUsd(-netSavings)} more than planner alone (${percentage})`
		: `${formatCompactUsd(netSavings)} less than planner alone (${percentage})`;
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

export function renderReceiptReport(
	receipt: RunReceipt,
	sessionTitles?: ReadonlyMap<string, string>,
): string {
	const actual = summarizeActualCost(receipt.usage);
	const estimate = comparisonEstimate(receipt);
	return [
		`Run ${receipt.runId}: outcome ${receipt.outcome}; handoff ${receipt.handoffState}`,
		`Session: ${sessionLabel(receipt.sessionId, sessionTitles)}`,
		`Models: planner ${formatModel(receipt.planner.provider, receipt.planner.model)} -> executor ${formatModel(receipt.executor.provider, receipt.executor.model)}`,
		`Actual spend reported by provider: ${formatUsd(receipt.actualCost)}`,
		`Actual spend by call type: planner ${formatUsd(actual.plannerPrimary)}; executor ${formatUsd(actual.executorPrimary)}; helper/compaction ${formatUsd(actual.auxiliary)}`,
		renderReceiptComparison(receipt, estimate),
	].join("\n");
}

function renderReceiptComparison(receipt: RunReceipt, estimate: SavingsEstimate): string {
	if (isPlanningOnlyReceipt(receipt) && estimate.kind !== "unavailable") {
		return `No executor handoff was needed, so the compared cost is the same as actual planner cost (${formatUsd(estimate.plannerOnlyCost)}).`;
	}
	if (estimate.kind === "unavailable" && estimate.reason === "run-not-successful") {
		return `Cannot compare with planner alone because this run ended as ${finishedOutcomeLabel(receipt.outcome).toLowerCase()}.`;
	}
	return renderSavingsEstimate(estimate, receipt.pricingEvidence);
}

export function renderSavingsEstimate(
	estimate: SavingsEstimate,
	pricingEvidence: PricingEvidence,
): string {
	if (estimate.kind === "unavailable") {
		return `Cannot compare with planner alone: ${unavailabilityLabel(estimate.reason)}.`;
	}

	const source = pricingSourceLabel(pricingEvidence);
	if (estimate.savings < 0) {
		return `${estimateLabel(estimate.kind)} (${source}): ${formatUsd(-estimate.savings)} more than planner alone; planner-alone estimate ${formatUsd(estimate.plannerOnlyCost)}.`;
	}
	return `${estimateLabel(estimate.kind)} (${source}): ${formatUsd(estimate.savings)} less than planner alone; planner-alone estimate ${formatUsd(estimate.plannerOnlyCost)}.`;
}

function estimateLabel(kind: Exclude<SavingsEstimate["kind"], "unavailable">): string {
	if (kind === "catalog-estimated") return "Catalog price comparison";
	return "Price comparison";
}

function pricingSourceLabel(evidence: PricingEvidence): string {
	if (evidence.source === "model-metadata") {
		return `model pricing captured ${evidence.capturedAt}`;
	}
	if (evidence.source === "catalog") return `catalog dated ${evidence.catalogDate}`;
	if (evidence.source === "pi-reported-actual") return "Pi-reported actual only";
	return `unavailable: ${unavailabilityLabel(evidence.reason)}`;
}

function unavailabilityLabel(reason: UnavailabilityReason): string {
	if (reason === "run-not-successful") return "the run did not complete successfully";
	if (reason === "pricing-missing") return "model prices were not available";
	if (reason === "pricing-incomplete") return "a price was missing for a token type the run used";
	if (reason === "pricing-zero") return "a recorded model price was zero or invalid";
	if (reason === "usage-incomplete") return "recorded executor usage was missing";
	if (reason === "analytics-disabled") return "analytics collection was disabled";
	return "run is active or unfinished";
}

function unavailableSummary(receipts: readonly RunReceipt[]): string {
	const reasons = new Map<string, number>();
	for (const receipt of receipts) {
		const estimate = comparisonEstimate(receipt);
		if (estimate.kind !== "unavailable") continue;
		const label = unavailabilityLabel(estimate.reason);
		reasons.set(label, (reasons.get(label) ?? 0) + 1);
	}
	return [...reasons.entries()]
		.map(([label, count]) => `${count} ${count === 1 ? "run" : "runs"}: ${label}`)
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
