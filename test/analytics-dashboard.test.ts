import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { RunReceipt } from "../src/analytics.js";
import {
	buildAnalyticsDashboardModel,
	type DashboardPalette,
	renderAnalyticsDashboard,
	showAnalyticsDashboard,
	summarizeComparison,
} from "../src/analytics-dashboard.js";
import type { AnalyticsOverview } from "../src/analytics-report.js";
import type { AnalyticsAggregate } from "../src/analytics-store.js";

const palette: DashboardPalette = {
	color: (_tone, text) => text,
	bold: (text) => text,
};

function receipt(overrides: Partial<RunReceipt> = {}): RunReceipt {
	return {
		schemaVersion: 1,
		runId: "run-1",
		epoch: "epoch-1",
		sessionId: "session-current",
		generation: "generation-1",
		startedAt: "2026-08-06T12:00:00.000Z",
		completedAt: "2026-08-06T12:05:00.000Z",
		outcome: "succeeded",
		handoffState: "completed",
		planner: { provider: "openai", model: "planner" },
		executor: { provider: "openai", model: "executor" },
		usage: [],
		actualCost: 0.8,
		estimate: { kind: "session-counterfactual", plannerOnlyCost: 1, savings: 0.2 },
		pricingEvidence: { source: "model-metadata", capturedAt: "2026-08-06T12:05:00.000Z" },
		...overrides,
	};
}

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

function overview(overrides: Partial<AnalyticsOverview> = {}): AnalyticsOverview {
	const currentReceipt = receipt();
	const historyReceipt = receipt({
		runId: "run-history",
		sessionId: "session-history",
		completedAt: "2026-08-05T11:00:00.000Z",
		actualCost: 0.5,
		estimate: { kind: "session-counterfactual", plannerOnlyCost: 0.7, savings: 0.2 },
	});
	return {
		generatedAt: "2026-08-06T12:10:00.000Z",
		sessionId: "session-current",
		lifetime: aggregate({
			receiptCount: 2,
			actualCost: 1.3,
			receipts: [currentReceipt, historyReceipt],
			recentReceipts: [currentReceipt, historyReceipt],
		}),
		month: aggregate({
			receiptCount: 2,
			actualCost: 1.3,
			receipts: [currentReceipt, historyReceipt],
		}),
		week: aggregate({
			receiptCount: 2,
			actualCost: 1.3,
			receipts: [currentReceipt, historyReceipt],
		}),
		session: aggregate({ receiptCount: 1, actualCost: 0.8, receipts: [currentReceipt] }),
		sessionTitles: new Map([
			["session-current", "Prewalk dashboard redesign"],
			["session-history", "Backfill session titles"],
		]),
		...overrides,
	};
}

describe("analytics dashboard", () => {
	it("puts current session first and orders history from recent to broad", () => {
		const model = buildAnalyticsDashboardModel(overview());
		expect(model.current.title).toBe("Prewalk dashboard redesign");
		expect(model.periods.map((item) => item.label)).toEqual([
			"This week",
			"This month",
			"All time",
		]);
	});

	it("uses titles in the overview and keeps stable IDs in details", () => {
		const model = buildAnalyticsDashboardModel(overview());
		const main = renderAnalyticsDashboard(
			model,
			{ view: "overview", selectedIndex: 0 },
			110,
			palette,
		).join("\n");
		const details = renderAnalyticsDashboard(
			model,
			{ view: "details", selectedIndex: 0 },
			90,
			palette,
		).join("\n");
		expect(main).toContain("Prewalk dashboard redesign");
		expect(main).toContain("Backfill session titles");
		expect(main).not.toContain("session-current");
		expect(details).toContain("session-current");
	});

	it("replaces opaque savings and coverage labels with plain language", () => {
		const comparison = summarizeComparison([receipt()]);
		expect(comparison.label).toBe("$0.20 less than planner alone");
		expect(comparison.detail).toBe("1 completed run compared.");
		const output = renderAnalyticsDashboard(
			buildAnalyticsDashboardModel(overview()),
			{ view: "overview", selectedIndex: 0 },
			110,
			palette,
		).join("\n");
		expect(output).not.toContain("Prewalk primary");
		expect(output).not.toContain("COVERAGE");
		expect(output).not.toMatch(/\b\d+\s*\/\s*\d+\b/);
	});

	it("puts active current-session spend before historical analysis", () => {
		const model = buildAnalyticsDashboardModel(
			overview({
				session: aggregate({
					actualCost: 0.35,
					unfinished: [
						{
							runId: "run-active",
							epoch: "epoch-active",
							sessionId: "session-current",
							startedAt: "2026-08-06T12:09:00.000Z",
							outcome: "unfinished",
							actualCost: 0.35,
						},
					],
				}),
			}),
		);
		const output = renderAnalyticsDashboard(
			model,
			{ view: "overview", selectedIndex: 0 },
			90,
			palette,
		).join("\n");
		expect(output.indexOf("CURRENT SESSION")).toBeLessThan(output.indexOf("HISTORY"));
		expect(output).toContain("1 active");
		expect(output).toContain("$0.35");
	});

	it("explains why an estimate is unavailable", () => {
		const missingPricing = receipt({
			estimate: { kind: "unavailable", reason: "pricing-missing" },
			pricingEvidence: { source: "unavailable", reason: "pricing-missing" },
		});
		const comparison = summarizeComparison([missingPricing]);
		expect(comparison.label).toBe("Missing pricing");
		expect(comparison.detail).toBe("1 run missing pricing.");
	});

	it("does not call a completed planning-only run unavailable", () => {
		const planningOnly = receipt({
			handoffState: "not-started",
			actualCost: 0.4,
			estimate: { kind: "unavailable", reason: "usage-incomplete" },
			pricingEvidence: { source: "unavailable", reason: "usage-incomplete" },
		});
		const comparison = summarizeComparison([planningOnly]);
		expect(comparison.state).toBe("same");
		expect(comparison.label).toBe("No cost difference");
		expect(comparison.detail).toBe("1 completed run compared. No executor handoff was needed.");
	});

	it("keeps missing evidence visible when other runs are comparable", () => {
		const missingPricing = receipt({
			runId: "run-missing-pricing",
			estimate: { kind: "unavailable", reason: "pricing-missing" },
			pricingEvidence: { source: "unavailable", reason: "pricing-missing" },
		});
		const mixed = summarizeComparison([receipt(), missingPricing]);
		expect(mixed.label).toBe("$0.20 less than planner alone");
		expect(mixed.detail).toContain("1 of 2 completed runs compared");
		expect(mixed.detail).toContain("1 run missing pricing");

		const cancelled = summarizeComparison([
			receipt({
				outcome: "cancelled",
				estimate: { kind: "unavailable", reason: "run-not-successful" },
				pricingEvidence: { source: "unavailable", reason: "run-not-successful" },
			}),
		]);
		expect(cancelled.label).toBe("Cancelled run not compared");
		expect(cancelled.detail).toBe("1 cancelled run not compared.");
	});

	it("states the calculation and its counterfactual limit", () => {
		const help = renderAnalyticsDashboard(
			buildAnalyticsDashboardModel(overview()),
			{ view: "help", selectedIndex: 0 },
			90,
			palette,
		).join("\n");
		expect(help).toContain(
			"Provider-reported cost for planner, executor, helper, and compaction",
		);
		expect(help).toContain("price executor tokens at the planner's rates");
		expect(help).toContain("not a measured planner-only benchmark run");
	});

	it("refreshes the model from the dashboard without closing the view", async () => {
		let refreshCount = 0;
		let renderCount = 0;
		const custom = async (factory: any) => {
			const component = factory(
				{ requestRender: () => renderCount++ },
				{ fg: (_tone: string, text: string) => text, bold: (text: string) => text },
				{},
				() => undefined,
			);
			component.handleInput?.("r");
			await Promise.resolve();
			await Promise.resolve();
			component.dispose?.();
			return undefined;
		};
		await showAnalyticsDashboard({ ui: { custom } } as any, overview(), async () => {
			refreshCount += 1;
			return overview();
		});
		expect(refreshCount).toBe(1);
		expect(renderCount).toBeGreaterThanOrEqual(2);
	});

	it.each([24, 60, 88])("renders a readable layout at %d columns without overflowing", (width) => {
		const lines = renderAnalyticsDashboard(
			buildAnalyticsDashboardModel(overview()),
			{ view: "overview", selectedIndex: 0 },
			width,
			palette,
		);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(lines.join("\n")).toContain("This week");
		expect(lines.join("\n").toLowerCase()).toContain("less");
	});
});
