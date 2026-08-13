import { describe, expect, it } from "vitest";
import type {
	RunReceipt,
	SavingsEstimate,
	TaskTreeReport,
	VerifiedBenchmarkSummary,
} from "../../src/analytics/index.js";
import { summarizeComparisons } from "../../src/analytics/index.js";
import {
	renderAnalyticsOverview,
	renderReceiptReport,
	renderSavingsEstimate,
	renderTaskTreeReport,
	renderVerifiedBenchmarkSummary,
} from "../../src/analytics/report.js";
import type { AnalyticsAggregate } from "../../src/analytics/store.js";

const receipt: RunReceipt = {
	schemaVersion: 1,
	runId: "run-report",
	epoch: "epoch-report",
	sessionId: "session-report",
	generation: "generation-1",
	startedAt: "2026-07-30T12:00:00.000Z",
	completedAt: "2026-07-30T12:01:00.000Z",
	outcome: "succeeded",
	handoffState: "completed",
	planner: { provider: "provider-a", model: "planner" },
	executor: { provider: "provider-b", model: "executor" },
	usage: [
		{
			sequence: 1,
			provider: "provider-a",
			model: "planner",
			role: "planner-primary",
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 2,
			totalTokens: 15,
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
		},
		{
			sequence: 2,
			provider: "provider-b",
			model: "executor",
			role: "executor-primary",
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			totalTokens: 15,
			cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
		},
		{
			sequence: 3,
			provider: "provider-a",
			model: "helper",
			role: "auxiliary",
			inputTokens: 5,
			outputTokens: 1,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			totalTokens: 6,
			cost: { input: 0.05, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.1 },
		},
	],
	actualCost: 0.6,
	estimate: { kind: "session-counterfactual", plannerOnlyCost: 0.8, savings: 0.3 },
	pricingEvidence: { source: "model-metadata", capturedAt: "2026-07-30T12:01:00.000Z" },
};

function aggregate(overrides: Partial<AnalyticsAggregate> = {}): AnalyticsAggregate {
	const receipts = overrides.receipts ?? [];
	return {
		generation: "generation-1",
		receiptCount: 0,
		actualCost: 0,
		estimatedSavings: 0,
		estimatedExtraCost: 0,
		unavailableSavingsCount: 0,
		comparison: summarizeComparisons(receipts),
		outcomes: {
			active: 0,
			succeeded: 0,
			failed: 0,
			cancelled: 0,
			released: 0,
			"session-ended": 0,
			interrupted: 0,
			unfinished: 0,
		},
		receipts: [],
		recentReceipts: [],
		unfinished: [],
		...overrides,
	};
}

const verifiedBenchmark: VerifiedBenchmarkSummary = {
	schemaVersion: 1,
	benchmarkContractVersion: "benchmark-report-v2",
	evidenceFingerprint: "f".repeat(64),
	completedAt: "2026-07-30T13:00:00.000Z",
	runCounts: { solOnly: 20, lunaOnly: 20, prewalk: 20 },
	comparisons: {
		solOnlyCost: 100,
		lunaOnlyCost: 100,
		prewalkCost: 80,
		prewalkVsSolSavings: 20,
		prewalkVsLunaSavings: 20,
	},
};

describe("analytics receipt report", () => {
	it("renders verified benchmark evidence separately from personal totals", () => {
		const lifetime = aggregate({ actualCost: 0.6 });
		const before = renderAnalyticsOverview({
			generatedAt: "2026-07-30T13:00:00.000Z",
			sessionId: "session-report",
			lifetime,
			month: aggregate(),
			week: aggregate(),
			session: aggregate(),
		});
		const after = renderAnalyticsOverview({
			generatedAt: "2026-07-30T13:00:00.000Z",
			sessionId: "session-report",
			lifetime,
			month: aggregate(),
			week: aggregate(),
			session: aggregate(),
			verifiedBenchmark,
		});
		expect(after).toContain("evidence: verified; fingerprint");
		expect(after).toContain("completed 2026-07-30T13:00:00.000Z");
		expect(after).toContain("Sol 20; Luna 20; Prewalk 20");
		expect(after.split("\n")[3]).toBe(before.split("\n")[3]);
		expect(renderVerifiedBenchmarkSummary(verifiedBenchmark)).toContain("median cost");
		expect(renderVerifiedBenchmarkSummary(verifiedBenchmark)).not.toContain("\\\\n");
	});
	it("labels actual and session-counterfactual evidence without relying on color", () => {
		expect(renderReceiptReport(receipt)).toBe(
			[
				"Run run-report: succeeded; switched models",
				"Session: session-report",
				"Models: started on provider-a/planner, switched to provider-b/executor",
				"Spent: $0.600000",
				"Spent before the switch $0.300000; after the switch $0.200000; background calls $0.100000",
				"Estimate from recorded prices (model pricing captured 2026-07-30T12:01:00.000Z): switching saved up to $0.300000; without switching this run was worth $0.800000.",
			].join("\n"),
		);
	});

	it("uses available session titles while retaining stable session and run identifiers", () => {
		const titles = new Map([["session-report", "Authentication cleanup"]]);
		const rendered = renderAnalyticsOverview({
			generatedAt: "2026-07-30T13:00:00.000Z",
			sessionId: "session-report",
			lifetime: aggregate({ recentReceipts: [receipt] }),
			month: aggregate(),
			week: aggregate(),
			session: aggregate(),
			sessionTitles: titles,
		});
		expect(rendered).toContain("Authentication cleanup (session-report)");
		expect(rendered).toContain("run-report");
		expect(renderReceiptReport(receipt, titles)).toContain(
			"Session: Authentication cleanup (session-report)",
		);
	});

	it("labels dated catalog estimates distinctly", () => {
		expect(
			renderSavingsEstimate(
				{ kind: "catalog-estimated", plannerOnlyCost: 1.25, savings: 0.25 },
				{ source: "catalog", catalogDate: "2026-07-30" },
			),
		).toBe(
			"Estimate from the price catalog (catalog dated 2026-07-30): switching saved up to $0.250000; without switching this run was worth $1.250000.",
		);
	});

	it("renders negative savings as estimated extra cost", () => {
		const estimate: SavingsEstimate = {
			kind: "session-counterfactual",
			plannerOnlyCost: 1.2,
			savings: -0.2,
		};
		expect(
			renderSavingsEstimate(estimate, {
				source: "model-metadata",
				capturedAt: "2026-07-30T12:01:00.000Z",
			}),
		).toContain("switching cost $0.200000 extra");
	});

	it("renders aggregate evidence classes and unfinished state in text", () => {
		const lifetime = aggregate({
			receiptCount: 3,
			actualCost: 1.3,
			estimatedSavings: 0.3,
			outcomes: {
				...aggregate().outcomes,
				succeeded: 2,
				cancelled: 1,
				unfinished: 1,
			},
			receipts: [
				receipt,
				{
					...receipt,
					runId: "run-unpriced",
					actualCost: 0.2,
					estimate: { kind: "unavailable", reason: "pricing-missing" },
					pricingEvidence: { source: "unavailable", reason: "pricing-missing" },
				},
				{
					...receipt,
					runId: "run-cancelled",
					outcome: "cancelled",
					actualCost: 0.4,
					estimate: { kind: "unavailable", reason: "run-not-successful" },
					pricingEvidence: { source: "unavailable", reason: "run-not-successful" },
				},
			],
			recentReceipts: [receipt],
			unfinished: [
				{
					runId: "run-active",
					epoch: "epoch-active",
					sessionId: "session-report",
					startedAt: "2026-07-30T12:02:00.000Z",
					outcome: "unfinished",
					handoffState: "completed",
					planner: { provider: "openai", model: "planner" },
					executor: { provider: "openai", model: "executor" },
					actualCost: 0.1,
				},
			],
		});
		const rendered = renderAnalyticsOverview({
			generatedAt: "2026-07-30T13:00:00.000Z",
			sessionId: "session-report",
			lifetime,
			month: aggregate(),
			week: aggregate(),
			session: aggregate({
				receiptCount: 1,
				actualCost: 0.7,
				receipts: [receipt],
				unfinished: [
					{
						runId: "run-active",
						epoch: "epoch-active",
						sessionId: "session-report",
						startedAt: "2026-07-30T12:02:00.000Z",
						outcome: "unfinished",
						handoffState: "completed",
						planner: { provider: "openai", model: "planner" },
						executor: { provider: "openai", model: "executor" },
						actualCost: 0.1,
					},
				],
			}),
		});
		expect(rendered.indexOf("Current Pi session: session-report")).toBeLessThan(
			rendered.indexOf("History"),
		);
		expect(rendered).toContain("Snapshot: 2026-07-30T13:00:00.000Z");
		expect(rendered).toContain("Active runs: 1");
		expect(rendered).toContain("Finished runs: 1");
		expect(rendered).toContain("This current-session section excludes delegated child sessions");
		expect(rendered).toContain("History · what you spent");
		expect(rendered).toContain("History · what switching saved");
		expect(rendered).toContain("1 run compared; 1 run: model prices were not available");
		expect(rendered).toContain("$1.30");
		expect(rendered).toContain("$0.80");
		expect(rendered).toContain("saved up to $0.30 (37.5%)");
		expect(rendered).toContain("run-report");
		expect(rendered).toContain("run-active");
	});

	it("distinguishes catalog estimates and unavailable comparisons in overview tables", () => {
		const catalogReceipt: RunReceipt = {
			...receipt,
			runId: "run-catalog",
			estimate: { kind: "catalog-estimated", plannerOnlyCost: 0.8, savings: 0.3 },
			pricingEvidence: { source: "catalog", catalogDate: "2026-07-30" },
		};
		const rendered = renderAnalyticsOverview({
			generatedAt: "2026-07-30T13:00:00.000Z",
			sessionId: "session-report",
			lifetime: aggregate({ recentReceipts: [catalogReceipt] }),
			month: aggregate(),
			week: aggregate(),
			session: aggregate(),
		});
		expect(rendered).toContain("saved up to $0.30");
		expect(rendered).toContain("No finished runs yet");
	});

	it("keeps unavailable evidence visible beside comparable history", () => {
		const missingPricing: RunReceipt = {
			...receipt,
			runId: "run-missing-pricing",
			estimate: { kind: "unavailable", reason: "pricing-missing" },
			pricingEvidence: { source: "unavailable", reason: "pricing-missing" },
		};
		const rendered = renderAnalyticsOverview({
			generatedAt: "2026-07-30T13:00:00.000Z",
			sessionId: "session-report",
			lifetime: aggregate({
				receiptCount: 2,
				receipts: [receipt, missingPricing],
				recentReceipts: [receipt, missingPricing],
			}),
			month: aggregate(),
			week: aggregate(),
			session: aggregate(),
		});
		expect(rendered).toContain("1 run compared; 1 run: model prices were not available");
		expect(rendered).toContain("1 run: model prices were not available");
	});

	it("explains planning-only runs without calling their comparison unavailable", () => {
		const planningOnly: RunReceipt = {
			...receipt,
			handoffState: "not-started",
			usage: receipt.usage.slice(0, 1),
			actualCost: 0.3,
			estimate: { kind: "unavailable", reason: "usage-incomplete" },
			pricingEvidence: { source: "unavailable", reason: "usage-incomplete" },
		};
		expect(renderReceiptReport(planningOnly)).toContain(
			"This run never switched models, so there is nothing to compare.",
		);
	});

	it("does not dilute handoff counts with runs that finished before handoff", () => {
		const planningOnly: RunReceipt = {
			...receipt,
			runId: "run-planning-only",
			handoffState: "not-started",
			usage: receipt.usage.slice(0, 1),
			actualCost: 0.3,
			estimate: { kind: "unavailable", reason: "usage-incomplete" },
			pricingEvidence: { source: "unavailable", reason: "usage-incomplete" },
		};
		const rendered = renderAnalyticsOverview({
			generatedAt: "2026-07-30T13:00:00.000Z",
			sessionId: "session-report",
			lifetime: aggregate({ receipts: [receipt, planningOnly] }),
			month: aggregate(),
			week: aggregate(),
			session: aggregate(),
		});

		expect(rendered).toContain("1 run compared; 1 run never switched");
		expect(rendered).not.toContain("2 of 2 completed");
	});

	it("renders every task-tree subtotal and coverage dimension as a visible reconciliation", () => {
		const report: TaskTreeReport = {
			rootSessionId: "root",
			rootReceipts: [],
			descendantReceipts: [],
			fallbackEvidence: [],
			unresolved: [
				{
					delegationRunId: "nested",
					childIndex: 2,
					reason: "partial-token-breakdown",
				},
			],
			rootActualCost: 0.5,
			directChildActualCost: 0.3,
			nestedChildActualCost: 0.05,
			knownTaskTreeActualCost: 0.85,
			reportedChildCount: 3,
			expectedChildCount: 3,
			costCoverage: "complete",
			tokenCoverage: "incomplete",
			estimatedSavings: 0.1,
			estimatedExtraCost: 0,
			estimateCoverage: "incomplete",
		};

		expect(renderTaskTreeReport(report)).toBe(
			[
				"Prewalk task tree for root session root",
				"Root session recorded spend: $0.500000.",
				"Unique direct-child recorded spend: $0.300000.",
				"Unique nested-child recorded spend: $0.050000.",
				"Known task-tree recorded spend: $0.850000 = $0.500000 + $0.300000 + $0.050000.",
				"Reported children: 3 of 3 expected.",
				"Cost coverage: complete. Token-breakdown coverage: incomplete.",
				"Across this task: switching saved up to $0.100000; extra cost $0.000000; coverage incomplete.",
				"Incomplete or unfinished children: nested/2 (partial-token-breakdown).",
			].join("\n"),
		);
	});

	it.each([
		["run-not-successful", "the run stopped early"],
		["pricing-missing", "model prices were not available"],
		["pricing-incomplete", "we had no price for part of what this run used"],
		["pricing-zero", "a recorded price was zero, which cannot be right"],
		["usage-incomplete", "no work was recorded after the switch"],
		["analytics-disabled", "tracking was turned off"],
		["unfinished-run", "the run is still going"],
	] as const)("explains unavailable reason %s", (reason, label) => {
		expect(
			renderSavingsEstimate({ kind: "unavailable", reason }, { source: "unavailable", reason }),
		).toBe(`Not compared: ${label}.`);
	});
});
