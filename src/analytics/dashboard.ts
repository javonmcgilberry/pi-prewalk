import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	type HandoffState,
	type ModelIdentity,
	type RunOutcome,
	type RunReceipt,
	summarizeComparisons,
} from "./index.js";
import type { AnalyticsOverview } from "./report.js";
import type { AnalyticsAggregate, UnfinishedRunSummary } from "./store.js";

/** Live poll while the current session has an unfinished Prewalk run. Idle dashboards do not auto-poll. */
const ACTIVE_REFRESH_MS = 5_000;
const RECENT_SESSION_LIMIT = 4;
const HISTORY_PAGE_SIZE = 8;
const DETAIL_RUN_LIMIT = 6;
const SAVINGS_HEADER_FULL = "EST. SAVINGS FROM MODEL SWITCHING";
const SAVINGS_HEADER_SHORT = "EST. SAVINGS";
/** Wide overview/history tables share one grid so COST/savings columns line up. */
const WIDE_TABLE_MIN = 88;
type DashboardKeybindings = Pick<KeybindingsManager, "matches">;

interface SharedMetricLayout {
	leadingWidth: number;
	statusWidth: number;
	costWidth: number;
	savingsWidth: number;
}

type DashboardTone = "accent" | "success" | "warning" | "error" | "muted" | "dim";

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

interface DashboardPeriod {
	label: string;
	finishedRuns: number;
	activeRuns: number;
	actualCost: number;
	comparison: DashboardComparison;
}

interface DashboardSession {
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
	sessionHistory: DashboardSession[];
}

export interface DashboardRenderState {
	view: "overview" | "history" | "details" | "help";
	selectedIndex: number;
	historySelectedIndex?: number;
	selectedSessionId?: string;
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
	let currentStatus = "No finished run";
	let currentStatusTone: DashboardTone = "muted";
	if (overview.session.unfinished.length > 0) {
		currentStatus = "Active";
		currentStatusTone = "accent";
	} else if (latestCurrentReceipt !== undefined) {
		currentStatus = outcomeLabel(latestCurrentReceipt.outcome);
		currentStatusTone = outcomeTone(latestCurrentReceipt.outcome);
	}
	const current: AnalyticsDashboardModel["current"] = {
		sessionId: overview.sessionId,
		title: overview.sessionTitles?.get(overview.sessionId) ?? "Untitled session",
		status: currentStatus,
		statusTone: currentStatusTone,
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

	const sessionHistory = groupRecentSessions(overview);
	return {
		generatedAt: overview.generatedAt,
		current,
		periods,
		recentSessions: sessionHistory.slice(0, RECENT_SESSION_LIMIT),
		sessionHistory,
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
			label: `up to ${formatUsd(difference)} saved`,
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
			label: `${formatUsd(-difference)} extra`,
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
		label: "About the same",
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
	let viewContent: string[];
	let title: string;
	switch (state.view) {
		case "help":
			viewContent = renderHelp(innerWidth, palette);
			title = "How to read this dashboard";
			break;
		case "details":
			viewContent = renderDetails(model, state, innerWidth, palette);
			title = "Session details";
			break;
		case "history":
			viewContent = renderHistory(model, state, innerWidth, palette);
			title = "All logged sessions";
			break;
		default:
			viewContent = renderOverview(model, state, innerWidth, palette);
			title = "Prewalk usage";
	}
	const content =
		state.view === "overview"
			? viewContent
			: [...renderSnapshotStatus(model, state, innerWidth, palette), ...viewContent];
	return frame(title, content, frameWidth, palette);
}

function renderSnapshotStatus(
	model: AnalyticsDashboardModel,
	state: DashboardRenderState,
	width: number,
	palette: DashboardPalette,
): string[] {
	let text = `Updated ${formatUpdated(model.generatedAt)}`;
	let tone: DashboardTone = "dim";
	if (state.refreshError) {
		text = `Refresh failed: ${state.refreshError}`;
		tone = "error";
	} else if (state.refreshing) {
		text = "Refreshing…";
		tone = "accent";
	}
	return [...wrapTextWithAnsi(text, width).map((line) => palette.color(tone, line)), ""];
}

export async function showAnalyticsDashboard(
	ctx: ExtensionContext,
	initialOverview: AnalyticsOverview,
	refreshOverview: () => Promise<AnalyticsOverview>,
	options?: {
		/** Fill in session titles after first paint without blocking open. */
		enrichTitles?: () => Promise<AnalyticsOverview>;
	},
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const dashboard = new AnalyticsDashboardComponent({
			tui,
			keybindings,
			theme,
			model: buildAnalyticsDashboardModel(initialOverview),
			load: async () => buildAnalyticsDashboardModel(await refreshOverview()),
			onClose: () => done(undefined),
		});
		dashboard.startAutoRefresh();
		if (options?.enrichTitles) {
			void dashboard.enrichTitles(async () =>
				buildAnalyticsDashboardModel(await options.enrichTitles!()),
			);
		}
		return dashboard;
	});
}

interface AnalyticsDashboardComponentOptions {
	tui: TUI;
	theme: Theme;
	keybindings: DashboardKeybindings;
	model: AnalyticsDashboardModel;
	load(): Promise<AnalyticsDashboardModel>;
	onClose(): void;
}

class AnalyticsDashboardComponent implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: DashboardKeybindings;
	private readonly load: () => Promise<AnalyticsDashboardModel>;
	private readonly onClose: () => void;
	private model: AnalyticsDashboardModel;
	private state: DashboardRenderState = {
		view: "overview",
		selectedIndex: 0,
		historySelectedIndex: 0,
	};
	private detailsReturnView: "overview" | "history" = "overview";
	private helpReturnView: "overview" | "history" | "details" = "overview";
	private timer: ReturnType<typeof setInterval> | undefined;
	private closed = false;

	constructor(options: AnalyticsDashboardComponentOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.model = options.model;
		this.load = options.load;
		this.onClose = options.onClose;
	}

	startAutoRefresh(): void {
		this.syncAutoRefresh();
	}

	/** Quiet title backfill — does not flip the refreshing banner. */
	async enrichTitles(load: () => Promise<AnalyticsDashboardModel>): Promise<void> {
		if (this.closed) return;
		try {
			const model = await load();
			if (this.closed) return;
			this.model = model;
			this.syncAutoRefresh();
			this.tui.requestRender();
		} catch {
			// Titles are cosmetic; keep the already-open cost view.
		}
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
		if (this.closed) return;
		if (this.state.view === "help") {
			if (
				data === "?" ||
				this.keybindings.matches(data, "tui.select.cancel") ||
				this.keybindings.matches(data, "tui.select.confirm")
			) {
				this.state = { ...this.state, view: this.helpReturnView };
				this.tui.requestRender();
			}
			return;
		}
		if (data === "?") {
			this.helpReturnView = this.state.view;
			this.state = { ...this.state, view: "help" };
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			if (this.state.view === "details") {
				this.state = { ...this.state, view: this.detailsReturnView };
				this.tui.requestRender();
				return;
			}
			if (this.state.view === "history") {
				this.state = { ...this.state, view: "overview" };
				this.tui.requestRender();
				return;
			}
			this.close();
			return;
		}
		if (data === "r" || data === "R") {
			void this.refresh({ quiet: false });
			return;
		}
		if (this.state.view === "overview") {
			this.handleOverviewInput(data);
			return;
		}
		if (this.state.view === "history") this.handleHistoryInput(data);
	}

	private handleOverviewInput(data: string): void {
		const rowCount = overviewRowCount(this.model);
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveOverviewSelection(-1, true, rowCount);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveOverviewSelection(1, true, rowCount);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.moveOverviewSelection(-HISTORY_PAGE_SIZE, false, rowCount);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.moveOverviewSelection(HISTORY_PAGE_SIZE, false, rowCount);
			return;
		}
		if (!this.keybindings.matches(data, "tui.select.confirm")) return;
		if (isSeeMoreSelection(this.model, this.state.selectedIndex)) {
			this.state = { ...this.state, view: "history" };
			this.tui.requestRender();
			return;
		}
		const session = overviewSessionAt(this.model, this.state.selectedIndex);
		if (!session) return;
		this.detailsReturnView = "overview";
		this.state = { ...this.state, view: "details", selectedSessionId: session.sessionId };
		this.tui.requestRender();
	}

	private handleHistoryInput(data: string): void {
		const rowCount = this.model.sessionHistory.length;
		if (rowCount === 0) return;
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveHistorySelection(-1, true, rowCount);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveHistorySelection(1, true, rowCount);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.moveHistorySelection(-HISTORY_PAGE_SIZE, false, rowCount);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.moveHistorySelection(HISTORY_PAGE_SIZE, false, rowCount);
			return;
		}
		if (!this.keybindings.matches(data, "tui.select.confirm")) return;
		const selectedIndex = this.state.historySelectedIndex ?? 0;
		const session = this.model.sessionHistory[selectedIndex];
		if (!session) return;
		this.detailsReturnView = "history";
		this.state = { ...this.state, view: "details", selectedSessionId: session.sessionId };
		this.tui.requestRender();
	}

	private moveOverviewSelection(delta: number, wrap: boolean, rowCount: number): void {
		if (rowCount <= 0) return;
		const selectedIndex = movedIndex(this.state.selectedIndex, delta, rowCount, wrap);
		this.state = { ...this.state, selectedIndex };
		this.tui.requestRender();
	}

	private moveHistorySelection(delta: number, wrap: boolean, rowCount: number): void {
		const selectedIndex = movedIndex(this.state.historySelectedIndex ?? 0, delta, rowCount, wrap);
		this.state = { ...this.state, historySelectedIndex: selectedIndex };
		this.tui.requestRender();
	}

	/**
	 * Reload ledger data.
	 * - Manual R: show the Refreshing… banner.
	 * - Quiet auto ticks: update only when live numbers change; never flash the banner.
	 */
	private async refresh(options: { quiet?: boolean } = {}): Promise<void> {
		const quiet = options.quiet === true;
		if (this.closed || this.state.refreshing) return;
		const overviewKey = overviewSelectionKey(this.model, this.state.selectedIndex);
		const historySessionId =
			this.model.sessionHistory[this.state.historySelectedIndex ?? 0]?.sessionId;
		const previousFingerprint = liveFingerprint(this.model);
		if (!quiet) {
			this.state = { ...this.state, refreshing: true, refreshError: undefined };
			this.tui.requestRender();
		}
		try {
			const model = await this.load();
			if (this.closed) return;
			const unchanged = quiet && liveFingerprint(model) === previousFingerprint;
			if (!unchanged) {
				this.model = model;
				this.state = {
					...this.state,
					selectedIndex: overviewIndexForKey(this.model, overviewKey),
					historySelectedIndex: historyIndexForSession(this.model, historySessionId),
					refreshing: false,
					refreshError: undefined,
				};
			} else if (this.state.refreshError || this.state.refreshing) {
				this.state = { ...this.state, refreshing: false, refreshError: undefined };
				if (!this.closed) this.tui.requestRender();
			}
			this.syncAutoRefresh();
			if (!unchanged && !this.closed) this.tui.requestRender();
		} catch (error) {
			if (this.closed) return;
			this.state = {
				...this.state,
				refreshing: false,
				refreshError: error instanceof Error ? error.message : String(error),
			};
			if (!this.closed) this.tui.requestRender();
		}
	}

	/** Poll only while this session has an unfinished run; stop when idle. */
	private syncAutoRefresh(): void {
		const needsLive = this.model.current.activeRuns.length > 0;
		if (!needsLive) {
			if (this.timer) {
				clearInterval(this.timer);
				this.timer = undefined;
			}
			return;
		}
		if (this.timer) return;
		this.timer = setInterval(() => void this.refresh({ quiet: true }), ACTIVE_REFRESH_MS);
		this.timer.unref?.();
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.onClose();
	}
}

/** Compare cost/activity only — ignores generatedAt so quiet polls can skip no-op renders. */
function liveFingerprint(model: AnalyticsDashboardModel): string {
	return JSON.stringify({
		currentCost: model.current.actualCost,
		currentFinished: model.current.finishedRuns,
		currentStatus: model.current.status,
		active: model.current.activeRuns.map((run) => [
			run.runId,
			run.epoch,
			run.actualCost,
			run.handoffState,
		]),
		periods: model.periods.map((period) => [
			period.label,
			period.actualCost,
			period.finishedRuns,
			period.activeRuns,
			period.comparison.state,
			period.comparison.difference ?? null,
		]),
		recent: model.recentSessions.map((session) => [
			session.sessionId,
			session.actualCost,
			session.status,
			session.activeRuns.length,
		]),
	});
}

function renderOverview(
	model: AnalyticsDashboardModel,
	state: DashboardRenderState,
	width: number,
	palette: DashboardPalette,
): string[] {
	const lines: string[] = [];
	const updated = `Updated ${formatUpdated(model.generatedAt)}`;
	const freshness = palette.color(
		state.refreshing ? "accent" : "dim",
		state.refreshing ? "Refreshing…" : updated,
	);
	if (width < 60) {
		lines.push(palette.bold(truncateToWidth(model.current.title, width, "…")), freshness);
	} else {
		lines.push(
			joinSides(
				palette.bold(
					truncateToWidth(model.current.title, Math.max(10, width - updated.length - 3)),
				),
				freshness,
				width,
			),
		);
	}
	if (state.refreshError)
		lines.push(palette.color("error", `Refresh failed: ${state.refreshError}`));
	lines.push(sectionLabel("Current session", palette));
	lines.push(...renderCurrent(model, state.selectedIndex === 0, width, palette));
	lines.push(separator(width, palette));
	lines.push(sectionLabel("Totals over time", palette));
	lines.push(...renderPeriods(model.periods, width, palette));
	lines.push(separator(width, palette));
	lines.push(sectionLabel("Recent sessions", palette));
	lines.push(...renderRecent(model, state.selectedIndex, width, palette));
	lines.push(
		...dashboardFooter(
			["↑↓ Select", "Enter Open", "? Explain numbers", "R Refresh", "Esc Close"],
			width,
			palette,
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
	const difference =
		current.comparison.state === "unavailable"
			? palette.color("muted", "Not enough data")
			: colorComparison(current.comparison, palette);
	const prefix = selected ? palette.color("accent", "›") : " ";
	const commonLines = [
		palette.color("dim", `  ${formatRunCount(current.finishedRuns, current.activeRuns.length)}`),
		...comparisonSummaryLines(current.comparison, Math.max(1, width - 2), palette).map(
			(line) => `  ${line}`,
		),
		"  This session only. Use /prewalk stats task to include work it handed to other agents.",
	];
	if (width < WIDE_TABLE_MIN) {
		return [
			`${prefix} ${palette.bold(current.title)}`,
			`  Cost ${palette.bold(formatUsd(current.actualCost))} · Est. savings ${difference}`,
			...commonLines,
		];
	}
	const layout = sharedMetricLayout(width);
	const title = selected ? palette.color("accent", current.title) : palette.bold(current.title);
	return [
		palette.color("dim", `  ${metricHeader(layout, "SESSION")}`),
		`${prefix} ${metricRow(layout, title, "", formatUsd(current.actualCost), difference, (text) => text, (text) => text, palette.bold)}`,
		...commonLines,
	];
}

function renderPeriods(
	periods: readonly DashboardPeriod[],
	width: number,
	palette: DashboardPalette,
): string[] {
	if (width < WIDE_TABLE_MIN) {
		return [
			palette.color("dim", "COST · EST. SAVINGS FROM MODEL SWITCHING"),
			...periods.flatMap((item) => [
				`${palette.bold(item.label)} · ${formatRunCount(item.finishedRuns, item.activeRuns)}`,
				`  ${formatUsd(item.actualCost)} · ${colorComparison(item.comparison, palette)}`,
			]),
		];
	}
	const layout = sharedMetricLayout(width);
	return [
		palette.color("dim", `  ${metricHeader(layout, "PERIOD")}`),
		...periods.flatMap((item) => [
			`  ${metricRow(
				layout,
				item.label,
				"",
				formatUsd(item.actualCost),
				compactDifference(item.comparison),
				palette.bold,
				(text) => comparisonTone(item.comparison, palette, text),
			)}`,
			palette.color("dim", `  ${formatRunCount(item.finishedRuns, item.activeRuns)}`),
		]),
	];
}

function renderRecent(
	model: AnalyticsDashboardModel,
	selectedIndex: number,
	width: number,
	palette: DashboardPalette,
): string[] {
	if (model.recentSessions.length === 0) return [palette.color("muted", "No other sessions yet.")];
	const remaining = model.sessionHistory.length - model.recentSessions.length;
	const seeMoreSelected = isSeeMoreSelection(model, selectedIndex);
	const seeMore: string[] = [];
	if (remaining > 0) {
		const rawLabel = `See ${remaining} more ${plural(remaining, "session")}`;
		const label = seeMoreSelected ? palette.color("accent", rawLabel) : rawLabel;
		const prefix = seeMoreSelected ? palette.color("accent", "›") : " ";
		seeMore.push(
			`${prefix} ${label}`,
			palette.color("dim", "  Open the full history, newest first."),
		);
	}
	if (width < WIDE_TABLE_MIN) {
		return [
			...model.recentSessions.flatMap((session, index) => {
				const selected = selectedIndex === index + 1;
				const prefix = selected ? palette.color("accent", "›") : " ";
				return [
					`${prefix} ${selected ? palette.color("accent", session.title) : session.title}`,
					`  ${colorStatus(session, palette)} · Cost ${formatUsd(session.actualCost)} · ${colorComparison(session.comparison, palette)}`,
				];
			}),
			...seeMore,
		];
	}
	const layout = sharedMetricLayout(width);
	// Repeating the same unavailability on every row reads as a broken tool.
	// Rows stay quiet and one line below the table carries the reason.
	const uncomparable = model.recentSessions.filter(
		(session) => session.comparison.state === "unavailable",
	);
	return [
		palette.color("dim", `  ${metricHeader(layout, "SESSION")}`),
		...model.recentSessions.map((session, index) => {
			const selected = selectedIndex === index + 1;
			const prefix = selected ? palette.color("accent", "›") : " ";
			const title = selected ? palette.color("accent", session.title) : session.title;
			const estimate =
				session.comparison.state === "unavailable"
					? palette.color("dim", "—")
					: colorComparison(session.comparison, palette);
			return `${prefix} ${metricRow(
				layout,
				title,
				colorStatus(session, palette),
				formatUsd(session.actualCost),
				estimate,
			)}`;
		}),
		...(uncomparable.length === 0
			? []
			: [
					palette.color(
						"dim",
						`  — ${uncomparable.length} of ${model.recentSessions.length} ${plural(model.recentSessions.length, "session")} could not be compared. Select one to see why.`,
					),
				]),
		...seeMore,
	];
}

function renderHistory(
	model: AnalyticsDashboardModel,
	state: DashboardRenderState,
	width: number,
	palette: DashboardPalette,
): string[] {
	if (model.sessionHistory.length === 0) {
		return [
			palette.color("muted", "No earlier sessions have been logged yet."),
			"",
			palette.color("dim", "R Refresh · Esc Back"),
		];
	}
	const selectedIndex = Math.min(
		Math.max(0, state.historySelectedIndex ?? 0),
		model.sessionHistory.length - 1,
	);
	const start = Math.floor(selectedIndex / HISTORY_PAGE_SIZE) * HISTORY_PAGE_SIZE;
	const end = Math.min(start + HISTORY_PAGE_SIZE, model.sessionHistory.length);
	const visible = model.sessionHistory.slice(start, end);
	const range = palette.color(
		"dim",
		`${start + 1}–${end} of ${model.sessionHistory.length} · newest first`,
	);
	const lines = [
		...(width < 60
			? [palette.bold("Session history"), range]
			: [joinSides(palette.bold("Session history"), range, width)]),
		...wrapTextWithAnsi("Select a session to see its cost calculation and stable ID.", width).map(
			(line) => palette.color("dim", line),
		),
		"",
	];
	if (width < WIDE_TABLE_MIN) {
		for (const [offset, session] of visible.entries()) {
			const selected = selectedIndex === start + offset;
			lines.push(
				`${selected ? palette.color("accent", "›") : " "} ${selected ? palette.color("accent", session.title) : session.title}`,
				`  ${colorStatus(session, palette)} · Cost ${formatUsd(session.actualCost)} · ${colorComparison(session.comparison, palette)}`,
			);
		}
	} else {
		const layout = sharedMetricLayout(width);
		lines.push(
			palette.color("dim", `  ${metricHeader(layout, "SESSION")}`),
			...visible.map((session, offset) => {
				const selected = selectedIndex === start + offset;
				const prefix = selected ? palette.color("accent", "›") : " ";
				const title = selected ? palette.color("accent", session.title) : session.title;
				const difference =
					session.comparison.state === "unavailable"
						? palette.color("dim", "—")
						: colorComparison(session.comparison, palette);
				return `${prefix} ${metricRow(
					layout,
					title,
					colorStatus(session, palette),
					formatUsd(session.actualCost),
					difference,
				)}`;
			}),
		);
	}
	lines.push(
		"",
		...dashboardFooter(
			[
				"↑↓ Select",
				"PgUp/PgDn More sessions",
				"Enter Details",
				"? Explain",
				"R Refresh",
				"Esc Back",
			],
			width,
			palette,
		),
	);
	return lines;
}

function renderDetails(
	model: AnalyticsDashboardModel,
	state: DashboardRenderState,
	width: number,
	palette: DashboardPalette,
): string[] {
	const session = selectedSession(model, state.selectedIndex);
	let selected = session;
	if (state.selectedSessionId === model.current.sessionId) {
		selected = model.current;
	} else if (state.selectedSessionId) {
		selected =
			model.sessionHistory.find((item) => item.sessionId === state.selectedSessionId) ?? session;
	}
	const comparison = selected.comparison;
	const lines = [
		palette.bold(selected.title),
		palette.color("dim", selected.sessionId),
		"",
		`${palette.color("muted", "Status")}      ${colorStatus(selected, palette)}`,
		`${palette.color("muted", "Total cost")}  ${palette.bold(formatUsd(selected.actualCost))}`,
		...wrapTextWithAnsi(
			"Every recorded call, including background work and runs that could not be compared.",
			width,
		).map((line) => palette.color("dim", line)),
		"",
		sectionLabel("Prewalk runs", palette),
		palette.color("dim", formatRunCount(selected.receipts.length, selected.activeRuns.length)),
		...renderRunRoutes(selected, width, palette),
		"",
		sectionLabel("Est. savings from model switching", palette),
		...comparisonCoverageLines(comparison, width, palette),
	];
	if (comparison.state !== "unavailable") {
		lines.push(
			"",
			`Cost with model switching  ${formatUsd(comparison.actualPrimaryCost ?? 0)}`,
			...wrapTextWithAnsi(
				`Estimated cost if each run's starting model continued  ~${formatUsd(comparison.plannerOnlyEstimate ?? 0)}`,
				width,
			),
			`${palette.bold("Est. savings from switching")}  ${formatSignedDifference(comparison)}`,
			"",
			...wrapTextWithAnsi(
				'Estimate only, not measured savings. Prewalk did not run a second control task. "Up to" is the most the recorded token mix suggests you may have saved; the real amount may be smaller.',
				width,
			).map((line) => palette.color("warning", line)),
		);
	}
	lines.push(
		"",
		...dashboardFooter(["? Explain numbers", "R Refresh", "Esc Back"], width, palette),
	);
	return lines;
}

function renderHelp(width: number, palette: DashboardPalette): string[] {
	const lines: string[] = [palette.bold("How to read the cost estimate"), ""];
	const addSection = (title: string, text: string, tone: DashboardTone = "accent") => {
		lines.push(palette.color(tone, title));
		lines.push(...wrapTextWithAnsi(text, width), "");
	};
	addSection(
		"Cost",
		"The provider-reported cost of every recorded call, including background work.",
	);
	addSection(
		"Est. savings from model switching",
		'For runs that switched models and have usable prices, Prewalk estimates what the same recorded work would have cost if each run\'s starting model had continued. "Up to $X saved" is the most the recorded token mix suggests you may have saved. "$X extra" means switching was estimated to cost more.',
	);
	addSection(
		'Why it says "up to"',
		"Prewalk did not run the task twice. It kept the recorded work and repriced it at the first model's rates. The first model might have used a different number of turns or tokens, so this is not measured savings.",
		"warning",
	);
	addSection(
		"Why an estimate may be missing",
		"The run never switched models, stopped before enough evidence was recorded, or had no usable price data. Its real cost still counts in Cost.",
	);
	lines.push(...dashboardFooter(["R Refresh", "Esc / Enter / ? Back"], width, palette));
	return lines;
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
 * Compact difference for the period table, where the full sentence cannot fit
 * and gets truncated into meaninglessness.
 */
function compactDifference(comparison: DashboardComparison): string {
	if (comparison.state === "unavailable") return "no comparison";
	if (comparison.state === "same") return "about the same";
	const amount = formatUsd(Math.abs(comparison.difference ?? 0));
	const share =
		comparison.percentage === undefined ? "" : ` (${comparison.percentage.toFixed(0)}%)`;
	return comparison.state === "higher"
		? `${amount} extra${share}`
		: `up to ${amount} saved${share}`;
}

function comparisonDetail(summary: ReturnType<typeof summarizeComparisons>): string {
	const parts: string[] = [];
	if (summary.noHandoffRuns > 0) {
		parts.push(`${summary.noHandoffRuns} ${plural(summary.noHandoffRuns, "run")} never switched`);
	}
	if (summary.unavailableRuns > 0) parts.push(unavailableSummary(summary));
	return parts.length > 0 ? `${parts.join(". ")}.` : "";
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

function comparisonSummaryLines(
	comparison: DashboardComparison,
	width: number,
	palette: DashboardPalette,
): string[] {
	if (comparison.state === "unavailable") {
		return wrapTextWithAnsi(comparison.detail, width).map((line) => palette.color("dim", line));
	}
	return comparisonCoverageLines(comparison, width, palette);
}

function comparisonCoverageLines(
	comparison: DashboardComparison,
	width: number,
	palette: DashboardPalette,
): string[] {
	const coverage = `Estimate covers ${comparison.comparableRuns} finished ${plural(comparison.comparableRuns, "run")} (${formatUsd(comparison.coveredCost)} of ${formatUsd(comparison.finishedCost)}).`;
	const text = comparison.detail ? `${coverage} ${comparison.detail}` : coverage;
	return wrapTextWithAnsi(text, width).map((line) => palette.color("dim", line));
}

function formatRunCount(finished: number, active: number): string {
	const total = finished + active;
	return `${total} Prewalk ${plural(total, "run")}: ${finished} finished, ${active} active`;
}

/** Prefer the full product label when the column is wide enough; otherwise keep a short readable form. */
function savingsColumnHeader(columnWidth: number): string {
	return columnWidth >= SAVINGS_HEADER_FULL.length ? SAVINGS_HEADER_FULL : SAVINGS_HEADER_SHORT;
}

function sharedMetricLayout(width: number): SharedMetricLayout {
	const statusWidth = 12;
	const costWidth = 12;
	const savingsWidth = Math.min(
		Math.max(SAVINGS_HEADER_SHORT.length + 2, SAVINGS_HEADER_FULL.length),
		Math.max(22, width - 50),
	);
	const leadingWidth = Math.max(12, width - statusWidth - costWidth - savingsWidth - 10);
	return { leadingWidth, statusWidth, costWidth, savingsWidth };
}

function metricHeader(layout: SharedMetricLayout, leadingLabel: string): string {
	return [
		cell(leadingLabel, layout.leadingWidth, "left"),
		cell("STATUS", layout.statusWidth, "left"),
		cell("COST", layout.costWidth, "right"),
		cell(savingsColumnHeader(layout.savingsWidth), layout.savingsWidth, "right"),
	].join("  ");
}

function metricRow(
	layout: SharedMetricLayout,
	leading: string,
	status: string,
	cost: string,
	savings: string,
	leadingStyle: (text: string) => string = (text) => text,
	savingsStyle: (text: string) => string = (text) => text,
	costStyle: (text: string) => string = (text) => text,
): string {
	return [
		cell(leading, layout.leadingWidth, "left", leadingStyle),
		cell(status, layout.statusWidth, "left"),
		cell(cost, layout.costWidth, "right", costStyle),
		cell(savings, layout.savingsWidth, "right", savingsStyle),
	].join("  ");
}

function renderRunRoutes(
	session: DashboardSession,
	width: number,
	palette: DashboardPalette,
): string[] {
	const runs = [
		...session.receipts.map((receipt) => ({
			startedAt: receipt.startedAt,
			status: outcomeLabel(receipt.outcome),
			handoffState: receipt.handoffState,
			planner: receipt.planner,
			executor: receipt.executor,
		})),
		...session.activeRuns.map((run) => ({
			startedAt: run.startedAt,
			status: "Active",
			handoffState: run.handoffState,
			planner: run.planner,
			executor: run.executor,
		})),
	].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
	if (runs.length === 0) return [palette.color("dim", "No runs recorded.")];
	const visible = runs.slice(0, DETAIL_RUN_LIMIT);
	const lines = visible.flatMap((run) =>
		wrapTextWithAnsi(
			`${run.status} · ${formatModelRoute(run.planner, run.executor, run.handoffState)}`,
			width,
		),
	);
	if (runs.length > visible.length) {
		lines.push(palette.color("dim", `${runs.length - visible.length} older runs not shown.`));
	}
	return lines;
}

function formatModelRoute(
	planner: ModelIdentity,
	executor: ModelIdentity,
	handoffState: HandoffState,
): string {
	const startedOn = `${planner.provider}/${planner.model}`;
	const switchedTo = `${executor.provider}/${executor.model}`;
	if (handoffState === "completed") return `${startedOn} → ${switchedTo}`;
	if (handoffState === "pending") return `${startedOn} → ${switchedTo} (switch pending)`;
	if (handoffState === "failed") return `${startedOn} → ${switchedTo} (switch failed)`;
	return `${startedOn} only`;
}

function hasMoreSessions(model: AnalyticsDashboardModel): boolean {
	return model.sessionHistory.length > model.recentSessions.length;
}

function overviewRowCount(model: AnalyticsDashboardModel): number {
	return 1 + model.recentSessions.length + (hasMoreSessions(model) ? 1 : 0);
}

function isSeeMoreSelection(model: AnalyticsDashboardModel, selectedIndex: number): boolean {
	return hasMoreSessions(model) && selectedIndex === model.recentSessions.length + 1;
}

function overviewSessionAt(
	model: AnalyticsDashboardModel,
	selectedIndex: number,
): DashboardSession | undefined {
	if (selectedIndex === 0) return model.current;
	return model.recentSessions[selectedIndex - 1];
}

function overviewSelectionKey(model: AnalyticsDashboardModel, selectedIndex: number): string {
	if (selectedIndex === 0) return `current:${model.current.sessionId}`;
	if (isSeeMoreSelection(model, selectedIndex)) return "see-more";
	const session = model.recentSessions[selectedIndex - 1];
	return session ? `session:${session.sessionId}` : `current:${model.current.sessionId}`;
}

function overviewIndexForKey(model: AnalyticsDashboardModel, key: string): number {
	if (key === "see-more" && hasMoreSessions(model)) return model.recentSessions.length + 1;
	if (key.startsWith("session:")) {
		const sessionId = key.slice("session:".length);
		const index = model.recentSessions.findIndex((session) => session.sessionId === sessionId);
		if (index >= 0) return index + 1;
		if (hasMoreSessions(model)) return model.recentSessions.length + 1;
	}
	return 0;
}

function historyIndexForSession(
	model: AnalyticsDashboardModel,
	sessionId: string | undefined,
): number {
	if (!sessionId) return 0;
	const index = model.sessionHistory.findIndex((session) => session.sessionId === sessionId);
	return Math.max(0, index);
}

function movedIndex(current: number, delta: number, count: number, wrap: boolean): number {
	if (count <= 0) return 0;
	if (wrap) return (((current + delta) % count) + count) % count;
	return Math.min(count - 1, Math.max(0, current + delta));
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
	if (amount > 0) return `up to ${formatUsd(amount)} saved (${percent}%)`;
	if (amount < 0) return `${formatUsd(-amount)} extra (${percent}%)`;
	return "About the same (0.0%)";
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

function dashboardFooter(
	actions: readonly string[],
	width: number,
	palette: DashboardPalette,
): string[] {
	const separatorText = " · ";
	const lines: string[] = [];
	let current = "";
	for (const action of actions) {
		const candidate = current ? `${current}${separatorText}${action}` : action;
		if (visibleWidth(candidate) <= width) {
			current = candidate;
			continue;
		}
		if (current) lines.push(current);
		current = truncateToWidth(action, width, "…");
	}
	if (current) lines.push(current);
	return lines.map((line) => palette.color("dim", line));
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
