import { describe, expect, it } from "vitest";
import type {
	RunReceipt,
	SavingsEstimate,
	TaskTreeReport,
	VerifiedBenchmarkSummary,
} from "../src/analytics.js";
import {
	renderAnalyticsOverview,
	renderReceiptReport,
	renderSavingsEstimate,
	renderTaskTreeReport,
	renderVerifiedBenchmarkSummary,
} from "../src/analytics-report.js";
import type { AnalyticsAggregate } from "../src/analytics-store.js";

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
	return {
		generation: "generation-1",
		receiptCount: 0,
		actualCost: 0,
		estimatedSavings: 0,
		estimatedExtraCost: 0,
		unavailableSavingsCount: 0,
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
			lifetime,
			month: aggregate(),
			week: aggregate(),
			session: aggregate(),
		});
		const after = renderAnalyticsOverview({
			lifetime,
			month: aggregate(),
			week: aggregate(),
			session: aggregate(),
			verifiedBenchmark,
		});
		expect(after).toContain("evidence: verified; fingerprint");
		expect(after).toContain("completed 2026-07-30T13:00:00.000Z");
		expect(after).toContain("Sol 20; Luna 20; Prewalk 20");
		expect(after.split("\n")[1]).toBe(before.split("\n")[1]);
		expect(renderVerifiedBenchmarkSummary(verifiedBenchmark)).toContain("median cost");
		expect(renderVerifiedBenchmarkSummary(verifiedBenchmark)).not.toContain("\\\\n");
	});
	it("labels actual and session-counterfactual evidence without relying on color", () => {
		expect(renderReceiptReport(receipt)).toBe(
			[
				"Run run-report: outcome succeeded; handoff completed",
				"Models: planner provider-a/planner -> executor provider-b/executor",
				"Actual spend (Pi-reported): $0.600000",
				"Actual detail: planner primary $0.300000; executor primary $0.200000; auxiliary $0.100000",
				"Session counterfactual estimate (model metadata captured 2026-07-30T12:01:00.000Z): estimated savings $0.300000; planner-only cost $0.800000.",
			].join("\n"),
		);
	});

	it("labels dated catalog estimates distinctly", () => {
		expect(
			renderSavingsEstimate(
				{ kind: "catalog-estimated", plannerOnlyCost: 1.25, savings: 0.25 },
				{ source: "catalog", catalogDate: "2026-07-30" },
			),
		).toBe(
			"Catalog estimate (catalog dated 2026-07-30): estimated savings $0.250000; planner-only cost $1.250000.",
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
		).toContain("estimated extra cost $0.200000");
	});

	it("renders aggregate evidence classes and unfinished state in text", () => {
		const lifetime = aggregate({
			receiptCount: 1,
			actualCost: 0.6,
			estimatedSavings: 0.3,
			recentReceipts: [receipt],
			unfinished: [
				{
					runId: "run-active",
					epoch: "epoch-active",
					sessionId: "session-report",
					startedAt: "2026-07-30T12:02:00.000Z",
					outcome: "unfinished",
					actualCost: 0.1,
				},
			],
		});
		const rendered = renderAnalyticsOverview({
			lifetime,
			month: aggregate(),
			week: aggregate(),
			session: aggregate(),
		});
		expect(rendered).toContain("Lifetime: 1 receipts; actual $0.600000");
		expect(rendered).toContain("estimated savings $0.300000");
		expect(rendered).toContain("run-report: succeeded");
		expect(rendered).toContain("run-active: unfinished; actual $0.100000");
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
				"Root session actual cost: $0.500000.",
				"Unique direct-child actual cost: $0.300000.",
				"Unique nested-child actual cost: $0.050000.",
				"Known task-tree actual cost: $0.850000 = $0.500000 + $0.300000 + $0.050000.",
				"Reported children: 3 of 3 expected.",
				"Cost coverage: complete. Token-breakdown coverage: incomplete.",
				"Task-tree estimate: savings $0.100000; extra cost $0.000000; estimate coverage incomplete.",
				"Incomplete or unfinished children: nested/2 (partial-token-breakdown).",
			].join("\n"),
		);
	});

	it.each([
		["run-not-successful", "run was not successful"],
		["pricing-missing", "pricing is missing"],
		["pricing-incomplete", "pricing is incomplete for used token categories"],
		["pricing-zero", "pricing contains a zero or invalid rate"],
		["usage-incomplete", "executor usage is incomplete"],
		["analytics-disabled", "analytics collection was disabled"],
		["unfinished-run", "run is active or unfinished"],
	] as const)("explains unavailable reason %s", (reason, label) => {
		expect(
			renderSavingsEstimate({ kind: "unavailable", reason }, { source: "unavailable", reason }),
		).toBe(`Savings unavailable: ${label}.`);
	});
});
