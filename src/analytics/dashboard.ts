import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { type RunOutcome, type RunReceipt, summarizeComparisons } from "./index.js";
import type { AnalyticsOverview } from "./report.js";
import type { AnalyticsAggregate, UnfinishedRunSummary } from "./store.js";

const AUTO_REFRESH_MS = 2_000;
const RECENT_SESSION_LIMIT = 4;

export type DashboardTone = "accent" | "success" | "warning" | "error" | "muted" | "dim";

export interface DashboardPalette {
	color(tone: DashboardTone, text: string): string;
	bold(text: string): string;
}

export interface DashboardComparison {
	state: "lower" | "higher" | "same" | "unavailable";
	label: string;
	detail: string;
	comparableRuns: number;
	successfulRuns: number;
	/** Recorded spend of the compared runs, and of every finished run. */
	coveredCost: number;
	finishedCost: number;
	plannerOnlyEstimate?: number;
	actualPrimaryCost?: number;
	difference?: number;
	percentage?: number;
}

export interface DashboardPeriod {
	label: string;
	finishedRuns: number;
	activeRuns: number;
	actualCost: number;
	comparison: DashboardComparison;
}

export interface DashboardSession {
	sessionId: string;
	title: string;
	status: string;
	statusTone: DashboardTone;
	lastUpdatedAt: string;
	actualCost: number;
	receipts: RunReceipt[];
	activeRuns: UnfinishedRunSummary[];
	comparison: DashboardComparison;
}

export interface AnalyticsDashboardModel {
	generatedAt: string;
	current: DashboardSession & {
		finishedRuns: number;
	};
	periods: DashboardPeriod[];
	recentSessions: DashboardSession[];
}

export interface DashboardRenderState {
	view: "overview" | "details" | "help";
	selectedIndex: number;
	refreshing?: boolean;
	refreshError?: string;
}

export function buildAnalyticsDashboardModel(overview: AnalyticsOverview): AnalyticsDashboardModel {
	const currentReceipts = overview.session.receipts;
	const currentUpdatedAt = newestTimestamp(
		[
			...currentReceipts.map((receipt) => receipt.completedAt ?? receipt.startedAt),
			...overview.session.unfinished.map((run) => run.startedAt),
		],
		overview.generatedAt,
	);
	const latestCurrentReceipt = currentReceipts[0];
	const currentStatus =
		overview.session.unfinished.length > 0
			? "Active"
			: latestCurrentReceipt === undefined
				? "No finished run"
				: outcomeLabel(latestCurrentReceipt.outcome);
	const current: AnalyticsDashboardModel["current"] = {
		sessionId: overview.sessionId,
		title: overview.sessionTitles?.get(overview.sessionId) ?? "Untitled session",
		status: currentStatus,
		statusTone:
			overview.session.unfinished.length > 0
				? "accent"
				: latestCurrentReceipt === undefined
					? "muted"
					: outcomeTone(latestCurrentReceipt.outcome),
		lastUpdatedAt: currentUpdatedAt,
		actualCost: overview.session.actualCost,
		receipts: currentReceipts,
		activeRuns: overview.session.unfinished,
		comparison: summarizeComparison(currentReceipts, overview.session.comparison),
		finishedRuns: overview.session.receiptCount,
	};

	const periods = [
		period("This week", overview.week),
		period("This month", overview.month),
		period("All time", overview.lifetime),
	];

	return {
		generatedAt: overview.generatedAt,
		current,
		periods,
		recentSessions: groupRecentSessions(overview).slice(0, RECENT_SESSION_LIMIT),
	};
}

export function summarizeComparison(
	receipts: readonly RunReceipt[],
	knownSummary = summarizeComparisons(receipts),
): DashboardComparison {
	const summary = knownSummary;
	if (summary.comparedRuns === 0) {
		return {
			state: "unavailable",
			label: unavailableLabel(receipts, summary),
			detail: unavailableDetail(receipts, summary),
			comparableRuns: 0,
			successfulRuns: summary.finishedRuns,
			coveredCost: summary.comparedActualCost,
			finishedCost: summary.finishedActualCost,
		};
	}

	const difference = summary.difference;
	const percentage =
		summary.plannerOnlyCost === 0 ? 0 : Math.abs((difference / summary.plannerOnlyCost) * 100);
	const evidence = comparisonDetail(summary);

	if (difference > 0) {
		return {
			state: "lower",
			label: `saved up to ${formatUsd(difference)}`,
			detail: evidence,
			comparableRuns: summary.comparedRuns,
			successfulRuns: summary.finishedRuns,
			coveredCost: summary.comparedActualCost,
			finishedCost: summary.finishedActualCost,
			plannerOnlyEstimate: summary.plannerOnlyCost,
			actualPrimaryCost: summary.actualPrimaryCost,
			difference,
			percentage,
		};
	}
	if (difference < 0) {
		return {
			state: "higher",
			label: `cost ${formatUsd(-difference)} extra`,
			detail: evidence,
			comparableRuns: summary.comparedRuns,
			successfulRuns: summary.finishedRuns,
			coveredCost: summary.comparedActualCost,
			finishedCost: summary.finishedActualCost,
			plannerOnlyEstimate: summary.plannerOnlyCost,
			actualPrimaryCost: summary.actualPrimaryCost,
			difference,
			percentage,
		};
	}
	return {
		state: "same",
		label: "No difference",
		detail: evidence,
		comparableRuns: summary.comparedRuns,
		successfulRuns: summary.finishedRuns,
		coveredCost: summary.comparedActualCost,
		finishedCost: summary.finishedActualCost,
		plannerOnlyEstimate: summary.plannerOnlyCost,
		actualPrimaryCost: summary.actualPrimaryCost,
		difference,
		percentage,
	};
}

function unavailableLabel(
	receipts: readonly RunReceipt[],
	summary: ReturnType<typeof summarizeComparisons>,
): string {
	if (summary.finishedRuns === 0) {
		if (receipts.length === 0) return "Nothing to compare yet";
		const outcomes = new Set(receipts.map((receipt) => receipt.outcome));
		if (outcomes.size === 1)
			return `${outcomeLabel(receipts[0]?.outcome ?? "unfinished")}, so not compared`;
		return "Nothing finished to compare";
	}
	if (summary.noHandoffRuns > 0 && summary.unavailableRuns === 0) return "Never switched models";
	if (summary.unavailableRuns > 0 && onlyPricingProblems(summary)) return "No price data";
	if (summary.unavailableRuns > 0 && onlyUsageProblems(summary)) return "No usage data";
	return "Can\u2019t compare";
}

export function renderAnalyticsDashboard(
	model: AnalyticsDashboardModel,
	state: DashboardRenderState,
	width: number,
	palette: DashboardPalette,
): string[] {
	const frameWidth = Math.max(6, width);
	const innerWidth = frameWidth - 4;
	const content =
		state.view === "help"
			? renderHelp(model, innerWidth, palette)
			: state.view === "details"
				? renderDetails(model, state, innerWidth, palette)
				: renderOverview(model, state, innerWidth, palette);
	const title =
		state.view === "help"
			? "What these numbers mean"
			: state.view === "details"
				? "Session details"
				: "Prewalk usage";
	return frame(title, content, frameWidth, palette);
}

export async function showAnalyticsDashboard(
	ctx: ExtensionContext,
	initialOverview: AnalyticsOverview,
	refreshOverview: () => Promise<AnalyticsOverview>,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const dashboard = new AnalyticsDashboardComponent(
			tui,
			theme,
			buildAnalyticsDashboardModel(initialOverview),
			async () => buildAnalyticsDashboardModel(await refreshOverview()),
			() => done(undefined),
		);
		dashboard.startAutoRefresh();
		return dashboard;
	});
}

class AnalyticsDashboardComponent implements Component {
	private model: AnalyticsDashboardModel;
	private state: DashboardRenderState = { view: "overview", selectedIndex: 0 };
	private timer: ReturnType<typeof setInterval> | undefined;
	private closed = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		model: AnalyticsDashboardModel,
		private readonly load: () => Promise<AnalyticsDashboardModel>,
		private readonly onClose: () => void,
	) {
		this.model = model;
	}

	startAutoRefresh(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.refresh(), AUTO_REFRESH_MS);
		this.timer.unref?.();
	}

	render(width: number): string[] {
		return renderAnalyticsDashboard(this.model, this.state, width, paletteFromTheme(this.theme));
	}

	invalidate(): void {}

	dispose(): void {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.state.view !== "overview") {
				this.state = { ...this.state, view: "overview" };
				this.tui.requestRender();
				return;
			}
			this.close();
			return;
		}
		if (data === "?" || data === "h") {
			this.state = { ...this.state, view: this.state.view === "help" ? "overview" : "help" };
			this.tui.requestRender();
			return;
		}
		if (data === "r" || data === "R") {
			void this.refresh();
			return;
		}
		if (this.state.view !== "overview") return;
		const rowCount = 1 + this.model.recentSessions.length;
		if (matchesKey(data, "up")) {
			this.state = {
				...this.state,
				selectedIndex: (this.state.selectedIndex - 1 + rowCount) % rowCount,
			};
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.state = { ...this.state, selectedIndex: (this.state.selectedIndex + 1) % rowCount };
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "enter")) {
			this.state = { ...this.state, view: "details" };
			this.tui.requestRender();
		}
	}

	private async refresh(): Promise<void> {
		if (this.closed || this.state.refreshing) return;
		this.state = { ...this.state, refreshing: true, refreshError: undefined };
		this.tui.requestRender();
		try {
			this.model = await this.load();
			const maxIndex = this.model.recentSessions.length;
			this.state = {
				...this.state,
				selectedIndex: Math.min(this.state.selectedIndex, maxIndex),
				refreshing: false,
			};
		} catch (error) {
			this.state = {
				...this.state,
				refreshing: false,
				refreshError: error instanceof Error ? error.message : String(error),
			};
		}
		if (!this.closed) this.tui.requestRender();
	}

	private close(): void {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.onClose();
	}
}

function renderOverview(
	model: AnalyticsDashboardModel,
	state: DashboardRenderState,
	width: number,
	palette: DashboardPalette,
): string[] {
	const lines: string[] = [];
	const updated = `Updated ${formatUpdated(model.generatedAt)}`;
	lines.push(
		joinSides(
			palette.bold(
				truncateToWidth(model.current.title, Math.max(10, width - updated.length - 3)),
			),
			palette.color(
				state.refreshing ? "accent" : "dim",
				state.refreshing ? "Refreshing…" : updated,
			),
			width,
		),
	);
	if (state.refreshError)
		lines.push(palette.color("error", `Refresh failed: ${state.refreshError}`));
	lines.push(sectionLabel("Current session", palette));
	lines.push(...renderCurrent(model, state.selectedIndex === 0, width, palette));
	lines.push(separator(width, palette));
	lines.push(sectionLabel("History", palette));
	lines.push(...renderPeriods(model.periods, width, palette));
	lines.push(separator(width, palette));
	lines.push(sectionLabel("Recent sessions", palette));
	lines.push(...renderRecent(model, state.selectedIndex, width, palette));
	lines.push(
		palette.color(
			"dim",
			width >= 76
				? "↑↓ Select   Enter Details   ? What this means   R Refresh   Esc Close"
				: "↑↓ Select · Enter Details · ? Help · R Refresh · Esc Close",
		),
	);
	return lines;
}

function renderCurrent(
	model: AnalyticsDashboardModel,
	selected: boolean,
	width: number,
	palette: DashboardPalette,
): string[] {
	const current = model.current;
	// The headline states the situation; the detail line below already names the
	// specific reason, so repeating it here reads as a failure rather than a
	// session that simply has nothing comparable in it yet.
	const estimate =
		current.comparison.state === "unavailable"
			? palette.color("muted", "Not enough data yet")
			: colorComparison(current.comparison, palette);
	const prefix = selected ? palette.color("accent", "›") : " ";
	if (width < 76) {
		return [
			`${prefix} ${palette.bold(current.title)}`,
			`  Spent ${palette.bold(formatUsd(current.actualCost))} · ${current.activeRuns.length} running · ${current.finishedRuns} done`,
			`  Saved by switching: ${estimate}`,
			...(current.activeRuns.length === 0
				? []
				: [
						`  Active now: ${current.activeRuns.map((run) => `${run.runId} ${formatUsd(run.actualCost)}`).join(", ")}`,
					]),
			`  ${palette.color("dim", current.comparison.detail)}`,
			"  This session only. Use /prewalk stats task to include work it handed to other agents.",
		];
	}
	const metricWidth = Math.floor((width - 6) / 3);
	return [
		`${prefix} ${cell("SPENT", metricWidth, "left", (text) => palette.color("dim", text))}  ${cell("RUNS", metricWidth, "left", (text) => palette.color("dim", text))}  ${cell("SAVED BY SWITCHING", metricWidth, "left", (text) => palette.color("dim", text))}`,
		`  ${cell(formatUsd(current.actualCost), metricWidth, "left", palette.bold)}  ${cell(`${current.finishedRuns} done · ${current.activeRuns.length} running`, metricWidth, "left")}  ${cell(estimate, metricWidth, "left")}`,
		...(current.activeRuns.length === 0
			? []
			: [
					`  Active now: ${current.activeRuns.map((run) => `${run.runId} ${formatUsd(run.actualCost)}`).join(", ")}`,
				]),
		`  ${palette.color("dim", current.comparison.detail)}`,
		"  This session only. Use /prewalk stats task to include work it handed to other agents.",
	];
}

function renderPeriods(
	periods: readonly DashboardPeriod[],
	width: number,
	palette: DashboardPalette,
): string[] {
	if (width < 96) {
		return periods.flatMap((item) => [
			`${palette.bold(item.label)} · ${item.finishedRuns} done · ${item.activeRuns} running · ${formatUsd(item.actualCost)} spent`,
			`  ${colorComparison(item.comparison, palette)} · ${palette.color("dim", item.comparison.detail)}`,
		]);
	}
	const periodWidth = 10;
	const runsWidth = 9;
	const activeWidth = 7;
	const actualWidth = 14;
	const coveredWidth = 24;
	const differenceWidth = Math.max(
		22,
		width - periodWidth - runsWidth - activeWidth - actualWidth - coveredWidth - 14,
	);
	const header = [
		cell("PERIOD", periodWidth, "left"),
		cell("DONE", runsWidth, "right"),
		cell("RUNNING", activeWidth, "right"),
		cell("SPENT", actualWidth, "right"),
		cell("COMPARED", coveredWidth, "right"),
		cell("SAVED BY SWITCHING", differenceWidth, "right"),
	].join("  ");
	return [
		palette.color("dim", header),
		...periods.map((item) =>
			[
				cell(item.label, periodWidth, "left", palette.bold),
				cell(String(item.finishedRuns), runsWidth, "right"),
				cell(String(item.activeRuns), activeWidth, "right"),
				cell(formatUsd(item.actualCost), actualWidth, "right"),
				cell(coveredLabel(item.comparison), coveredWidth, "right", (text) =>
					palette.color("dim", text),
				),
				cell(compactDifference(item.comparison), differenceWidth, "right", (text) =>
					comparisonTone(item.comparison, palette, text),
				),
			].join("  "),
		),
	];
}

function renderRecent(
	model: AnalyticsDashboardModel,
	selectedIndex: number,
	width: number,
	palette: DashboardPalette,
): string[] {
	if (model.recentSessions.length === 0) return [palette.color("muted", "No other sessions yet.")];
	if (width < 88) {
		return model.recentSessions.flatMap((session, index) => {
			const selected = selectedIndex === index + 1;
			const prefix = selected ? palette.color("accent", "›") : " ";
			return [
				`${prefix} ${selected ? palette.color("accent", session.title) : session.title}`,
				`  ${colorStatus(session, palette)} · ${formatUsd(session.actualCost)} · ${colorComparison(session.comparison, palette)}`,
			];
		});
	}
	const titleWidth = Math.max(24, width - 55);
	const statusWidth = 12;
	const actualWidth = 13;
	const estimateWidth = 22;
	const header = `  ${cell("SESSION", titleWidth, "left")}  ${cell("STATUS", statusWidth, "left")}  ${cell("SPENT", actualWidth, "right")}  ${cell("SAVED BY SWITCHING", estimateWidth, "right")}`;
	// Repeating the same unavailability on every row reads as a broken tool.
	// Rows stay quiet and one line below the table carries the reason.
	const uncomparable = model.recentSessions.filter(
		(session) => session.comparison.state === "unavailable",
	);
	return [
		palette.color("dim", header),
		...model.recentSessions.map((session, index) => {
			const selected = selectedIndex === index + 1;
			const prefix = selected ? palette.color("accent", "›") : " ";
			const title = selected ? palette.color("accent", session.title) : session.title;
			const estimate =
				session.comparison.state === "unavailable"
					? palette.color("dim", "—")
					: colorComparison(session.comparison, palette);
			return `${prefix} ${cell(title, titleWidth, "left")}  ${cell(colorStatus(session, palette), statusWidth, "left")}  ${cell(formatUsd(session.actualCost), actualWidth, "right")}  ${cell(estimate, estimateWidth, "right")}`;
		}),
		...(uncomparable.length === 0
			? []
			: [
					palette.color(
						"dim",
						`  — ${uncomparable.length} of ${model.recentSessions.length} ${plural(model.recentSessions.length, "session")} could not be compared. Select one to see why.`,
					),
				]),
	];
}

function renderDetails(
	model: AnalyticsDashboardModel,
	state: DashboardRenderState,
	width: number,
	palette: DashboardPalette,
): string[] {
	const session = selectedSession(model, state.selectedIndex);
	const comparison = session.comparison;
	const lines = [
		palette.bold(session.title),
		palette.color("dim", session.sessionId),
		"",
		`${palette.color("muted", "Status")}              ${colorStatus(session, palette)}`,
		`${palette.color("muted", "Spent")}               ${palette.bold(formatUsd(session.actualCost))}`,
		`${palette.color("muted", "Runs")}                ${session.receipts.length} done, ${session.activeRuns.length} running`,
		`${palette.color("muted", "Saved by switching")}  ${colorComparison(comparison, palette)}`,
		`${palette.color("muted", "What was compared")}   ${comparison.detail}`,
	];
	if (comparison.state !== "unavailable") {
		lines.push(
			"",
			sectionLabel("How that was worked out", palette),
			`If you had never switched   ${formatUsd(comparison.plannerOnlyEstimate ?? 0)}`,
			`What you actually paid      ${formatUsd(comparison.actualPrimaryCost ?? 0)}`,
			`Difference                  ${formatSignedDifference(comparison)}`,
			palette.color(
				"dim",
				"Spent above also counts background calls. This comparison only counts the main ones.",
			),
		);
	}
	lines.push(
		"",
		palette.color(
			"warning",
			"Nothing was run twice. We took the work the second model did and priced it as if the first",
		),
		palette.color(
			"warning",
			"model had done it, so treat this as a ceiling rather than a measurement.",
		),
		"",
		palette.color(
			"dim",
			width >= 65 ? "? What this means   R Refresh   Esc Back" : "? Help · R Refresh · Esc Back",
		),
	);
	return lines;
}

function renderHelp(
	model: AnalyticsDashboardModel,
	_width: number,
	palette: DashboardPalette,
): string[] {
	return [
		palette.bold("What these numbers mean"),
		"",
		palette.color("accent", "What this tool does"),
		"It starts a task on one model, then switches to a cheaper one to finish the work.",
		"These numbers ask a single question: did switching actually cost you less?",
		"",
		palette.color("accent", "Spent"),
		"What you actually paid, from the provider's own numbers. Every run counts here,",
		"including ones that never switched and ones we could not compare.",
		"",
		palette.color("accent", "Saved by switching"),
		"How much less you paid than if one model had done the whole task.",
		"We take the work the cheaper model did and price it at the first model's rates.",
		"A negative number means switching cost you more.",
		"",
		palette.color("accent", "Compared"),
		"How much of your spending the savings number is actually based on.",
		"Some runs cannot be compared, so this is usually smaller than Spent.",
		"Judge the savings against this figure, not against everything you spent.",
		"",
		palette.color("accent", "Why a run might not be compared"),
		"It never switched models, it stopped early, or we have no price data for it.",
		"Those runs still cost real money, so they stay in Spent.",
		"",
		palette.color(
			"warning",
			"Nothing was ever run twice, so this is a ceiling, not a measurement. A cheaper model",
		),
		palette.color(
			"warning",
			"often needs more turns, and every extra turn gets priced at the pricier rate.",
		),
		palette.color("dim", `Snapshot ${formatUpdated(model.generatedAt)} · R Refresh · Esc Back`),
	];
}

function frame(
	title: string,
	content: readonly string[],
	width: number,
	palette: DashboardPalette,
): string[] {
	const safeWidth = Math.max(6, width);
	const titleText = truncateToWidth(`─ ${title} `, Math.max(1, safeWidth - 2), "…");
	const top = `╭${titleText}${"─".repeat(Math.max(0, safeWidth - visibleWidth(titleText) - 2))}╮`;
	const bottom = `╰${"─".repeat(Math.max(0, safeWidth - 2))}╯`;
	return [
		palette.color("accent", top),
		...content.map(
			(line) =>
				`${palette.color("accent", "│")} ${truncateToWidth(line, safeWidth - 4, "…", true)} ${palette.color("accent", "│")}`,
		),
		palette.color("accent", bottom),
	];
}

function period(label: string, aggregate: AnalyticsAggregate): DashboardPeriod {
	return {
		label,
		finishedRuns: aggregate.receiptCount,
		activeRuns: aggregate.unfinished.length,
		actualCost: aggregate.actualCost,
		comparison: summarizeComparison(aggregate.receipts, aggregate.comparison),
	};
}

function groupRecentSessions(overview: AnalyticsOverview): DashboardSession[] {
	const grouped = new Map<
		string,
		{ receipts: RunReceipt[]; unfinished: AnalyticsAggregate["unfinished"] }
	>();
	for (const receipt of overview.lifetime.receipts) {
		if (receipt.sessionId === overview.sessionId) continue;
		const group = grouped.get(receipt.sessionId) ?? { receipts: [], unfinished: [] };
		group.receipts.push(receipt);
		grouped.set(receipt.sessionId, group);
	}
	for (const run of overview.lifetime.unfinished) {
		if (run.sessionId === overview.sessionId) continue;
		const group = grouped.get(run.sessionId) ?? { receipts: [], unfinished: [] };
		group.unfinished.push(run);
		grouped.set(run.sessionId, group);
	}
	return [...grouped.entries()]
		.map(([sessionId, group]) => {
			const receipts = [...group.receipts].sort(compareReceiptNewestFirst);
			const latest = receipts[0];
			const latestUnfinished = [...group.unfinished].sort((left, right) =>
				right.startedAt.localeCompare(left.startedAt),
			)[0];
			const outcome = latestUnfinished ? "unfinished" : (latest?.outcome ?? "unfinished");
			const lastUpdatedAt = newestTimestamp(
				[
					...receipts.map((receipt) => receipt.completedAt ?? receipt.startedAt),
					...group.unfinished.map((run) => run.startedAt),
				],
				overview.generatedAt,
			);
			return {
				sessionId,
				title: overview.sessionTitles?.get(sessionId) ?? "Untitled session",
				status: outcomeLabel(outcome),
				statusTone: outcomeTone(outcome),
				lastUpdatedAt,
				actualCost:
					receipts.reduce((total, receipt) => total + receipt.actualCost, 0) +
					group.unfinished.reduce((total, run) => total + run.actualCost, 0),
				receipts,
				activeRuns: group.unfinished,
				comparison: summarizeComparison(receipts),
			};
		})
		.sort((left, right) => right.lastUpdatedAt.localeCompare(left.lastUpdatedAt));
}

function unavailableDetail(
	receipts: readonly RunReceipt[],
	summary: ReturnType<typeof summarizeComparisons>,
): string {
	if (summary.finishedRuns === 0) {
		if (receipts.length === 0) return "No finished runs yet.";
		const outcomes = new Map<string, number>();
		for (const receipt of receipts) {
			const label = outcomeLabel(receipt.outcome).toLowerCase();
			outcomes.set(label, (outcomes.get(label) ?? 0) + 1);
		}
		const details = [...outcomes.entries()].map(
			([label, count]) => `${count} ${label} ${plural(count, "run")}`,
		);
		return `${details.join("; ")}, so nothing was compared.`;
	}
	if (summary.noHandoffRuns > 0 && summary.unavailableRuns === 0) {
		return `${summary.noHandoffRuns} ${plural(summary.noHandoffRuns, "run")} ended before switching models.`;
	}
	const unavailable = unavailableSummary(summary);
	return unavailable.length > 0 ? `${unavailable}.` : "Nothing could be compared.";
}

/**
 * Shows the recorded spend the estimate is built from. Without it a small
 * difference beside a large recorded total reads as a poor result rather than
 * as narrow coverage.
 */
/**
 * Compact difference for the period table, where the full sentence cannot fit
 * and gets truncated into meaninglessness.
 */
function compactDifference(comparison: DashboardComparison): string {
	if (comparison.state === "unavailable") return "no comparison";
	if (comparison.state === "same") return "no difference";
	const amount = formatUsd(Math.abs(comparison.difference ?? 0));
	const share =
		comparison.percentage === undefined ? "" : ` (${comparison.percentage.toFixed(0)}%)`;
	return comparison.state === "higher" ? `${amount} extra${share}` : `up to ${amount}${share}`;
}

function coveredLabel(comparison: DashboardComparison): string {
	if (comparison.finishedCost <= 0) return "nothing finished yet";
	const share = (comparison.coveredCost / comparison.finishedCost) * 100;
	return `${formatUsd(comparison.coveredCost)} of ${formatUsd(comparison.finishedCost)} (${share.toFixed(0)}%)`;
}

function comparisonDetail(summary: ReturnType<typeof summarizeComparisons>): string {
	// Coverage has its own column, so the detail stays short enough to survive
	// the width the table can actually give it.
	const parts = [`${summary.comparedRuns} ${plural(summary.comparedRuns, "run")} compared`];
	if (summary.noHandoffRuns > 0) {
		parts.push(`${summary.noHandoffRuns} ${plural(summary.noHandoffRuns, "run")} never switched`);
	}
	if (summary.unavailableRuns > 0) parts.push(unavailableSummary(summary));
	return `${parts.join(". ")}.`;
}

function unavailableSummary(summary: ReturnType<typeof summarizeComparisons>): string {
	const details = Object.entries(summary.unavailableReasons).map(([reason, count]) =>
		[`${count} ${plural(count ?? 0, "run")}`, unavailableReasonLabel(reason)].join(" "),
	);
	return details.join("; ");
}

function onlyPricingProblems(summary: ReturnType<typeof summarizeComparisons>): boolean {
	return Object.keys(summary.unavailableReasons).every((reason) =>
		["pricing-missing", "pricing-incomplete", "pricing-zero"].includes(reason),
	);
}

function onlyUsageProblems(summary: ReturnType<typeof summarizeComparisons>): boolean {
	return Object.keys(summary.unavailableReasons).every((reason) => reason === "usage-incomplete");
}

function unavailableReasonLabel(reason: string): string {
	if (reason === "pricing-missing") return "with no price data";
	if (reason === "pricing-incomplete") return "with only partial price data";
	if (reason === "pricing-zero") return "with a price of zero";
	if (reason === "usage-incomplete") return "with no work recorded after the switch";
	if (reason === "analytics-disabled") return "recorded while tracking was off";
	if (reason === "unfinished-run") return "still running";
	return "stopped early";
}

function selectedSession(model: AnalyticsDashboardModel, selectedIndex: number): DashboardSession {
	return selectedIndex === 0
		? model.current
		: (model.recentSessions[selectedIndex - 1] ?? model.current);
}

function colorComparison(comparison: DashboardComparison, palette: DashboardPalette): string {
	if (comparison.state === "lower") return palette.color("success", comparison.label);
	if (comparison.state === "higher") return palette.color("error", comparison.label);
	if (comparison.state === "same") return palette.color("muted", comparison.label);
	return palette.color("warning", comparison.label);
}

/** Applies the comparison's tone to arbitrary text, not just its full label. */
function comparisonTone(
	comparison: DashboardComparison,
	palette: DashboardPalette,
	text: string,
): string {
	if (comparison.state === "lower") return palette.color("success", text);
	if (comparison.state === "higher") return palette.color("error", text);
	if (comparison.state === "same") return palette.color("muted", text);
	return palette.color("warning", text);
}

function colorStatus(session: DashboardSession, palette: DashboardPalette): string {
	return palette.color(session.statusTone, session.status);
}

function outcomeLabel(outcome: RunOutcome): string {
	if (outcome === "succeeded") return "Complete";
	if (outcome === "failed") return "Failed";
	if (outcome === "cancelled") return "Cancelled";
	if (outcome === "released") return "Released";
	if (outcome === "session-ended") return "Session ended";
	if (outcome === "interrupted") return "Interrupted";
	if (outcome === "active" || outcome === "unfinished") return "Active";
	return outcome;
}

function outcomeTone(outcome: RunOutcome): DashboardTone {
	if (outcome === "succeeded") return "success";
	if (outcome === "failed") return "error";
	if (outcome === "cancelled" || outcome === "interrupted") return "warning";
	if (outcome === "active" || outcome === "unfinished") return "accent";
	return "muted";
}

function formatSignedDifference(comparison: DashboardComparison): string {
	if (comparison.difference === undefined) return "Unavailable";
	const amount = comparison.difference;
	const percent = comparison.percentage?.toFixed(1) ?? "0.0";
	if (amount > 0) return `saved up to ${formatUsd(amount)} (${percent}%)`;
	if (amount < 0) return `cost ${formatUsd(-amount)} extra (${percent}%)`;
	return "No cost difference (0.0%)";
}

function formatUsd(value: number): string {
	if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

function formatUpdated(timestamp: string): string {
	const match = timestamp.match(/^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})/);
	return match?.[1] ? `${match[1]} UTC` : timestamp;
}

function compareReceiptNewestFirst(left: RunReceipt, right: RunReceipt): number {
	return (right.completedAt ?? right.startedAt).localeCompare(left.completedAt ?? left.startedAt);
}

function newestTimestamp(timestamps: readonly string[], fallback: string): string {
	return [...timestamps].sort((left, right) => right.localeCompare(left))[0] ?? fallback;
}

function sectionLabel(label: string, palette: DashboardPalette): string {
	return palette.color("accent", palette.bold(label.toUpperCase()));
}

function separator(width: number, palette: DashboardPalette): string {
	return palette.color("dim", "─".repeat(Math.max(1, width)));
}

function joinSides(left: string, right: string, width: number): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return `${left}${" ".repeat(gap)}${right}`;
}

function cell(
	text: string,
	width: number,
	align: "left" | "right",
	style: (value: string) => string = (value) => value,
): string {
	const truncated = truncateToWidth(text, width, "…");
	const padding = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	return style(align === "right" ? `${padding}${truncated}` : `${truncated}${padding}`);
}

function plural(count: number, singular: string): string {
	return count === 1 ? singular : `${singular}s`;
}

function paletteFromTheme(theme: Theme): DashboardPalette {
	return {
		color: (tone, text) => theme.fg(tone, text),
		bold: (text) => theme.bold(text),
	};
}
