import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showAnalyticsDashboard } from "../analytics/dashboard.js";
import type { AnalyticsConfig, RunOutcome } from "../analytics/index.js";
import {
	renderAnalyticsOverview,
	renderReceiptReport,
	renderTaskTreeReport,
} from "../analytics/report.js";
import type { PrewalkAnalytics } from "../analytics/run-accounting.js";
import { configPath } from "../config/prewalk-config.js";
import type { PrewalkApplication } from "../orchestration/prewalk-application.js";
import type { TurnGate } from "../turn/turn-gate.js";
import type { DelegationStatus } from "../ui/status.js";
import { detailedStatus } from "../ui/status.js";

const PREWALK_COMMANDS = [
	"status",
	"stats",
	"run",
	"auto",
	"cancel",
	"configure",
	"todos",
	"help",
	"--help",
] as const;

function helpText(): string {
	return [
		"Prewalk quick guide",
		"",
		"/prewalk status  Show the current planner, executor, gate, route, and failure reason.",
		"/prewalk stats  Open the current-session dashboard; press ? for cost explanations.",
		"/prewalk stats --successful  Show successful receipts only.",
		"/prewalk stats receipt <run-id>  Show one receipt's evidence and calculation.",
		"/prewalk stats task  Show root and delegated task-tree analytics.",
		"/prewalk stats benchmark <summary.json>  Import an accepted verified benchmark summary.",
		"/prewalk stats export <path>  Export validated JSONL without overwriting a file.",
		"/prewalk stats reset  Confirm a new empty ledger generation.",
		"/prewalk stats cleanup  Retry removal of retired ledger generations.",
		"/prewalk run     Start a new manual Prewalk run after cancellation or failure.",
		"/prewalk auto    Enable conservative automatic admission for this session.",
		"/prewalk cancel  Disable automatic admission and stop the current Prewalk run.",
		"/prewalk release Restore the planner after a successful executor handoff.",
		"/prewalk configure  Choose the executor and control analytics collection and catalog fallback.",
		"/prewalk todos  Show the current Prewalk implementation checklist.",
		"",
		"Reset the current run: /prewalk cancel, then /prewalk run.",
		"Type exactly stop or cancel to close only the current task; /prewalk cancel also disables session automatic mode.",
		"Reload extension and config changes: /reload.",
		`Configuration file: ${configPath()}`,
		"Configuration is written atomically by /prewalk configure.",
		"Analytics stay local. Recorded spend is the cost Pi reports. The estimated difference prices recorded executor tokens at planner rates; runs finished before handoff are not compared, and missing inputs are named directly.",
		"Disabling collection preserves existing receipts and does not change routing. Export refuses existing destinations. Reset excludes any active prior-generation run, and collection resumes on the next run.",
		"",
		"Prewalk derives the planner from Pi's selected model and reasoning for each epoch. Only primary Agent-loop requests route to the executor after the handoff gate.",
		"Shift+Tab changes Sol reasoning while Sol is active and Luna reasoning after Luna takes over.",
		"Sol and Luna reasoning are independent; Luna defaults to low unless you configure another level.",
		"Subagents run independent Prewalk lifecycles. A strict child without prewalk_todo still switches after its first successful code change.",
		"Parent status reports an observed child outcome, but child code changes never switch the parent.",
	].join("\n");
}

export interface PrewalkCommandRegistration {
	application: PrewalkApplication;
	turnGate: TurnGate;
	analytics: PrewalkAnalytics;
	delegation(): DelegationStatus | undefined;
	childDiagnostic(): string | undefined;
	autoEnabled(): boolean;
	lastOutcome(): "bypassed" | "completed" | "failed" | "released" | undefined;
	setAutoEnabled(enabled: boolean, ctx: ExtensionContext): void;
	updateStatus(ctx: ExtensionContext): void;
	onCancel(ctx: ExtensionContext): Promise<void>;
	onRelease(ctx: ExtensionContext): Promise<void>;
	startManual(ctx: ExtensionContext): Promise<void>;
	onConfigure(ctx: ExtensionContext): Promise<void>;
	loadSessionTitles(): Promise<ReadonlyMap<string, string>>;
	analyticsConfig(): AnalyticsConfig;
}

async function showStats(
	argumentsText: string,
	ctx: ExtensionContext,
	deps: PrewalkCommandRegistration,
): Promise<void> {
	await deps.analytics.waitForWrites();
	const input = argumentsText.trim();
	try {
		if (input.startsWith("benchmark ")) {
			const source = input.slice("benchmark ".length).trim();
			if (!source) throw new Error("missing-benchmark-path");
			await deps.analytics.writeVerifiedBenchmarkSummary(
				JSON.parse(await readFile(source, "utf8")),
			);
			ctx.ui.notify("Verified benchmark evidence imported.", "info");
			return;
		}
		if (input.startsWith("export ")) {
			const destination = input.slice("export ".length).trim();
			if (!destination) throw new Error("missing-export-path");
			const count = await deps.analytics.exportJsonLines(destination);
			ctx.ui.notify(`Exported ${count} analytics receipts to ${destination}.`, "info");
			return;
		}
		if (input === "reset") {
			const confirmed = await ctx.ui.confirm(
				"Reset Prewalk analytics?",
				"This starts a new empty ledger generation. Existing receipts leave current totals, and an active run is excluded.",
			);
			if (!confirmed) {
				ctx.ui.notify("Analytics reset cancelled; nothing changed.", "info");
				return;
			}
			const excluded = deps.analytics.active;
			const result = await deps.analytics.reset();
			const completion = excluded
				? "Analytics reset complete. The active run was excluded; collection resumes with the next Prewalk run."
				: "Analytics reset complete; collection resumes with the next Prewalk run.";
			ctx.ui.notify(
				result.cleanupComplete
					? completion
					: `${completion} Retired ledger cleanup is incomplete; run /prewalk stats cleanup to retry.`,
				result.cleanupComplete ? "info" : "error",
			);
			return;
		}
		if (input === "cleanup") {
			const result = await deps.analytics.retryRetiredGenerationCleanup();
			ctx.ui.notify(
				result.cleanupComplete
					? "Retired analytics cleanup complete."
					: `Retired analytics cleanup remains incomplete for ${result.remainingRetiredGenerations.length} generation(s); run /prewalk stats cleanup to retry.`,
				result.cleanupComplete ? "info" : "error",
			);
			return;
		}
		if (input === "task") {
			const report = await deps.analytics.taskTree(ctx.sessionManager.getSessionId());
			ctx.ui.notify(renderTaskTreeReport(report, await deps.loadSessionTitles()), "info");
			return;
		}
		if (input.startsWith("receipt ")) {
			const runId = input.slice("receipt ".length).trim();
			const receipt = (await deps.analytics.listReceipts()).find(
				(candidate) => candidate.runId === runId,
			);
			if (!receipt) {
				ctx.ui.notify(`No analytics receipt found for run ${runId}.`, "error");
				return;
			}
			ctx.ui.notify(renderReceiptReport(receipt, await deps.loadSessionTitles()), "info");
			return;
		}
		const successfulOnly = input === "--successful";
		if (input && !successfulOnly) throw new Error("unknown-stats-arguments");
		const outcomes: readonly RunOutcome[] | undefined = successfulOnly
			? ["succeeded"]
			: undefined;
		const common = outcomes ? { outcomes } : {};
		const loadOverview = async () => {
			await deps.analytics.waitForWrites();
			const config = deps.analyticsConfig();
			const snapshot = await deps.analytics.snapshot();
			const now = new Date();
			const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
			const sessionId = ctx.sessionManager.getSessionId();
			const [lifetime, month, week, session] = await Promise.all([
				deps.analytics.aggregate(
					{
						...common,
						window: "lifetime",
						recentLimit: config.recentReceiptCount,
						now,
						timeZone,
					},
					snapshot,
				),
				deps.analytics.aggregate({ ...common, window: "month", now, timeZone }, snapshot),
				deps.analytics.aggregate({ ...common, window: "week", now, timeZone }, snapshot),
				deps.analytics.aggregate({ ...common, now, timeZone, sessionId }, snapshot),
			]);
			const verifiedBenchmark = await deps.analytics.readVerifiedBenchmarkSummary();
			return {
				generatedAt: now.toISOString(),
				sessionId,
				lifetime,
				month,
				week,
				session,
				verifiedBenchmark: verifiedBenchmark ?? undefined,
				sessionTitles: await deps.loadSessionTitles(),
			};
		};
		const overview = await loadOverview();
		if (!input && ctx.mode === "tui") {
			await showAnalyticsDashboard(ctx, overview, loadOverview);
			return;
		}
		ctx.ui.notify(renderAnalyticsOverview(overview), "info");
	} catch (error) {
		if (error instanceof Error && error.message.includes("choose a new filename")) {
			ctx.ui.notify(error.message, "error");
			return;
		}
		if (
			error instanceof Error &&
			error.message !== "missing-export-path" &&
			error.message !== "unknown-stats-arguments"
		) {
			ctx.ui.notify(`Analytics request failed: ${error.message}`, "error");
			return;
		}
		ctx.ui.notify(
			"Usage: /prewalk stats [--successful|task|receipt <run-id>|benchmark <summary.json>|export <path>|reset]",
			"error",
		);
	}
}

export function registerPrewalkCommand(pi: ExtensionAPI, deps: PrewalkCommandRegistration): void {
	pi.registerCommand("prewalk", {
		description: "Inspect, run, or cancel the current Prewalk handoff.",
		getArgumentCompletions: (prefix) =>
			PREWALK_COMMANDS.filter((command) => command.startsWith(prefix.trim().toLowerCase())).map(
				(command) => ({ label: command, value: command }),
			),
		async handler(args, ctx) {
			const command = args.trim() || "status";
			if (command === "help" || command === "--help") {
				ctx.ui.notify(helpText(), "info");
				return;
			}
			if (command === "status") {
				const child = deps.childDiagnostic();
				if (child && !deps.application.run) {
					ctx.ui.notify(`Experimental child Prewalk: ${child}.`, "info");
					return;
				}
				ctx.ui.notify(
					detailedStatus(
						deps.application.run,
						ctx.model,
						ctx.thinkingLevel,
						deps.delegation(),
						{
							mode: deps.autoEnabled() ? "auto-ready" : "manual",
							...(deps.lastOutcome() ? { lastOutcome: deps.lastOutcome() } : {}),
						},
					),
					"info",
				);
				return;
			}
			if (command === "cancel") {
				const run = deps.application.run;
				if (
					run?.effectiveRoute === "executor" &&
					(run.phase === "active" || run.phase === "completed")
				) {
					ctx.ui.notify(
						"Prewalk has already handed off; use /prewalk release to restore the planner.",
						"error",
					);
					return;
				}
				await deps.onCancel(ctx);
				ctx.ui.notify("Prewalk automatic mode disabled for this session.", "info");
				return;
			}
			if (command === "release") {
				await deps.onRelease(ctx);
				return;
			}
			if (command === "stats" || command.startsWith("stats ")) {
				await showStats(command.slice("stats".length), ctx, deps);
				return;
			}
			if (command === "run") {
				const run = deps.application.run;
				if (run && run.phase !== "cancelled" && run.phase !== "failed") {
					ctx.ui.notify("Prewalk is already active.", "error");
					return;
				}
				await deps.startManual(ctx);
				return;
			}
			if (command === "auto") {
				if (deps.autoEnabled()) {
					ctx.ui.notify("Prewalk automatic mode is already enabled for this session.", "info");
					return;
				}
				deps.setAutoEnabled(true, ctx);
				deps.updateStatus(ctx);
				ctx.ui.notify("Prewalk automatic mode enabled for this session.", "info");
				return;
			}
			if (command === "configure") {
				await deps.onConfigure(ctx);
				return;
			}
			if (command === "todos") {
				ctx.ui.notify(deps.turnGate.viewTodo().text, "info");
				return;
			}
			ctx.ui.notify(
				"Usage: /prewalk [status|stats|run|auto|cancel|release|configure|todos|help|--help]",
				"error",
			);
		},
	});
}
