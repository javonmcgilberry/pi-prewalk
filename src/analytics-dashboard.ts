import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	comparisonEstimate,
	isPlanningOnlyReceipt,
	type RunOutcome,
	type RunReceipt,
	type UnavailabilityReason,
} from "./analytics.js";
import type { AnalyticsOverview } from "./analytics-report.js";
import type { AnalyticsAggregate, UnfinishedRunSummary } from "./analytics-store.js";

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
	plannerOnlyEstimate?: number;
	actualPrimaryCost?: number;
	difference?: number;
	percentage?: number;
}

export interface DashboardPeriod {
	label: string;
	completedRuns: number;
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
		completedRuns: number;
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
	const currentStatus = overview.session.unfinished.length > 0 ? "Active" : "No active run";
	const current: AnalyticsDashboardModel["current"] = {
		sessionId: overview.sessionId,
		title: overview.sessionTitles?.get(overview.sessionId) ?? "Untitled session",
		status: currentStatus,
		statusTone: overview.session.unfinished.length > 0 ? "accent" : "muted",
		lastUpdatedAt: currentUpdatedAt,
		actualCost: overview.session.actualCost,
		receipts: currentReceipts,
		activeRuns: overview.session.unfinished,
		comparison: summarizeComparison(currentReceipts),
		completedRuns: overview.session.receiptCount,
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

export function summarizeComparison(receipts: readonly RunReceipt[]): DashboardComparison {
	const successful = receipts.filter((receipt) => receipt.outcome === "succeeded");
	const estimates = successful.map((receipt) => ({
		receipt,
		estimate: comparisonEstimate(receipt),
	}));
	const comparable = estimates.filter(({ estimate }) => estimate.kind !== "unavailable");
	if (comparable.length === 0) {
		return {
			state: "unavailable",
			label: unavailableLabel(receipts),
			detail: unavailableDetail(receipts),
			comparableRuns: 0,
			successfulRuns: successful.length,
		};
	}

	let plannerOnlyEstimate = 0;
	let difference = 0;
	for (const { estimate } of comparable) {
		if (estimate.kind === "unavailable") continue;
		plannerOnlyEstimate += estimate.plannerOnlyCost;
		difference += estimate.savings;
	}
	const actualPrimaryCost = plannerOnlyEstimate - difference;
	const percentage =
		plannerOnlyEstimate === 0 ? 0 : Math.abs((difference / plannerOnlyEstimate) * 100);
	const unavailable = estimates.filter(({ estimate }) => estimate.kind === "unavailable");
	const planningOnlyCount = estimates.filter(
		({ receipt, estimate }) => isPlanningOnlyReceipt(receipt) && estimate.kind !== "unavailable",
	).length;
	const compared =
		comparable.length === successful.length
			? `${successful.length} completed ${plural(successful.length, "run")} compared`
			: `${comparable.length} of ${successful.length} completed ${plural(successful.length, "run")} compared`;
	const evidence = `${compared}${unavailable.length > 0 ? `; ${unavailableSummary(successful)}` : ""}.${
		planningOnlyCount > 0
			? planningOnlyCount === 1
				? " No executor handoff was needed."
				: ` No executor handoff was needed for ${planningOnlyCount} runs.`
			: ""
	}`;

	if (difference > 0) {
		return {
			state: "lower",
			label: `${formatUsd(difference)} less than planner alone`,
			detail: evidence,
			comparableRuns: comparable.length,
			successfulRuns: successful.length,
			plannerOnlyEstimate,
			actualPrimaryCost,
			difference,
			percentage,
		};
	}
	if (difference < 0) {
		return {
			state: "higher",
			label: `${formatUsd(-difference)} more than planner alone`,
			detail: evidence,
			comparableRuns: comparable.length,
			successfulRuns: successful.length,
			plannerOnlyEstimate,
			actualPrimaryCost,
			difference,
			percentage,
		};
	}
	return {
		state: "same",
		label: planningOnlyCount > 0 ? "No cost difference" : "Same as planner alone",
		detail: evidence,
		comparableRuns: comparable.length,
		successfulRuns: successful.length,
		plannerOnlyEstimate,
		actualPrimaryCost,
		difference,
		percentage,
	};
}

function unavailableLabel(receipts: readonly RunReceipt[]): string {
	const successful = receipts.filter((receipt) => receipt.outcome === "succeeded");
	if (successful.length === 0) {
		if (receipts.length === 0) return "No finished run to compare yet";
		const outcomes = new Set(receipts.map((receipt) => receipt.outcome));
		if (outcomes.size === 1)
			return `${outcomeLabel(receipts[0]?.outcome ?? "unfinished")} run not compared`;
		return "No successful result to compare";
	}
	const reasons = new Set(
		successful
			.map((receipt) => comparisonEstimate(receipt))
			.filter((estimate) => estimate.kind === "unavailable")
			.map((estimate) => estimate.reason),
	);
	if (reasons.size === 1 && reasons.has("usage-incomplete")) return "Missing executor usage";
	if (
		reasons.size > 0 &&
		[...reasons].every((reason) =>
			["pricing-missing", "pricing-incomplete", "pricing-zero"].includes(reason),
		)
	)
		return "Missing pricing";
	return "Comparison unavailable";
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
			? "How costs work"
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
				? "↑↓ Select   Enter Details   ? How costs work   R Refresh   Esc Close"
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
	const estimate = colorComparison(current.comparison, palette);
	const prefix = selected ? palette.color("accent", "›") : " ";
	if (width < 76) {
		return [
			`${prefix} ${palette.bold(current.title)}`,
			`  Actual spend ${palette.bold(formatUsd(current.actualCost))} · ${current.activeRuns.length} active · ${current.completedRuns} complete`,
			`  Compared with planner alone: ${estimate}`,
			...(current.activeRuns.length === 0
				? []
				: [
						`  Active now: ${current.activeRuns.map((run) => `${run.runId} ${formatUsd(run.actualCost)}`).join(", ")}`,
					]),
			`  ${palette.color("dim", current.comparison.detail)}`,
		];
	}
	const metricWidth = Math.floor((width - 6) / 3);
	return [
		`${prefix} ${cell("ACTUAL SPEND", metricWidth, "left", (text) => palette.color("dim", text))}  ${cell("RUNS", metricWidth, "left", (text) => palette.color("dim", text))}  ${cell("VS PLANNER ALONE", metricWidth, "left", (text) => palette.color("dim", text))}`,
		`  ${cell(formatUsd(current.actualCost), metricWidth, "left", palette.bold)}  ${cell(`${current.activeRuns.length} active · ${current.completedRuns} complete`, metricWidth, "left")}  ${cell(estimate, metricWidth, "left")}`,
		...(current.activeRuns.length === 0
			? []
			: [
					`  Active now: ${current.activeRuns.map((run) => `${run.runId} ${formatUsd(run.actualCost)}`).join(", ")}`,
				]),
		`  ${palette.color("dim", current.comparison.detail)}`,
	];
}

function renderPeriods(
	periods: readonly DashboardPeriod[],
	width: number,
	palette: DashboardPalette,
): string[] {
	if (width < 96) {
		return periods.flatMap((item) => [
			`${palette.bold(item.label)} · ${item.completedRuns} ${plural(item.completedRuns, "run")} · ${formatUsd(item.actualCost)}`,
			`  ${colorComparison(item.comparison, palette)} · ${palette.color("dim", item.comparison.detail)}`,
		]);
	}
	const periodWidth = 14;
	const runsWidth = 14;
	const actualWidth = 16;
	const differenceWidth = 23;
	const evidenceWidth = Math.max(
		18,
		width - periodWidth - runsWidth - actualWidth - differenceWidth - 8,
	);
	const header = [
		cell("PERIOD", periodWidth, "left"),
		cell("COMPLETED RUNS", runsWidth, "right"),
		cell("ACTUAL SPEND", actualWidth, "right"),
		cell("VS PLANNER ALONE", differenceWidth, "right"),
		cell("WHAT WAS COMPARED", evidenceWidth, "left"),
	].join("  ");
	return [
		palette.color("dim", header),
		...periods.map((item) =>
			[
				cell(item.label, periodWidth, "left", palette.bold),
				cell(String(item.completedRuns), runsWidth, "right"),
				cell(formatUsd(item.actualCost), actualWidth, "right"),
				cell(colorComparison(item.comparison, palette), differenceWidth, "right"),
				cell(item.comparison.detail, evidenceWidth, "left", (text) =>
					palette.color("dim", text),
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
	const header = `  ${cell("SESSION", titleWidth, "left")}  ${cell("STATUS", statusWidth, "left")}  ${cell("ACTUAL", actualWidth, "right")}  ${cell("VS PLANNER ALONE", estimateWidth, "right")}`;
	return [
		palette.color("dim", header),
		...model.recentSessions.map((session, index) => {
			const selected = selectedIndex === index + 1;
			const prefix = selected ? palette.color("accent", "›") : " ";
			const title = selected ? palette.color("accent", session.title) : session.title;
			return `${prefix} ${cell(title, titleWidth, "left")}  ${cell(colorStatus(session, palette), statusWidth, "left")}  ${cell(formatUsd(session.actualCost), actualWidth, "right")}  ${cell(colorComparison(session.comparison, palette), estimateWidth, "right")}`;
		}),
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
		`${palette.color("muted", "Status")}               ${colorStatus(session, palette)}`,
		`${palette.color("muted", "Actual spend")}         ${palette.bold(formatUsd(session.actualCost))}`,
		`${palette.color("muted", "Active runs")}          ${session.activeRuns.length}`,
		`${palette.color("muted", "Completed runs")}        ${session.receipts.length}`,
		`${palette.color("muted", "Vs planner alone")}    ${colorComparison(comparison, palette)}`,
		`${palette.color("muted", "Runs compared")}       ${comparison.detail}`,
	];
	if (comparison.state !== "unavailable") {
		lines.push(
			"",
			sectionLabel("Calculation", palette),
			`If planner handled all work  ${formatUsd(comparison.plannerOnlyEstimate ?? 0)}`,
			`Planner + executor calls     ${formatUsd(comparison.actualPrimaryCost ?? 0)}`,
			`Difference                   ${formatSignedDifference(comparison)}`,
			palette.color(
				"dim",
				"Actual spend also includes helper and compaction calls; this comparison does not.",
			),
		);
	}
	lines.push(
		"",
		palette.color(
			"warning",
			"This applies planner prices to recorded executor tokens; it is not a separate planner-only run.",
		),
		"",
		palette.color(
			"dim",
			width >= 65 ? "? How costs work   R Refresh   Esc Back" : "? Help · R Refresh · Esc Back",
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
		palette.bold("What the numbers mean"),
		"",
		palette.color("accent", "Planner and executor"),
		"Planner: the model selected in Pi before Prewalk hands work off.",
		"Executor: the model that continues after the handoff.",
		"",
		palette.color("accent", "Actual spend"),
		"Provider-reported cost for planner, executor, helper, and compaction calls.",
		"",
		palette.color("accent", "Compared with planner alone"),
		"We keep the recorded token counts but price executor tokens at the planner's rates.",
		"The difference is that planner-alone amount minus planner + executor call cost.",
		"Less means the planner + executor calls cost less; more means they cost more.",
		"",
		palette.color("accent", "Cannot compare"),
		"The dashboard names what is missing: a completed run, executor usage, or pricing.",
		"A completed planning-only run needs no estimate because no executor handoff occurred.",
		"",
		palette.color(
			"warning",
			"This is a price-based estimate, not a measured planner-only benchmark run.",
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
		completedRuns: aggregate.receiptCount,
		actualCost: aggregate.actualCost,
		comparison: summarizeComparison(aggregate.receipts),
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

function unavailableDetail(receipts: readonly RunReceipt[]): string {
	const successful = receipts.filter((receipt) => receipt.outcome === "succeeded");
	if (successful.length === 0) {
		if (receipts.length === 0) return "No finished runs yet.";
		const outcomes = new Map<string, number>();
		for (const receipt of receipts) {
			const label = outcomeLabel(receipt.outcome).toLowerCase();
			outcomes.set(label, (outcomes.get(label) ?? 0) + 1);
		}
		const details = [...outcomes.entries()].map(
			([label, count]) => `${count} ${label} ${plural(count, "run")}`,
		);
		return `${details.join("; ")} not compared.`;
	}
	const summary = unavailableSummary(successful);
	return summary.length > 0 ? `${summary}.` : "No completed runs could be compared.";
}

function unavailableSummary(successful: readonly RunReceipt[]): string {
	const counts = new Map<UnavailabilityReason, number>();
	for (const receipt of successful) {
		const estimate = comparisonEstimate(receipt);
		if (estimate.kind !== "unavailable") continue;
		counts.set(estimate.reason, (counts.get(estimate.reason) ?? 0) + 1);
	}
	const details = [...counts.entries()].map(
		([reason, count]) => `${count} ${plural(count, "run")} ${unavailableReasonLabel(reason)}`,
	);
	return details.join("; ");
}

function unavailableReasonLabel(reason: UnavailabilityReason): string {
	if (reason === "pricing-missing") return "missing pricing";
	if (reason === "pricing-incomplete") return "with incomplete pricing";
	if (reason === "pricing-zero") return "with an invalid zero price";
	if (reason === "usage-incomplete") return "missing executor usage";
	if (reason === "analytics-disabled") return "recorded while analytics was disabled";
	if (reason === "unfinished-run") return "that did not finish";
	return "without a successful outcome";
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
	if (amount > 0) return `${formatUsd(amount)} less (${percent}%)`;
	if (amount < 0) return `${formatUsd(-amount)} more (${percent}%)`;
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
