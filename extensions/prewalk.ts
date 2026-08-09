import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	readFile as readFileAsync,
	rename as renameFile,
	writeFile as writeFileAsync,
} from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ModelCost, Usage } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { admitAutomaticPrewalk } from "../src/admission.js";
import {
	ANALYTICS_SCHEMA_VERSION,
	calculateSavings,
	DEFAULT_ANALYTICS_CONFIG,
	normalizeUsageObservations,
	type RunJournal,
	type RunOutcome,
	type RunReceipt,
	type SavingsCalculationInput,
	type UsageObservationSource,
	type UsageRole,
	usageEvidenceKey,
} from "../src/analytics.js";
import { showAnalyticsDashboard } from "../src/analytics-dashboard.js";
import {
	renderAnalyticsOverview,
	renderReceiptReport,
	renderTaskTreeReport,
} from "../src/analytics-report.js";
import { AnalyticsStore } from "../src/analytics-store.js";
import { projectDelegationToolResult } from "../src/analytics-subagents.js";
import {
	type AuditEventKind,
	createAuditRecord,
	createAutoModeRecord,
	PREWALK_AUDIT_TYPE,
	PREWALK_AUTO_MODE_TYPE,
	parseAuditRecord,
	parseAutoModeRecord,
	runFromAudit,
} from "../src/audit.js";
import {
	DEFAULT_EXECUTOR,
	isPlannerSelected,
	isReasoningLevel,
	type PlannerProfile,
	PREWALK_CHECKLIST_MESSAGE_TYPE,
	PREWALK_CONTINUE_MESSAGE_TYPE,
	PREWALK_PLAN_MESSAGE_TYPE,
	type PrewalkConfig,
	PrewalkCoordinator,
	type PrewalkRun,
	parseConfig,
	REASONING_LEVELS,
} from "../src/core.js";
import { inferDefaultExecutorChain } from "../src/default-executors.js";
import {
	type ExecutorChainResolution,
	type ExecutorRejection,
	isSameModelAtEffectiveReasoning,
	type RejectedExecutor,
	resolveExecutorChain,
} from "../src/executor-chain.js";
import {
	EXECUTOR_CONTEXT_RESERVE_TOKENS,
	needsExecutorCompaction,
} from "../src/executor-context.js";
import { isRecord } from "../src/guards.js";
import { MutationTurnBuffer } from "../src/mutation.js";
import {
	createProviderOverlay,
	type ProviderOverlay,
	removeExactUserPrompt,
} from "../src/provider-overlay.js";
import { mergeSessionTitles, readSessionMetadataTitles } from "../src/session-metadata.js";
import { compactStatus, type DelegationStatus, detailedStatus } from "../src/status.js";
import {
	applyTodoOperation,
	hasActionableTodo,
	latestTodoPhases,
	PREWALK_TODO_TOOL_NAME,
	type TodoInput,
	type TodoPhase,
} from "../src/todo.js";

const STATUS_KEY = "prewalk";
/**
 * How long an unfinished journal must sit untouched before another session may
 * finalize it. Prewalk rewrites a journal on every usage observation, so this
 * gap means the owning session stopped working, not that it paused mid-turn. It
 * clears an overnight idle session; if recovery still claims a run whose
 * session returns, `supersedeRecoveredReceipt` lets the owner reclaim it.
 */
const ORPHAN_JOURNAL_STALE_MS = 24 * 60 * 60 * 1000;
const PREWALK_TOOL_SLATE_TYPE = "prewalk-tool-slate";
const PREWALK_ASSESS_MESSAGE_TYPE = "prewalk-assess";
const PREWALK_ASSESS_TOOL_NAME = "prewalk_assess";
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
];
const PROMPT_TYPES = new Set([
	PREWALK_PLAN_MESSAGE_TYPE,
	PREWALK_CONTINUE_MESSAGE_TYPE,
	PREWALK_CHECKLIST_MESSAGE_TYPE,
	PREWALK_ASSESS_MESSAGE_TYPE,
]);

type ExecutorCompactionPolicy = {
	enabled: boolean;
	reserveTokens: number;
};

const DEFAULT_EXECUTOR_COMPACTION_POLICY: ExecutorCompactionPolicy = {
	enabled: true,
	reserveTokens: EXECUTOR_CONTEXT_RESERVE_TOKENS,
};

function readExecutorCompactionPolicy(ctx: ExtensionContext): ExecutorCompactionPolicy {
	try {
		const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		}).getCompactionSettings();
		return {
			enabled: settings.enabled,
			reserveTokens:
				Number.isFinite(settings.reserveTokens) && settings.reserveTokens >= 0
					? settings.reserveTokens
					: DEFAULT_EXECUTOR_COMPACTION_POLICY.reserveTokens,
		};
	} catch {
		// A settings read must not prevent the extension from loading. The stock
		// reserve is safer than sending an unguarded executor request.
		return DEFAULT_EXECUTOR_COMPACTION_POLICY;
	}
}

const TodoParameters = Type.Object({
	op: Type.Union([
		Type.Literal("init"),
		Type.Literal("start"),
		Type.Literal("done"),
		Type.Literal("rm"),
		Type.Literal("drop"),
		Type.Literal("block"),
		Type.Literal("unblock"),
		Type.Literal("append"),
		Type.Literal("view"),
	]),
	list: Type.Optional(
		Type.Array(
			Type.Object({
				phase: Type.String(),
				items: Type.Array(Type.String()),
			}),
		),
	),
	task: Type.Optional(Type.String()),
	phase: Type.Optional(Type.String()),
	items: Type.Optional(Type.Array(Type.String())),
	reason: Type.Optional(Type.String()),
});

const AssessmentParameters = Type.Object({
	decision: Type.Union([Type.Literal("continue"), Type.Literal("bypass")]),
});

interface PromptSet {
	plan: string;
	assess: string;
	continue: string;
	checklist: string;
	todo: string;
}

function promptFile(name: string): URL {
	return new URL(`../prompts/${name}`, import.meta.url);
}

function loadPrompts(): PromptSet {
	return {
		plan: readFileSync(promptFile("prewalk-plan.md"), "utf8").replace(
			"the todo tool",
			`the ${PREWALK_TODO_TOOL_NAME} tool`,
		),
		assess: readFileSync(promptFile("prewalk-assess.md"), "utf8"),
		continue: readFileSync(promptFile("prewalk-continue.md"), "utf8"),
		checklist: readFileSync(promptFile("prewalk-checklist.md"), "utf8"),
		todo: readFileSync(promptFile("todo.md"), "utf8"),
	};
}

interface EvaluationState {
	id: string;
	toolSlate: string[];
	decision?: "continue" | "bypass";
	invalid: boolean;
}

const ASSESSMENT_READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const CHILD_MUTATION_TOOLS = new Set(["edit", "write", "bash", "exec", "apply_patch"]);

function childIdentity(): { agent: string; runId: string } | undefined {
	if (process.env.PI_SUBAGENT_CHILD !== "1") return undefined;
	const agent = process.env.PI_SUBAGENT_CHILD_AGENT?.trim();
	const runId = process.env.PI_SUBAGENT_RUN_ID?.trim();
	return agent && runId ? { agent, runId } : undefined;
}

const prompts = loadPrompts();

function configPath(): string {
	return path.join(getAgentDir(), "prewalk.json");
}

function nativeResponsesCompactionState(): "disabled" | "enabled" | "invalid" {
	let raw: string;
	try {
		raw = readFileSync(path.join(getAgentDir(), "pi-codex-conversion.json"), "utf8");
	} catch (error) {
		return isMissingFile(error) ? "disabled" : "invalid";
	}
	let config: unknown;
	try {
		config = JSON.parse(raw);
	} catch {
		return "invalid";
	}
	if (!isRecord(config)) return "invalid";
	if (config.compaction === undefined) {
		const legacyResponsesCompaction = config.responsesCompaction;
		if (legacyResponsesCompaction === undefined) return "disabled";
		if (typeof legacyResponsesCompaction !== "boolean") return "invalid";
		return legacyResponsesCompaction ? "enabled" : "disabled";
	}
	if (!isRecord(config.compaction)) return "invalid";
	if (config.compaction.responsesCompaction === undefined) return "disabled";
	if (typeof config.compaction.responsesCompaction !== "boolean") return "invalid";
	return config.compaction.responsesCompaction ? "enabled" : "disabled";
}

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

function defaultConfig(): PrewalkConfig {
	return {
		executor: { ...DEFAULT_EXECUTOR },
		analytics: structuredClone(DEFAULT_ANALYTICS_CONFIG),
	};
}

function pricingSchedule(cost: ModelCost) {
	return {
		input: cost.input,
		output: cost.output,
		cacheRead: cost.cacheRead,
		cacheWrite: cost.cacheWrite,
		...(cost.tiers ? { tiers: cost.tiers.map((tier) => ({ ...tier })) } : {}),
	};
}

/**
 * Rebuilds pricing for a journal that is being recovered rather than finalized
 * in its own session. Rates come from the registry as it stands now, so
 * `capturedAt` records the recovery time rather than the time of the run.
 */
function journalPricingInputs(
	journal: RunJournal,
	ctx: ExtensionContext,
): Pick<SavingsCalculationInput, "modelMetadata" | "catalog" | "catalogFallbackEnabled"> {
	const catalogFallbackEnabled = journal.configuration.analytics.catalogFallbackEnabled;
	const planner = ctx.modelRegistry.find(
		journal.configuration.planner.provider,
		journal.configuration.planner.model,
	);
	const executor = ctx.modelRegistry.find(
		journal.configuration.executor.provider,
		journal.configuration.executor.model,
	);
	if (!planner || !executor) return { catalogFallbackEnabled };
	const capturedAt = new Date().toISOString();
	const rates = {
		planner: pricingSchedule(planner.cost),
		executor: pricingSchedule(executor.cost),
	};
	return {
		catalogFallbackEnabled,
		modelMetadata: { capturedAt, rates },
		catalog: { catalogDate: capturedAt.slice(0, 10), rates },
	};
}

/**
 * Attributes a primary call by run phase as well as model identity. Matching on
 * the model alone books ordinary planner-model turns as planning for as long as
 * a run object exists, which inflates planner spend on runs that never handed
 * off and on work that continues after a handoff.
 */
function usageRoleFor(run: PrewalkRun, provider: string, model: string): UsageRole {
	const handedOff = handoffState(run) === "completed";
	if (
		handedOff &&
		provider === run.config.executor.provider &&
		model === run.config.executor.model
	) {
		return "executor-primary";
	}
	if (!handedOff && provider === run.planner.provider && model === run.planner.model) {
		return "planner-primary";
	}
	return "auxiliary";
}

function handoffState(run: PrewalkRun): RunJournal["handoffState"] {
	if (run.phase === "failed") return "failed";
	if (run.phase === "handoff-pending") return "pending";
	if (run.phase === "active" || run.phase === "completed") return "completed";
	return "not-started";
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readConfig(): Promise<PrewalkConfig> {
	let raw: string;
	try {
		raw = await readFileAsync(configPath(), "utf8");
	} catch (error) {
		if (isMissingFile(error)) {
			throw new Error("configuration-invalid");
		}
		throw error;
	}
	try {
		return parseConfig(JSON.parse(raw));
	} catch {
		throw new Error("configuration-invalid");
	}
}

async function writeConfig(config: PrewalkConfig): Promise<void> {
	const target = configPath();
	const temporary = `${target}.${process.pid}.tmp`;
	await writeFileAsync(temporary, `${JSON.stringify(config, undefined, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await renameFile(temporary, target);
}

const CONFIG_PAGE_SIZE = 8;

async function selectPaged(
	ctx: ExtensionContext,
	title: string,
	choices: string[],
): Promise<string | undefined> {
	if (choices.length <= CONFIG_PAGE_SIZE) return ctx.ui.select(title, choices);
	const pageCount = Math.ceil(choices.length / CONFIG_PAGE_SIZE);
	let page = 0;
	while (true) {
		const start = page * CONFIG_PAGE_SIZE;
		const visible = choices.slice(start, start + CONFIG_PAGE_SIZE);
		const previous = "← Previous page";
		const next = "Next page →";
		const options = [
			...visible,
			...(page > 0 ? [previous] : []),
			...(page < pageCount - 1 ? [next] : []),
		];
		const selected = await ctx.ui.select(`${title} (${page + 1}/${pageCount})`, options);
		if (!selected) return undefined;
		if (selected === previous) {
			page -= 1;
			continue;
		}
		if (selected === next) {
			page += 1;
			continue;
		}
		return selected;
	}
}

function isPrewalkPrompt(
	message: AgentMessage,
): message is Extract<AgentMessage, { role: "custom" }> {
	return message.role === "custom" && PROMPT_TYPES.has(message.customType);
}

function runIdFromMessage(message: AgentMessage): string | undefined {
	if (!isPrewalkPrompt(message) || !isRecord(message.details)) return undefined;
	return typeof message.details.runId === "string" ? message.details.runId : undefined;
}

function assessmentIdFromMessage(message: AgentMessage): string | undefined {
	if (
		message.role !== "custom" ||
		message.customType !== PREWALK_ASSESS_MESSAGE_TYPE ||
		!isRecord(message.details)
	) {
		return undefined;
	}
	return typeof message.details.assessmentId === "string"
		? message.details.assessmentId
		: undefined;
}

function shouldExposePrompt(
	message: AgentMessage,
	run: PrewalkRun | undefined,
	assessmentId?: string,
): boolean {
	if (message.role === "custom" && message.customType === PREWALK_ASSESS_MESSAGE_TYPE) {
		return assessmentIdFromMessage(message) === assessmentId;
	}
	if (!isPrewalkPrompt(message)) return true;
	const messageRunId = runIdFromMessage(message);
	if (!messageRunId) return false;
	if (!run || messageRunId !== run.id || run.phase === "cancelled") return false;
	if (
		run.phase === "handoff-pending" ||
		run.phase === "active" ||
		run.phase === "completed" ||
		(run.phase === "failed" && run.effectiveRoute === "executor")
	) {
		return (
			message.customType === PREWALK_CONTINUE_MESSAGE_TYPE ||
			message.customType === PREWALK_CHECKLIST_MESSAGE_TYPE
		);
	}
	return message.customType !== PREWALK_CHECKLIST_MESSAGE_TYPE;
}

function isEphemeralPrewalkPrompt(message: AgentMessage): boolean {
	return (
		message.role === "custom" &&
		(message.customType === PREWALK_PLAN_MESSAGE_TYPE ||
			message.customType === PREWALK_ASSESS_MESSAGE_TYPE)
	);
}

function delegatedAgent(value: unknown): string {
	if (!isRecord(value)) return "subagent";
	const raw = typeof value.agent === "string" ? value.agent.trim() : "";
	return raw ? raw.slice(0, 32) : "subagent";
}

function delegatedChildCount(value: unknown): number {
	if (!isRecord(value)) return 1;
	const requestedCount = (item: unknown): number => {
		if (!isRecord(item) || typeof item.count !== "number" || !Number.isSafeInteger(item.count)) {
			return 1;
		}
		return Math.max(1, item.count);
	};
	if (Array.isArray(value.tasks)) {
		return Math.max(
			1,
			value.tasks.reduce((count, item) => count + requestedCount(item), 0),
		);
	}
	if (Array.isArray(value.chain)) {
		return Math.max(
			1,
			value.chain.reduce((count, step) => {
				if (!isRecord(step)) return count + 1;
				return (
					count +
					(Array.isArray(step.parallel)
						? step.parallel.reduce(
								(parallelCount, item) => parallelCount + requestedCount(item),
								0,
							)
						: 1)
				);
			}, 0),
		);
	}
	return 1;
}

function delegationFromResult(
	details: unknown,
	isError: boolean,
	fallbackAgent: string,
): DelegationStatus {
	if (!isRecord(details) || !Array.isArray(details.results)) {
		return {
			agent: fallbackAgent,
			state: isError ? "failed" : "completed",
			...(isError ? { reason: "subagent-tool-failed" } : {}),
		};
	}
	for (const value of details.results) {
		if (!isRecord(value)) continue;
		const agent = delegatedAgent(value);
		if (
			value.timedOut === true ||
			value.stopped === true ||
			value.interrupted === true ||
			(typeof value.exitCode === "number" && value.exitCode !== 0) ||
			typeof value.error === "string"
		) {
			return {
				agent,
				state: "failed",
				reason: value.timedOut === true ? "timed-out" : "subagent-tool-failed",
			};
		}
	}
	return {
		agent: fallbackAgent,
		state: isError ? "failed" : "completed",
		...(isError ? { reason: "subagent-tool-failed" } : {}),
	};
}

function acceptsMutationEvidence(run: PrewalkRun | undefined): boolean {
	return run?.phase === "armed" || run?.phase === "planning" || run?.phase === "ready";
}

function latestAuditRecord(ctx: ExtensionContext) {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== PREWALK_AUDIT_TYPE) {
			continue;
		}
		const record = parseAuditRecord(entry.data);
		if (record) return record;
	}
	return undefined;
}

function latestAutoModeRecord(ctx: ExtensionContext) {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== PREWALK_AUTO_MODE_TYPE) continue;
		const record = parseAutoModeRecord(entry.data);
		if (record) return record;
	}
	return undefined;
}

function latestPrewalkToolSlate(ctx: ExtensionContext, runId: string): string[] | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== PREWALK_TOOL_SLATE_TYPE) continue;
		if (!isRecord(entry.data) || entry.data.runId !== runId || !Array.isArray(entry.data.tools)) {
			continue;
		}
		if (entry.data.tools.every((name) => typeof name === "string")) {
			return [...entry.data.tools];
		}
	}
	return undefined;
}

export default function prewalkExtension(pi: ExtensionAPI): void {
	const coordinator = new PrewalkCoordinator();
	const mutations = new MutationTurnBuffer();
	const evaluationMutations = new MutationTurnBuffer();
	const analyticsStore = new AnalyticsStore(getAgentDir());
	const loadSessionTitles = async (): Promise<ReadonlyMap<string, string>> => {
		const metadataTitles = await readSessionMetadataTitles(getAgentDir());
		const sessionDirectory = process.env.PI_CODING_AGENT_SESSION_DIR;
		const sessions = sessionDirectory
			? await SessionManager.listAll(sessionDirectory)
			: await SessionManager.listAll();
		return mergeSessionTitles(metadataTitles, sessions);
	};
	let activeSessionId: string | undefined;
	let autoEnabled = false;
	let lastOutcome: "bypassed" | "completed" | "failed" | "released" | undefined;
	let pendingAdmission = false;
	let evaluation: EvaluationState | undefined;
	let overlay: ProviderOverlay | undefined;
	let primaryAgentStream = false;
	let todoPhases: TodoPhase[] = [];
	let prewalkToolSlate: string[] | undefined;
	let lastAuditKey: string | undefined;
	let lastStatus: string | undefined;
	let childDiagnostic: string | undefined;
	let delegation: DelegationStatus | undefined;
	let compactionChecklistRunId: string | undefined;
	let executorContextPressure: { runId: string; retry: boolean } | undefined;
	let hostCompactionForExecutor: { runId: string; retry: boolean } | undefined;
	let pendingExecutorCompaction: { runId: string; retry: boolean } | undefined;
	let committedExecutorCompaction: { runId: string; retry: boolean } | undefined;
	let executorCompactionRetry: { runId: string; count: number } | undefined;
	let pendingExecutorFailureRunId: string | undefined;
	let removeTerminalInputListener: (() => void) | undefined;
	let executorCompactionPolicy = DEFAULT_EXECUTOR_COMPACTION_POLICY;
	const refreshExecutorCompactionPolicy = (ctx: ExtensionContext): ExecutorCompactionPolicy => {
		executorCompactionPolicy = readExecutorCompactionPolicy(ctx);
		return executorCompactionPolicy;
	};
	const deactivatePrewalkTools = (): void => {
		const baseline =
			prewalkToolSlate ??
			pi
				.getActiveTools()
				.filter((name) => name !== PREWALK_ASSESS_TOOL_NAME && name !== PREWALK_TODO_TOOL_NAME);
		prewalkToolSlate = undefined;
		pi.setActiveTools([...baseline, PREWALK_TODO_TOOL_NAME]);
	};
	const activatePlanningTools = (toolSlate = pi.getActiveTools()): void => {
		const baseline = toolSlate.filter(
			(name) => name !== PREWALK_ASSESS_TOOL_NAME && name !== PREWALK_TODO_TOOL_NAME,
		);
		prewalkToolSlate ??= baseline;
		pi.setActiveTools([...baseline.filter((name) => name !== "todo"), PREWALK_TODO_TOOL_NAME]);
	};
	const beginEvaluation = (): EvaluationState => {
		const toolSlate = pi.getActiveTools().filter((name) => name !== PREWALK_ASSESS_TOOL_NAME);
		const state: EvaluationState = { id: randomUUID(), toolSlate, invalid: false };
		evaluation = state;
		evaluationMutations.resetForRun();
		pi.setActiveTools([
			...toolSlate.filter((name) => name !== "todo" && name !== PREWALK_TODO_TOOL_NAME),
			PREWALK_TODO_TOOL_NAME,
			PREWALK_ASSESS_TOOL_NAME,
		]);
		return state;
	};
	const restoreEvaluationTools = (): void => {
		if (!evaluation) return;
		pi.setActiveTools(evaluation.toolSlate);
	};
	type ActiveAnalyticsState = {
		journal: RunJournal;
		pricing: {
			capturedAt: string;
			rates: {
				planner: ReturnType<typeof pricingSchedule>;
				executor: ReturnType<typeof pricingSchedule>;
			};
		};
		catalog: {
			catalogDate: string;
			rates: {
				planner: ReturnType<typeof pricingSchedule>;
				executor: ReturnType<typeof pricingSchedule>;
			};
		};
	};
	let analyticsState: ActiveAnalyticsState | undefined;

	let analyticsWrites = Promise.resolve();
	let analyticsFinalization: { runId: string; epoch: string; promise: Promise<void> } | undefined;
	type DelegationInvocation = {
		toolCallId: string;
		rootSessionId: string;
		parentSessionId: string;
		analyticsGeneration: string;
		childCount: number;
		delegationRunId?: string;
	};
	const delegationInvocations: DelegationInvocation[] = [];

	const updateStatus = (ctx: ExtensionContext): void => {
		const nextStatus =
			childDiagnostic && !coordinator.run
				? `prewalk: child ${childDiagnostic}`
				: compactStatus(coordinator.run, ctx.model, ctx.thinkingLevel, delegation, {
						mode: autoEnabled ? "auto-ready" : "manual",
						...(lastOutcome ? { lastOutcome } : {}),
					});
		if (nextStatus === lastStatus) return;
		ctx.ui.setStatus(STATUS_KEY, nextStatus);
		lastStatus = nextStatus;
	};

	const audit = (event: AuditEventKind, ctx: ExtensionContext): void => {
		const run = coordinator.run;
		if (!run) return;
		const record = createAuditRecord(run, event);
		const key = JSON.stringify(record);
		if (key === lastAuditKey) return;
		pi.appendEntry(PREWALK_AUDIT_TYPE, record);
		lastAuditKey = key;
		updateStatus(ctx);
	};

	const setAutoEnabled = (enabled: boolean, ctx: ExtensionContext): void => {
		autoEnabled = enabled;
		pi.appendEntry(
			PREWALK_AUTO_MODE_TYPE,
			createAutoModeRecord(ctx.sessionManager.getSessionId(), enabled),
		);
	};

	const enqueueAnalytics = (operation: () => Promise<void>): Promise<void> => {
		analyticsWrites = analyticsWrites.then(operation, operation);
		return analyticsWrites;
	};

	const resetExecutorCompactionState = (): void => {
		executorContextPressure = undefined;
		hostCompactionForExecutor = undefined;
		pendingExecutorCompaction = undefined;
		committedExecutorCompaction = undefined;
		executorCompactionRetry = undefined;
		pendingExecutorFailureRunId = undefined;
		compactionChecklistRunId = undefined;
	};

	const recordDelegationProjection = async (
		invocation: DelegationInvocation,
		details: unknown,
		isError: boolean,
	): Promise<void> => {
		const evidence = projectDelegationToolResult({
			rootSessionId: invocation.rootSessionId,
			parentSessionId: invocation.parentSessionId,
			invocationId: invocation.toolCallId,
			childCount: invocation.childCount,
			details,
			isError,
		});
		const primaryDelegationRunId = evidence[0]?.delegationRunId;
		if (primaryDelegationRunId) invocation.delegationRunId = primaryDelegationRunId;
		for (const item of evidence) {
			try {
				if (invocation.analyticsGeneration !== (await analyticsStore.currentGeneration()))
					continue;
				const { schemaVersion, ...eventValue } = item;
				await enqueueAnalytics(async () => {
					await analyticsStore.writeDelegationEvidence(
						{ ...eventValue, version: schemaVersion },
						invocation.analyticsGeneration,
					);
				});
			} catch {
				// Delegation analytics are best-effort and must not block routing.
			}
		}
	};

	pi.events.on("subagent:async-complete", (payload) => {
		if (!isRecord(payload)) return;
		const runId = typeof payload.runId === "string" ? payload.runId : undefined;
		if (!runId) return;
		const invocation = delegationInvocations.find(
			(candidate) => candidate.delegationRunId === runId,
		);
		if (!invocation) return;
		void recordDelegationProjection(invocation, payload, payload.success === false);
	});

	const openAnalyticsJournal = async (run: PrewalkRun, ctx: ExtensionContext): Promise<void> => {
		analyticsState = undefined;
		analyticsFinalization = undefined;
		const analytics = run.config.analytics ?? DEFAULT_ANALYTICS_CONFIG;
		if (!analytics.enabled) return;
		const planner = ctx.modelRegistry.find(run.planner.provider, run.planner.model);
		const executor = ctx.modelRegistry.find(
			run.config.executor.provider,
			run.config.executor.model,
		);
		if (!planner || !executor) return;
		const generation = await analyticsStore.currentGeneration();
		const journal: RunJournal = {
			schemaVersion: ANALYTICS_SCHEMA_VERSION,
			runId: run.id,
			epoch: run.epoch,
			sessionId: ctx.sessionManager.getSessionId(),
			generation,
			configuration: {
				analytics: structuredClone(analytics),
				planner: { provider: run.planner.provider, model: run.planner.model },
				executor: { provider: run.config.executor.provider, model: run.config.executor.model },
			},
			startedAt: new Date().toISOString(),
			lastObservedSequence: 0,
			evidenceKeys: [],
			outcome: "active",
			handoffState: handoffState(run),
			usage: [],
		};
		const pricing = {
			capturedAt: new Date().toISOString(),
			rates: {
				planner: pricingSchedule(planner.cost),
				executor: pricingSchedule(executor.cost),
			},
		};
		const catalog = { catalogDate: pricing.capturedAt.slice(0, 10), rates: pricing.rates };
		await analyticsStore.writeJournal(journal);
		analyticsState = { journal, pricing, catalog };
	};

	const restoreAnalyticsJournal = async (
		run: PrewalkRun,
		ctx: ExtensionContext,
	): Promise<void> => {
		analyticsState = undefined;
		analyticsFinalization = undefined;
		const analytics = run.config.analytics ?? DEFAULT_ANALYTICS_CONFIG;
		if (!analytics.enabled) return;
		const journal = await analyticsStore.restoreJournal(run.id, run.epoch);
		if (!journal) return;
		const planner = ctx.modelRegistry.find(run.planner.provider, run.planner.model);
		const executor = ctx.modelRegistry.find(
			run.config.executor.provider,
			run.config.executor.model,
		);
		if (!planner || !executor) return;
		const pricing = {
			capturedAt: new Date().toISOString(),
			rates: {
				planner: pricingSchedule(planner.cost),
				executor: pricingSchedule(executor.cost),
			},
		};
		const catalog = { catalogDate: pricing.capturedAt.slice(0, 10), rates: pricing.rates };
		analyticsState = { journal, pricing, catalog };
	};

	const recordAnalyticsUsage = (
		_source: UsageObservationSource,
		evidenceId: string,
		provider: string,
		model: string,
		role: UsageRole,
		usage: Usage,
	): Promise<void> => {
		const state = analyticsState;
		if (!state) return Promise.resolve();
		const observation = {
			sequence: state.journal.lastObservedSequence + 1,
			evidenceId,
			source: _source,
			provider,
			model,
			role,
			final: true,
			usage: { ...usage },
		};
		const key = usageEvidenceKey(observation);
		let evidenceKeys = state.journal.evidenceKeys;
		if (evidenceKeys === undefined) {
			evidenceKeys = [];
			state.journal.evidenceKeys = evidenceKeys;
		}
		if (evidenceKeys.includes(key)) return Promise.resolve();
		state.journal.lastObservedSequence = observation.sequence;
		evidenceKeys.push(key);
		// Keep the journal's handoff state current so a journal recovered after a
		// crash reports the handoff that actually happened.
		if (coordinator.run) state.journal.handoffState = handoffState(coordinator.run);
		const [slice] = normalizeUsageObservations([observation]);
		if (slice) state.journal.usage.push(slice);
		return enqueueAnalytics(async () => {
			await analyticsStore.writeJournal(state.journal);
		});
	};

	const finalizeAnalytics = (outcome: RunOutcome): Promise<void> => {
		const state = analyticsState;
		if (!state) return analyticsWrites;
		if (analyticsFinalization) {
			if (
				analyticsFinalization.runId === state.journal.runId &&
				analyticsFinalization.epoch === state.journal.epoch
			)
				return analyticsFinalization.promise;
			analyticsFinalization = undefined;
		}
		const { journal, pricing } = state;
		const promise = enqueueAnalytics(async () => {
			journal.outcome = outcome;
			journal.handoffState = coordinator.run
				? handoffState(coordinator.run)
				: journal.handoffState;
			const calculation = calculateSavings({
				outcome,
				handoffState: journal.handoffState,
				usage: journal.usage,
				modelMetadata: pricing,
				catalog: state.catalog,
				catalogFallbackEnabled: journal.configuration.analytics.catalogFallbackEnabled,
			});
			const receipt: RunReceipt = {
				schemaVersion: ANALYTICS_SCHEMA_VERSION,
				runId: journal.runId,
				epoch: journal.epoch,
				sessionId: journal.sessionId,
				generation: journal.generation,
				startedAt: journal.startedAt,
				completedAt: new Date().toISOString(),
				outcome,
				handoffState: journal.handoffState,
				planner: journal.configuration.planner,
				executor: journal.configuration.executor,
				usage: journal.usage,
				actualCost: calculation.actualCost,
				estimate: calculation.estimate,
				pricingEvidence: calculation.pricingEvidence,
				pricing: pricing.rates,
				evidenceKeys: [...(journal.evidenceKeys ?? [])],
				...(journal.lineage === undefined ? {} : { lineage: journal.lineage }),
			};
			try {
				await analyticsStore.promoteReceipt(receipt);
			} catch (error) {
				// Another session may have recovered this run while it was idle. The
				// owning session holds the fuller record, so it reclaims the receipt.
				if ((await analyticsStore.supersedeRecoveredReceipt(receipt)) === null) throw error;
			}
			if (analyticsState === state) analyticsState = undefined;
		}).catch((error) => {
			if (analyticsFinalization?.promise === promise) analyticsFinalization = undefined;
			throw error;
		});
		analyticsFinalization = { runId: journal.runId, epoch: journal.epoch, promise };
		return promise;
	};

	const finalizeInterruptedAnalytics = async (
		sessionId: string,
		ctx: ExtensionContext,
	): Promise<void> => {
		await analyticsWrites;
		const records = await analyticsStore.listUnfinishedJournalRecords();
		const staleBefore = Date.now() - ORPHAN_JOURNAL_STALE_MS;
		for (const { journal, modifiedAt } of records) {
			// The owning session recovers its own journals immediately. Another
			// session's journal is only claimed once it has gone quiet long enough
			// that the session cannot still be writing to it.
			if (journal.sessionId !== sessionId && modifiedAt > staleBefore) continue;
			// A journal whose finalization already recorded a terminal outcome keeps
			// it; only genuinely mid-flight runs are recorded as interrupted.
			const outcome: RunOutcome = journal.outcome === "active" ? "interrupted" : journal.outcome;
			const pricingInputs = journalPricingInputs(journal, ctx);
			const calculation = calculateSavings({
				outcome,
				handoffState: journal.handoffState,
				usage: journal.usage,
				...pricingInputs,
			});
			const recovered: RunReceipt = {
				schemaVersion: ANALYTICS_SCHEMA_VERSION,
				runId: journal.runId,
				epoch: journal.epoch,
				sessionId: journal.sessionId,
				generation: journal.generation,
				startedAt: journal.startedAt,
				completedAt: new Date().toISOString(),
				outcome,
				handoffState: journal.handoffState,
				planner: journal.configuration.planner,
				executor: journal.configuration.executor,
				usage: journal.usage,
				actualCost: calculation.actualCost,
				estimate: calculation.estimate,
				pricingEvidence: calculation.pricingEvidence,
				...(pricingInputs.modelMetadata === undefined
					? {}
					: { pricing: pricingInputs.modelMetadata.rates }),
				evidenceKeys: [...(journal.evidenceKeys ?? [])],
				...(journal.lineage === undefined ? {} : { lineage: journal.lineage }),
			};
			try {
				await analyticsStore.promoteReceipt(recovered);
			} catch (error) {
				// The journal outlived a receipt that captured only part of the run.
				// Supersession accepts it only because it holds strictly more evidence.
				if ((await analyticsStore.supersedeRecoveredReceipt(recovered)) === null) throw error;
			}
		}
	};

	const fail = (reasonCode: string, holdExecutorRoute: boolean, ctx: ExtensionContext): void => {
		resetExecutorCompactionState();
		if (!coordinator.run) {
			if (!ctx.model) {
				ctx.ui.notify(`Prewalk failed: ${reasonCode}.`, "error");
				return;
			}
			coordinator.arm(
				randomUUID(),
				randomUUID(),
				"automatic",
				pi.getActiveTools().includes(PREWALK_TODO_TOOL_NAME),
				{
					provider: ctx.model.provider,
					model: ctx.model.id,
					reasoning: ctx.thinkingLevel ?? "off",
				},
				defaultConfig(),
			);
		}
		coordinator.fail(reasonCode, holdExecutorRoute);
		overlay?.restore();
		overlay = undefined;
		mutations.resetForRun();
		audit("failed", ctx);
		if (
			reasonCode === "executor-stream-failed" ||
			(reasonCode !== "provider-drift" && (analyticsState?.journal.usage.length ?? 0) > 0)
		) {
			void finalizeAnalytics("failed").catch(() => {
				ctx.ui.notify("Prewalk analytics finalization failed; retrying is safe.", "error");
			});
		}
		deactivatePrewalkTools();
		ctx.ui.notify(`Prewalk failed: ${reasonCode}.`, "error");
	};

	const cancel = async (selectedModelIsPlanner: boolean, ctx: ExtensionContext): Promise<void> => {
		resetExecutorCompactionState();
		coordinator.cancel(selectedModelIsPlanner);
		mutations.resetForRun();
		audit("cancelled", ctx);
		await finalizeAnalytics("cancelled");
		overlay?.restore();
		overlay = undefined;
	};

	const release = async (ctx: ExtensionContext): Promise<void> => {
		const run = coordinator.run;
		if (
			!run ||
			run.effectiveRoute !== "executor" ||
			(run.phase !== "active" && run.phase !== "completed")
		) {
			ctx.ui.notify("Prewalk release is valid only after the executor handoff.", "error");
			return;
		}
		resetExecutorCompactionState();
		coordinator.release();
		audit("manual-release", ctx);
		await finalizeAnalytics("released");
		overlay?.restore();
		overlay = undefined;
		coordinator.reset();
		mutations.resetForRun();
		lastOutcome = "released";
		deactivatePrewalkTools();
		updateStatus(ctx);
		ctx.ui.notify("Prewalk released; the planner is active again.", "info");
	};

	const ensureOverlay = (ctx: ExtensionContext): ProviderOverlay => {
		if (overlay) return overlay;
		const run = coordinator.run;
		if (!run) throw new Error("Prewalk is inactive.");
		const candidate = createProviderOverlay(pi, ctx.modelRegistry, run.planner, run.config, {
			shouldRouteToExecutor: () =>
				coordinator.run?.phase === "handoff-pending" ||
				coordinator.run?.effectiveRoute === "executor",
			isPrimaryAgentStream: () => primaryAgentStream,
			currentRunId: () => coordinator.run?.id,
			getExecutorCompactionReserveTokens: () => executorCompactionPolicy.reserveTokens,
			prepareExecutorContext: (context) => removeExactUserPrompt(context, prompts.plan),
			onExecutorStreamStarted: async (runId) => {
				if (pendingExecutorFailureRunId === runId) pendingExecutorFailureRunId = undefined;
				if (coordinator.run?.id !== runId || coordinator.run.phase !== "handoff-pending") {
					return;
				}
				try {
					coordinator.activateExecutor();
					audit("executor-active", ctx);
				} catch {
					fail("provider-drift", false, ctx);
					await analyticsWrites;
				}
			},
			onExecutorStreamSucceeded: async (runId) => {
				if (pendingExecutorFailureRunId === runId) pendingExecutorFailureRunId = undefined;
				if (executorCompactionRetry?.runId === runId) executorCompactionRetry = undefined;
				if (coordinator.run?.id !== runId || coordinator.run.phase !== "active") return;
				try {
					coordinator.completeHandoff();
					audit("handoff-completed", ctx);
				} catch {
					fail("provider-drift", true, ctx);
					await analyticsWrites;
				}
			},
			onExecutorStreamFailed: async (runId) => {
				if (coordinator.run?.id !== runId) return;
				pendingExecutorFailureRunId = runId;
			},
			onExecutorContextPressure: (runId, retry) => {
				if (coordinator.run?.id !== runId) return;
				pendingExecutorFailureRunId = undefined;
				executorContextPressure = { runId, retry };
			},
			onProviderDrift: () =>
				fail("provider-drift", coordinator.run?.effectiveRoute === "executor", ctx),
		});
		candidate.install();
		overlay = candidate;
		return candidate;
	};

	const verifyOverlayOwnership = (ctx: ExtensionContext): boolean => {
		if (
			!overlay ||
			overlay.ownsRegistration() ||
			coordinator.run?.phase === "cancelled" ||
			coordinator.run?.phase === "failed"
		) {
			return true;
		}
		fail("provider-drift", coordinator.run?.effectiveRoute === "executor", ctx);
		return false;
	};

	/**
	 * Validates the planner, then picks the first usable executor from the
	 * configured chain.
	 *
	 * Planner problems still throw: with no valid selected model there is nothing
	 * to hand off from. An unusable executor chain is returned rather than thrown,
	 * so the caller can leave Prewalk unarmed instead of taking the session down
	 * with it.
	 */
	const resolveExecutor = async (
		plannerProfile: PlannerProfile,
		config: PrewalkConfig,
		ctx: ExtensionContext,
	): Promise<ExecutorChainResolution> => {
		const planner = ctx.modelRegistry.find(plannerProfile.provider, plannerProfile.model);
		if (!planner || !isPlannerSelected(ctx.model, plannerProfile)) {
			throw new Error("model-unavailable");
		}
		if (planner.contextWindow <= 0 || planner.maxTokens <= 0) {
			throw new Error("model-unavailable");
		}
		const plannerAuth = await ctx.modelRegistry.getApiKeyAndHeaders(planner);
		if (!plannerAuth.ok) throw new Error("authorization-unavailable");

		// Planner and executor may sit on different providers and APIs. Pi
		// normalizes replayed history for whichever model receives the request:
		// api/transform-messages.ts downgrades another model's thinking blocks to
		// plain text, drops redacted thinking and signatures, and renormalizes tool
		// call ids. A same-provider pair on two different model ids already takes
		// that same path, so a cross-provider pair adds no further degradation.
		const fallbackChain =
			config.executorFallbacks ??
			inferDefaultExecutorChain(
				planner.provider,
				ctx.modelRegistry.getAvailable(),
				config.executor.reasoning,
			);
		return resolveExecutorChain(
			planner,
			plannerProfile.reasoning,
			[config.executor, ...fallbackChain],
			{
				find: (provider, model) => ctx.modelRegistry.find(provider, model),
				hasAuth: async (target) => (await ctx.modelRegistry.getApiKeyAndHeaders(target)).ok,
			},
		);
	};

	const sendPrompt = async (
		type:
			| typeof PREWALK_PLAN_MESSAGE_TYPE
			| typeof PREWALK_CONTINUE_MESSAGE_TYPE
			| typeof PREWALK_CHECKLIST_MESSAGE_TYPE,
		ctx: ExtensionContext,
		triggerTurn = false,
	): Promise<void> => {
		const run = coordinator.run;
		if (!run) return;
		let prompt: { content: string; event: AuditEventKind };
		switch (type) {
			case PREWALK_PLAN_MESSAGE_TYPE:
				prompt = { content: prompts.plan, event: "plan-injected" };
				break;
			case PREWALK_CONTINUE_MESSAGE_TYPE:
				prompt = { content: prompts.continue, event: "continuation" };
				break;
			case PREWALK_CHECKLIST_MESSAGE_TYPE:
				prompt = { content: prompts.checklist, event: "handoff-triggered" };
				break;
		}
		pi.sendMessage(
			{
				customType: type,
				content: prompt.content,
				display: false,
				details: { runId: run.id },
			},
			triggerTurn ? { triggerTurn: true } : { deliverAs: "steer" },
		);
		audit(prompt.event, ctx);
	};

	/**
	 * Supplements Pi's planner-sized compaction with an executor-sized watchdog.
	 * The public API can trigger Pi's own compactor, but it cannot change the
	 * model Pi uses to size it; the overlay therefore stops an executor request
	 * before transport and this callback compacts the shared session safely from
	 * the following turn boundary. Failed requests retry the checklist at most once
	 * per pressure sequence; completed responses do not replay their answer.
	 */
	const requestExecutorCompaction = (ctx: ExtensionContext, retry: boolean): void => {
		const run = coordinator.run;
		if (
			!run ||
			(run.phase !== "handoff-pending" && run.phase !== "active" && run.phase !== "completed") ||
			pendingExecutorCompaction
		) {
			return;
		}
		const policy = refreshExecutorCompactionPolicy(ctx);
		if (!policy.enabled) {
			executorContextPressure = undefined;
			ctx.ui.notify(
				"Prewalk stopped before an oversized executor request because Pi automatic compaction is disabled.",
				"error",
			);
			fail("executor-compaction-failed", false, ctx);
			return;
		}
		if (
			retry &&
			executorCompactionRetry?.runId === run.id &&
			executorCompactionRetry.count >= 1
		) {
			fail("executor-compaction-failed", false, ctx);
			return;
		}
		const request = { runId: run.id, retry } as const;
		if (retry) {
			executorCompactionRetry = {
				runId: run.id,
				count:
					(executorCompactionRetry?.runId === run.id ? executorCompactionRetry.count : 0) + 1,
			};
		}
		pendingExecutorCompaction = request;
		committedExecutorCompaction = undefined;
		const retryChecklist = (): void => {
			void sendPrompt(PREWALK_CHECKLIST_MESSAGE_TYPE, ctx, true).catch(() => {
				if (coordinator.run?.id === request.runId) {
					fail("executor-compaction-failed", false, ctx);
				}
			});
		};
		try {
			ctx.compact({
				onComplete: () => {
					if (pendingExecutorCompaction !== request) return;
					pendingExecutorCompaction = undefined;
					executorContextPressure = undefined;
					const current = coordinator.run;
					if (
						!current ||
						current.id !== request.runId ||
						(current.phase !== "handoff-pending" &&
							current.phase !== "active" &&
							current.phase !== "completed")
					) {
						return;
					}
					if (request.retry) {
						retryChecklist();
					}
				},
				onError: (error) => {
					if (pendingExecutorCompaction !== request) return;
					if (committedExecutorCompaction === request) {
						pendingExecutorCompaction = undefined;
						committedExecutorCompaction = undefined;
						executorContextPressure = undefined;
						const current = coordinator.run;
						if (
							!current ||
							current.id !== request.runId ||
							(current.phase !== "handoff-pending" &&
								current.phase !== "active" &&
								current.phase !== "completed")
						) {
							return;
						}
						ctx.ui.notify(
							`Prewalk executor compaction committed before the host reported an observer error (${error.message}); continuing from the compacted context.`,
							"warning",
						);
						if (!request.retry) return;
						retryChecklist();
						return;
					}
					pendingExecutorCompaction = undefined;
					executorContextPressure = undefined;
					if (coordinator.run?.id !== request.runId) return;
					ctx.ui.notify(`Prewalk executor compaction failed: ${error.message}.`, "error");
					fail("executor-compaction-failed", false, ctx);
				},
			});
		} catch (error) {
			if (pendingExecutorCompaction !== request) return;
			pendingExecutorCompaction = undefined;
			committedExecutorCompaction = undefined;
			executorContextPressure = undefined;
			ctx.ui.notify(
				`Prewalk executor compaction failed: ${error instanceof Error ? error.message : String(error)}.`,
				"error",
			);
			fail("executor-compaction-failed", false, ctx);
		}
	};

	/**
	 * Reports whether the run took hold, so a caller such as the child path can
	 * explain an unarmed session instead of leaving the reason nowhere.
	 */
	const startRun = async (
		mode: "automatic" | "manual",
		ctx: ExtensionContext,
		triggerTurn = false,
		configOverride?: PrewalkConfig,
	): Promise<"armed" | "executor-unavailable" | "failed"> => {
		try {
			const config = configOverride ?? (await readConfig());
			const compactionState = nativeResponsesCompactionState();
			if (compactionState === "invalid") throw new Error("configuration-invalid");
			if (compactionState === "enabled") {
				throw new Error("native-compaction-unsupported");
			}
			activatePlanningTools();
			if (!ctx.model) throw new Error("model-unavailable");
			const planner: PlannerProfile = {
				provider: ctx.model.provider,
				model: ctx.model.id,
				reasoning: ctx.thinkingLevel ?? "off",
			};
			const resolution = await resolveExecutor(planner, config, ctx);
			if (!resolution.ok) {
				// Prewalk is an optimization, not a prerequisite. An unusable executor
				// leaves the session on its planner rather than failing the run, which
				// is the correction Oh My Pi made in issue #6064 after the strict
				// version locked users out.
				deactivatePrewalkTools();
				ctx.ui.notify(unavailableExecutorNotice(resolution.rejected), "error");
				updateStatus(ctx);
				return "executor-unavailable";
			}
			const effectiveConfig: PrewalkConfig = { ...config, executor: resolution.executor };
			const todoActive = pi.getActiveTools().includes(PREWALK_TODO_TOOL_NAME);
			const action = coordinator.arm(
				randomUUID(),
				randomUUID(),
				mode,
				todoActive,
				planner,
				effectiveConfig,
			);
			const armedRun = coordinator.run;
			if (armedRun && prewalkToolSlate) {
				pi.appendEntry(PREWALK_TOOL_SLATE_TYPE, {
					schemaVersion: 1,
					runId: armedRun.id,
					tools: [...prewalkToolSlate],
				});
			}
			refreshExecutorCompactionPolicy(ctx);
			ensureOverlay(ctx);
			if (armedRun) {
				await openAnalyticsJournal(armedRun, ctx).catch(() => {
					analyticsState = undefined;
					ctx.ui.notify("Prewalk analytics could not start; routing is unchanged.", "error");
				});
			}
			mutations.resetForRun();
			audit("armed", ctx);
			if (action.type === "send-planning") {
				await sendPrompt(PREWALK_PLAN_MESSAGE_TYPE, ctx, triggerTurn);
			}
			return "armed";
		} catch (error) {
			const reason =
				error instanceof Error &&
				[
					"configuration-invalid",
					"model-unavailable",
					"authorization-unavailable",
					"provider-unavailable",
					"provider-drift",
					"native-compaction-unsupported",
				].includes(error.message)
					? error.message
					: "provider-unavailable";
			fail(reason, false, ctx);
			return "failed";
		}
	};

	const startExperimentalChildRun = async (ctx: ExtensionContext): Promise<void> => {
		if (process.env.PI_SUBAGENT_CHILD !== "1") return;
		const identity = childIdentity();
		if (!identity) {
			childDiagnostic = "identity-unavailable";
			updateStatus(ctx);
			return;
		}
		let config: PrewalkConfig;
		try {
			config = await readConfig();
		} catch {
			childDiagnostic = "configuration-invalid";
			updateStatus(ctx);
			return;
		}
		const feature = config.experimentalChild;
		if (!feature?.enabled) {
			childDiagnostic = "experimental-disabled";
			updateStatus(ctx);
			return;
		}
		const target = feature.agents[identity.agent];
		if (!target) {
			childDiagnostic = "agent-not-opted-in";
			updateStatus(ctx);
			return;
		}
		if (target.mode !== "implementation") {
			childDiagnostic = target.mode === "plan" ? "plan-mode" : "read-only";
			updateStatus(ctx);
			return;
		}
		if (!pi.getActiveTools().some((tool) => CHILD_MUTATION_TOOLS.has(tool))) {
			childDiagnostic = "read-only";
			updateStatus(ctx);
			return;
		}
		const targetModel = ctx.modelRegistry.find(target.executor.provider, target.executor.model);
		if (
			ctx.model &&
			targetModel &&
			isSameModelAtEffectiveReasoning(
				ctx.model,
				ctx.thinkingLevel ?? "off",
				targetModel,
				target.executor.reasoning,
			)
		) {
			childDiagnostic = "equal-target";
			updateStatus(ctx);
			return;
		}
		childDiagnostic = undefined;
		// A child runs the executor its own agent entry names. Session-level
		// fallbacks belong to the parent and must not silently redirect a child to
		// a model nobody opted it into.
		const outcome = await startRun("automatic", ctx, false, {
			...config,
			executor: target.executor,
			executorFallbacks: [],
		});
		if (outcome === "executor-unavailable") {
			// Without this the child reports no diagnostic at all, so `/prewalk
			// status` cannot say why the hand-off never happened.
			childDiagnostic = "executor-unavailable";
			updateStatus(ctx);
		}
	};

	const configure = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) {
			ctx.ui.notify("/prewalk configure requires Pi's interactive UI.", "error");
			return;
		}
		const available = ctx.modelRegistry.getAvailable();
		const planner = ctx.model;
		if (!planner) {
			ctx.ui.notify("Select a planner model in Pi before configuring Prewalk.", "error");
			return;
		}
		// Any authorized model can execute, including one on another provider. The
		// planner's own provider is offered first because it is the least surprising
		// pairing, not because the others are unsupported.
		const executorCandidates = available
			// The planner's own model stays on the list: routing it at a lower effective
			// effort is a real downgrade, and only the same effective effort is a no-op.
			// The reasoning step below applies the model's clamping before rejecting that
			// pairing. A smaller executor is protected by the request-time context
			// watchdog in the provider overlay.
			.filter((model) => model.maxTokens > 0)
			.sort((left, right) => {
				const leftHome = left.provider === planner.provider ? 0 : 1;
				const rightHome = right.provider === planner.provider ? 0 : 1;
				if (leftHome !== rightHome) return leftHome - rightHome;
				return `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`);
			});
		if (executorCandidates.length === 0) {
			ctx.ui.notify("No authorized model can execute for that planner.", "error");
			return;
		}
		const executorChoices = executorCandidates.map((model) => `${model.provider}/${model.id}`);
		const executorChoice = await selectPaged(ctx, "Prewalk executor", executorChoices);
		if (!executorChoice) return;
		const executor = executorCandidates.find(
			(model) => `${model.provider}/${model.id}` === executorChoice,
		);
		if (!executor) {
			ctx.ui.notify("The selected executor is no longer available.", "error");
			return;
		}
		let savedConfig: PrewalkConfig | undefined;
		try {
			savedConfig = await readConfig();
		} catch {
			// A broken or missing config should not prevent the repair wizard.
		}
		const savedReasoning =
			savedConfig?.executor.provider === executor.provider &&
			savedConfig.executor.model === executor.id
				? savedConfig.executor.reasoning
				: undefined;
		const preferredReasoning = savedReasoning ?? DEFAULT_EXECUTOR.reasoning;
		const reasoningChoices = [
			preferredReasoning,
			...REASONING_LEVELS.filter((level) => level !== preferredReasoning),
		];
		const reasoningChoice = await ctx.ui.select("Luna/executor reasoning", reasoningChoices);
		if (!isReasoningLevel(reasoningChoice)) return;
		// Mirrors the resolver's same-as-planner rule, so the wizard cannot save a
		// pairing that would immediately be rejected at arm time.
		if (
			isSameModelAtEffectiveReasoning(
				planner,
				ctx.thinkingLevel ?? "off",
				executor,
				reasoningChoice,
			)
		) {
			ctx.ui.notify(
				"That is the model already running at the same effective reasoning level, so there is nothing to hand off to. Pick a different model or a lower reasoning level.",
				"error",
			);
			return;
		}
		const savedAnalytics = savedConfig?.analytics ?? DEFAULT_ANALYTICS_CONFIG;
		const collectionChoice = await ctx.ui.select("Analytics collection", [
			savedAnalytics.enabled ? "enabled" : "disabled",
			savedAnalytics.enabled ? "disabled" : "enabled",
		]);
		if (collectionChoice !== "enabled" && collectionChoice !== "disabled") return;
		const catalogChoice = await ctx.ui.select("Catalog fallback estimates", [
			savedAnalytics.catalogFallbackEnabled ? "enabled" : "disabled",
			savedAnalytics.catalogFallbackEnabled ? "disabled" : "enabled",
		]);
		if (catalogChoice !== "enabled" && catalogChoice !== "disabled") return;
		const nextConfig: PrewalkConfig = {
			executor: {
				provider: executor.provider,
				model: executor.id,
				reasoning: reasoningChoice,
			},
			analytics: {
				enabled: collectionChoice === "enabled",
				catalogFallbackEnabled: catalogChoice === "enabled",
				recentReceiptCount: savedAnalytics.recentReceiptCount,
				schemaVersion: ANALYTICS_SCHEMA_VERSION,
			},
			// The wizard only edits the primary executor. A hand-written fallback
			// chain survives it rather than being silently dropped.
			...(savedConfig?.executorFallbacks === undefined
				? {}
				: { executorFallbacks: savedConfig.executorFallbacks }),
			...(savedConfig?.experimentalChild === undefined
				? {}
				: { experimentalChild: savedConfig.experimentalChild }),
		};
		const confirmed = await ctx.ui.confirm(
			"Save Prewalk configuration?",
			`${planner.provider}/${planner.id} plans, then ${executorChoice} executes at ${reasoningChoice} reasoning.`,
		);
		if (!confirmed) return;
		await writeConfig(nextConfig);
		ctx.ui.notify("Prewalk configuration saved.", "info");
	};

	const showStats = async (argumentsText: string, ctx: ExtensionContext): Promise<void> => {
		await analyticsWrites;
		const input = argumentsText.trim();
		try {
			if (input.startsWith("benchmark ")) {
				const source = input.slice("benchmark ".length).trim();
				if (!source) throw new Error("missing-benchmark-path");
				const summary = JSON.parse(await readFileAsync(source, "utf8"));
				await analyticsStore.writeVerifiedBenchmarkSummary(summary);
				ctx.ui.notify("Verified benchmark evidence imported.", "info");
				return;
			}
			if (input.startsWith("export ")) {
				const destination = input.slice("export ".length).trim();
				if (!destination) throw new Error("missing-export-path");
				const count = await analyticsStore.exportJsonLines(destination);
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
				const excluded = analyticsState !== undefined;
				const result = await analyticsStore.reset();
				analyticsState = undefined;
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
				const result = await analyticsStore.retryRetiredGenerationCleanup();
				ctx.ui.notify(
					result.cleanupComplete
						? "Retired analytics cleanup complete."
						: `Retired analytics cleanup remains incomplete for ${result.remainingRetiredGenerations.length} generation(s); run /prewalk stats cleanup to retry.`,
					result.cleanupComplete ? "info" : "error",
				);
				return;
			}
			if (input === "task") {
				const report = await analyticsStore.taskTree(ctx.sessionManager.getSessionId());
				ctx.ui.notify(renderTaskTreeReport(report, await loadSessionTitles()), "info");
				return;
			}
			if (input.startsWith("receipt ")) {
				const runId = input.slice("receipt ".length).trim();
				const receipt = (await analyticsStore.listReceipts()).find(
					(candidate) => candidate.runId === runId,
				);
				if (!receipt) {
					ctx.ui.notify(`No analytics receipt found for run ${runId}.`, "error");
					return;
				}
				const sessionTitles = await loadSessionTitles();
				ctx.ui.notify(renderReceiptReport(receipt, sessionTitles), "info");
				return;
			}
			const successfulOnly = input === "--successful";
			if (input && !successfulOnly) throw new Error("unknown-stats-arguments");
			const outcomes: readonly RunOutcome[] | undefined = successfulOnly
				? ["succeeded"]
				: undefined;
			const common = outcomes ? { outcomes } : {};
			const loadOverview = async () => {
				await analyticsWrites;
				const analytics = coordinator.run?.config.analytics ?? DEFAULT_ANALYTICS_CONFIG;
				const snapshot = await analyticsStore.snapshot();
				const now = new Date();
				const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
				const sessionId = ctx.sessionManager.getSessionId();
				const [lifetime, month, week, session] = await Promise.all([
					analyticsStore.aggregate(
						{
							...common,
							window: "lifetime",
							recentLimit: analytics.recentReceiptCount,
							now,
							timeZone,
						},
						snapshot,
					),
					analyticsStore.aggregate({ ...common, window: "month", now, timeZone }, snapshot),
					analyticsStore.aggregate({ ...common, window: "week", now, timeZone }, snapshot),
					analyticsStore.aggregate(
						{
							...common,
							now,
							timeZone,
							sessionId,
						},
						snapshot,
					),
				]);
				const verifiedBenchmark = await analyticsStore.readVerifiedBenchmarkSummary();
				const sessionTitles = await loadSessionTitles();
				return {
					generatedAt: now.toISOString(),
					sessionId,
					lifetime,
					month,
					week,
					session,
					verifiedBenchmark: verifiedBenchmark ?? undefined,
					sessionTitles,
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
	};

	pi.registerTool({
		name: PREWALK_TODO_TOOL_NAME,
		label: "Prewalk Todo",
		description: "Create and maintain the phased implementation checklist required by Prewalk.",
		parameters: TodoParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (
				!coordinator.run ||
				coordinator.run.phase === "cancelled" ||
				coordinator.run.phase === "failed"
			) {
				throw new Error("Prewalk todo is inactive.");
			}
			const input: TodoInput = {
				op: params.op,
				...(params.list ? { list: params.list } : {}),
				...(params.task ? { task: params.task } : {}),
				...(params.phase ? { phase: params.phase } : {}),
				...(params.items ? { items: params.items } : {}),
				...(params.reason ? { reason: params.reason } : {}),
			};
			const result = applyTodoOperation(todoPhases, input);
			if (result.isError) throw new Error(result.text);
			todoPhases = result.details.phases;
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
			};
		},
	});

	pi.registerTool({
		name: PREWALK_ASSESS_TOOL_NAME,
		label: "Prewalk assessment",
		description:
			"Record whether substantial implementation work remains after bounded inspection.",
		parameters: AssessmentParameters,
		async execute(_toolCallId, params) {
			if (!evaluation || evaluation.invalid || evaluation.decision) {
				throw new Error("Prewalk assessment is inactive.");
			}
			if (params.decision !== "continue" && params.decision !== "bypass") {
				throw new Error("Prewalk assessment decision is invalid.");
			}
			evaluation.decision = params.decision;
			return { content: [{ type: "text", text: "Assessment recorded." }], details: {} };
		},
	});

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
				if (childDiagnostic && !coordinator.run) {
					ctx.ui.notify(`Experimental child Prewalk: ${childDiagnostic}.`, "info");
					return;
				}
				ctx.ui.notify(
					detailedStatus(coordinator.run, ctx.model, ctx.thinkingLevel, delegation, {
						mode: autoEnabled ? "auto-ready" : "manual",
						...(lastOutcome ? { lastOutcome } : {}),
					}),
					"info",
				);
				return;
			}
			if (command === "cancel") {
				const run = coordinator.run;
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
				setAutoEnabled(false, ctx);
				updateStatus(ctx);
				if (evaluation) {
					restoreEvaluationTools();
					evaluation = undefined;
				}
				pendingAdmission = false;
				if (coordinator.run) {
					await cancel(isPlannerSelected(ctx.model, coordinator.run.planner), ctx);
					deactivatePrewalkTools();
				}
				ctx.ui.notify("Prewalk automatic mode disabled for this session.", "info");
				return;
			}
			if (command === "release") {
				await release(ctx);
				return;
			}
			if (command === "stats" || command.startsWith("stats ")) {
				await showStats(command.slice("stats".length), ctx);
				return;
			}
			if (command === "run") {
				if (
					coordinator.run &&
					coordinator.run.phase !== "cancelled" &&
					coordinator.run.phase !== "failed"
				) {
					ctx.ui.notify("Prewalk is already active.", "error");
					return;
				}
				await startRun("manual", ctx);
				return;
			}
			if (command === "auto") {
				if (autoEnabled) {
					ctx.ui.notify("Prewalk automatic mode is already enabled for this session.", "info");
					return;
				}
				setAutoEnabled(true, ctx);
				updateStatus(ctx);
				ctx.ui.notify("Prewalk automatic mode enabled for this session.", "info");
				return;
			}
			if (command === "configure") {
				await configure(ctx);
				return;
			}
			if (command === "todos") {
				ctx.ui.notify(applyTodoOperation(todoPhases, { op: "view" }).text, "info");
				return;
			}
			ctx.ui.notify(
				"Usage: /prewalk [status|stats|run|auto|cancel|release|configure|todos|help|--help]",
				"error",
			);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		resetExecutorCompactionState();
		refreshExecutorCompactionPolicy(ctx);
		activeSessionId = ctx.sessionManager.getSessionId();
		primaryAgentStream = false;
		delegation = undefined;
		delegationInvocations.length = 0;
		removeTerminalInputListener?.();
		removeTerminalInputListener = ctx.ui.onTerminalInput((data) => {
			const run = coordinator.run;
			if (
				!matchesKey(data, "shift+tab") ||
				!run ||
				run.effectiveRoute !== "executor" ||
				(run.phase !== "active" && run.phase !== "completed")
			) {
				return undefined;
			}
			const currentIndex = REASONING_LEVELS.indexOf(run.config.executor.reasoning);
			const next =
				REASONING_LEVELS[(currentIndex + 1) % REASONING_LEVELS.length] ??
				DEFAULT_EXECUTOR.reasoning;
			run.config.executor.reasoning = next;
			updateStatus(ctx);
			ctx.ui.notify(
				`${modelLabelForNotice(run.config.executor.model)} reasoning: ${next}`,
				"info",
			);
			return { consume: true };
		});
		deactivatePrewalkTools();
		todoPhases = latestTodoPhases(
			ctx.sessionManager
				.buildContextEntries()
				.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
		);
		if (event.reason === "reload") {
			const autoMode = latestAutoModeRecord(ctx);
			autoEnabled = autoMode?.sessionId === activeSessionId && autoMode.enabled;
			const record = latestAuditRecord(ctx);
			if (evaluation) {
				restoreEvaluationTools();
				evaluation = undefined;
			}
			if (record) {
				const restored = runFromAudit(record);
				if (restored.phase === "failed" && restored.reasonCode === "configuration-invalid") {
					coordinator.reset();
					lastAuditKey = JSON.stringify(record);
					await startRun("automatic", ctx);
					return;
				}
				if (restored.phase !== "failed" && nativeResponsesCompactionState() !== "disabled") {
					coordinator.reset();
					lastAuditKey = JSON.stringify(record);
					await startRun("automatic", ctx);
					return;
				}
				coordinator.restore(restored);
				prewalkToolSlate = latestPrewalkToolSlate(ctx, restored.id);
				if (
					restored.todoActive &&
					restored.phase !== "cancelled" &&
					restored.phase !== "failed"
				) {
					activatePlanningTools();
				}
				lastAuditKey = JSON.stringify(record);
				if (restored.phase === "cancelled") {
					updateStatus(ctx);
					return;
				}
				try {
					// A restored run already chose its executor; re-running the chain
					// could silently move a live run onto a different model.
					const restoredResolution = await resolveExecutor(
						restored.planner,
						{ ...restored.config, executorFallbacks: [] },
						ctx,
					);
					if (!restoredResolution.ok) {
						// The executor went away while the session was closed. That is the
						// same situation as arming without one: drop back to the planner
						// with an explanation instead of resurrecting the run as failed.
						coordinator.reset();
						overlay?.restore();
						overlay = undefined;
						mutations.resetForRun();
						deactivatePrewalkTools();
						ctx.ui.notify(unavailableExecutorNotice(restoredResolution.rejected), "error");
						updateStatus(ctx);
						return;
					}
					ensureOverlay(ctx);
					if (restored.phase !== "failed") {
						await restoreAnalyticsJournal(restored, ctx).catch(() => {
							analyticsState = undefined;
							ctx.ui.notify(
								"Prewalk analytics could not restore; routing is unchanged.",
								"error",
							);
						});
					}
				} catch {
					fail("provider-unavailable", restored.effectiveRoute === "executor", ctx);
				}
				updateStatus(ctx);
			}
			if (!record) await startExperimentalChildRun(ctx);
			return;
		}
		coordinator.reset();
		autoEnabled = false;
		lastOutcome = undefined;
		pendingAdmission = false;
		evaluation = undefined;
		mutations.resetForRun();
		lastAuditKey = undefined;
		await finalizeInterruptedAnalytics(activeSessionId, ctx).catch(() => {
			ctx.ui.notify(
				"Prewalk could not finalize interrupted analytics; planner routing is unchanged.",
				"error",
			);
		});
		await startExperimentalChildRun(ctx);
	});

	pi.on("input", async (event, ctx) => {
		const control = event.text.trim().toLowerCase();
		if ((control === "stop" || control === "cancel") && event.source !== "extension") {
			pendingAdmission = false;
			if (evaluation) {
				restoreEvaluationTools();
				evaluation = undefined;
				lastOutcome = "completed";
				updateStatus(ctx);
				return { action: "handled" };
			}
			if (coordinator.run) {
				await cancel(isPlannerSelected(ctx.model, coordinator.run.planner), ctx);
				lastOutcome = "completed";
				deactivatePrewalkTools();
				coordinator.reset();
				updateStatus(ctx);
				return { action: "handled" };
			}
			return { action: "continue" };
		}
		if (
			!autoEnabled ||
			coordinator.run ||
			evaluation ||
			event.source === "extension" ||
			event.streamingBehavior !== undefined
		) {
			return { action: "continue" };
		}
		pendingAdmission = admitAutomaticPrewalk(event.text) === "admit";
		return { action: "continue" };
	});

	pi.on("before_agent_start", (_event) => {
		if (!pendingAdmission || coordinator.run || evaluation) return;
		pendingAdmission = false;
		const assessment = beginEvaluation();
		return {
			message: {
				customType: PREWALK_ASSESS_MESSAGE_TYPE,
				content: prompts.assess,
				display: false,
				details: { assessmentId: assessment.id },
			},
		};
	});

	pi.on("session_shutdown", async (event, ctx) => {
		resetExecutorCompactionState();
		activeSessionId = undefined;
		primaryAgentStream = false;
		delegation = undefined;
		pendingAdmission = false;
		evaluation = undefined;
		if (event.reason !== "reload") autoEnabled = false;
		if (event.reason !== "reload") {
			const run = coordinator.run;
			const outcome: RunOutcome =
				run?.effectiveRoute === "executor" &&
				(run.phase === "active" || run.phase === "completed")
					? "session-ended"
					: run?.phase === "failed"
						? "failed"
						: "cancelled";
			// Analytics must never block shutdown; a lost receipt is recoverable from
			// its journal, an unfinished shutdown is not.
			await finalizeAnalytics(outcome).catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(
					`Prewalk could not record the final analytics receipt (${message}).`,
					"error",
				);
			});
		} else {
			await analyticsWrites;
		}
		removeTerminalInputListener?.();
		removeTerminalInputListener = undefined;
		overlay?.restore();
		overlay = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		lastStatus = undefined;
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!verifyOverlayOwnership(ctx)) return;
		refreshExecutorCompactionPolicy(ctx);
		primaryAgentStream = true;
	});

	pi.on("agent_end", () => {
		primaryAgentStream = false;
	});

	pi.on("message_end", async (event) => {
		const run = coordinator.run;
		if (!analyticsState || !run || event.message.role !== "assistant") return;
		const role = usageRoleFor(run, event.message.provider, event.message.model);
		await recordAnalyticsUsage(
			"assistant",
			`message:${event.message.timestamp}:${event.message.provider}:${event.message.model}`,
			event.message.provider,
			event.message.model,
			role,
			event.message.usage,
		);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		primaryAgentStream = false;
		if (evaluation) {
			const current = evaluation;
			if (current.decision === "continue" && !current.invalid) {
				activatePlanningTools(current.toolSlate);
				evaluation = undefined;
				await startRun("automatic", ctx, true);
				const action = coordinator.onTurnEnd({ todoSucceeded: false });
				if (action.type === "send-planning")
					await sendPrompt(PREWALK_PLAN_MESSAGE_TYPE, ctx, true);
				updateStatus(ctx);
			} else {
				restoreEvaluationTools();
				evaluation = undefined;
				lastOutcome = "bypassed";
				updateStatus(ctx);
			}
			return;
		}
		const run = coordinator.run;
		if (!run) return;
		if (hostCompactionForExecutor?.runId === run.id) {
			hostCompactionForExecutor = undefined;
			executorContextPressure = undefined;
			updateStatus(ctx);
			return;
		}
		if (executorContextPressure?.runId === run.id) {
			requestExecutorCompaction(ctx, executorContextPressure.retry);
			updateStatus(ctx);
			return;
		}
		if (pendingExecutorCompaction) {
			// ctx.compact() aborts the active Agent loop before its own completion
			// callback runs. Keep a handoff-pending run alive across that settlement;
			// the callback owns the only checklist retry.
			updateStatus(ctx);
			return;
		}
		if (pendingExecutorFailureRunId === run.id) {
			pendingExecutorFailureRunId = undefined;
			fail("executor-stream-failed", run.effectiveRoute === "executor", ctx);
			await finalizeAnalytics("failed");
		}
		if (
			run.effectiveRoute === "executor" &&
			(run.phase === "active" || run.phase === "completed")
		) {
			updateStatus(ctx);
			return;
		}
		const action = coordinator.requestContinuation(hasActionableTodo(todoPhases));
		if (action.type === "send-continuation") {
			await sendPrompt(PREWALK_CONTINUE_MESSAGE_TYPE, ctx, true);
			return;
		}
		const failedRun = run.phase === "failed";
		await finalizeAnalytics(failedRun ? "failed" : "succeeded");
		overlay?.restore();
		overlay = undefined;
		coordinator.reset();
		lastOutcome = failedRun ? "failed" : "completed";
		mutations.resetForRun();
		deactivatePrewalkTools();
		updateStatus(ctx);
	});

	pi.on("tool_call", (event) => {
		if (evaluation && !ASSESSMENT_READ_ONLY_TOOLS.has(event.toolName)) {
			evaluation.invalid = true;
			return { block: true, reason: "Prewalk assessment only allows read-only inspection." };
		}
	});

	pi.on("tool_execution_update", (event) => {
		if (evaluation) {
			evaluationMutations.recordExecutionUpdate(event);
			return;
		}
		if (!acceptsMutationEvidence(coordinator.run)) return;
		mutations.recordExecutionUpdate(event);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (
			evaluation &&
			(event.toolName === PREWALK_TODO_TOOL_NAME || event.toolName === "subagent")
		) {
			evaluation.invalid = true;
		}
		if (event.toolName !== "subagent") return;
		const parentSessionId = ctx.sessionManager.getSessionId();
		if (parentSessionId) {
			try {
				const analyticsGeneration = await analyticsStore.currentGeneration();
				delegationInvocations.push({
					toolCallId: event.toolCallId,
					rootSessionId: parentSessionId,
					parentSessionId,
					analyticsGeneration,
					childCount: delegatedChildCount(event.args),
				});
				if (delegationInvocations.length > 64) delegationInvocations.shift();
			} catch {
				// Analytics must never affect subagent execution.
			}
		}
		delegation = {
			agent: delegatedAgent(event.args),
			state: "running",
		};
		updateStatus(ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (evaluation) {
			evaluationMutations.recordResult({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				input: event.input,
				isError: event.isError,
				details: event.details,
			});
		}
		if (event.usage && analyticsState) {
			const run = coordinator.run;
			const selected = ctx.model;
			const provider = selected?.provider ?? run?.planner.provider;
			const model = selected?.id ?? run?.planner.model;
			if (provider && model) {
				await recordAnalyticsUsage(
					"tool-result",
					`tool:${event.toolCallId}`,
					provider,
					model,
					"auxiliary",
					event.usage,
				);
			}
		}
		if (event.toolName === "subagent") {
			const invocation = delegationInvocations.find(
				(candidate) => candidate.toolCallId === event.toolCallId,
			);
			if (invocation) {
				await recordDelegationProjection(invocation, event.details, event.isError);
			}
			delegation = delegationFromResult(
				event.details,
				event.isError,
				delegation?.agent ?? delegatedAgent(event.input),
			);
			updateStatus(ctx);
		}
		if (!acceptsMutationEvidence(coordinator.run)) return;
		mutations.recordResult({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			input: event.input,
			isError: event.isError,
			details: event.details,
		});
	});

	pi.on("turn_end", async (event, ctx) => {
		if (evaluation) {
			const evidence = evaluationMutations.finishTurn(event.message, {
				todoActive: false,
				todoSeen: false,
			});
			if (evidence.mutation) evaluation.invalid = true;
			return;
		}
		if (!verifyOverlayOwnership(ctx)) return;
		refreshExecutorCompactionPolicy(ctx);
		const run = coordinator.run;
		if (!run) return;
		if (acceptsMutationEvidence(run)) {
			const evidence = mutations.finishTurn(event.message, {
				todoActive: run.todoActive,
				todoSeen: run.todoSeen,
			});
			const wasTodoReady = run.todoSeen;
			const wasContinuePending = run.continuePending;
			const action = coordinator.onTurnEnd(evidence);
			if (!wasTodoReady && coordinator.run?.todoSeen) audit("todo-ready", ctx);
			if (!wasContinuePending && coordinator.run?.continuePending) audit("progress", ctx);
			if (action.type === "send-planning") {
				await sendPrompt(PREWALK_PLAN_MESSAGE_TYPE, ctx);
			} else if (action.type === "send-continuation") {
				await sendPrompt(PREWALK_CONTINUE_MESSAGE_TYPE, ctx);
			} else if (action.type === "handoff") {
				audit("handoff-triggered", ctx);
				await sendPrompt(PREWALK_CHECKLIST_MESSAGE_TYPE, ctx);
				mutations.resetForRun();
			}
		}
		const currentRun = coordinator.run;
		if (currentRun?.id === run.id) {
			if (executorContextPressure?.runId === run.id) {
				// Pi's own compaction check runs after this extension's turn_end
				// handlers. Defer the executor request until agent_settled so the
				// host cannot start two compactions for the same turn.
			} else if (
				currentRun.effectiveRoute === "executor" &&
				(currentRun.phase === "active" || currentRun.phase === "completed") &&
				event.message.role === "assistant" &&
				event.message.provider === currentRun.config.executor.provider &&
				event.message.model === currentRun.config.executor.model
			) {
				const executor = ctx.modelRegistry.find(
					currentRun.config.executor.provider,
					currentRun.config.executor.model,
				);
				const usage = ctx.getContextUsage();
				if (executor && usage?.tokens !== null && usage?.tokens !== undefined) {
					if (
						needsExecutorCompaction(
							usage.tokens,
							executor,
							executorCompactionPolicy.reserveTokens,
						)
					) {
						executorContextPressure = {
							runId: run.id,
							retry: event.message.stopReason !== "stop",
						};
					}
				}
			}
		}
		updateStatus(ctx);
	});

	pi.on("context", (event) => ({
		messages: event.messages.filter((message) =>
			shouldExposePrompt(message, coordinator.run, evaluation?.id),
		),
	}));

	pi.on("session_before_compact", (event) => {
		const run = coordinator.run;
		const compactedMessages = [
			...event.preparation.messagesToSummarize,
			...event.preparation.turnPrefixMessages,
		];
		compactionChecklistRunId =
			!pendingExecutorCompaction &&
			run?.effectiveRoute === "executor" &&
			compactedMessages.some(
				(message) =>
					message.role === "custom" &&
					message.customType === PREWALK_CHECKLIST_MESSAGE_TYPE &&
					runIdFromMessage(message) === run.id,
			)
				? run.id
				: undefined;
		event.preparation.messagesToSummarize = event.preparation.messagesToSummarize.filter(
			(message) => !isEphemeralPrewalkPrompt(message),
		);
		event.preparation.turnPrefixMessages = event.preparation.turnPrefixMessages.filter(
			(message) => !isEphemeralPrewalkPrompt(message),
		);
	});

	pi.on("session_compact", async (event, ctx) => {
		const run = coordinator.run;
		const pressure = executorContextPressure;
		if (pendingExecutorCompaction?.runId === run?.id) {
			committedExecutorCompaction = pendingExecutorCompaction;
		} else if (run && pressure && pressure.runId === run.id) {
			// Pi's own planner-sized compaction runs after turn_end. Treat its
			// persisted entry as satisfying the pending executor pressure instead
			// of starting a second compaction from agent_settled.
			hostCompactionForExecutor = pressure;
			executorContextPressure = undefined;
			if (pressure.retry && compactionChecklistRunId !== run.id) {
				await sendPrompt(PREWALK_CHECKLIST_MESSAGE_TYPE, ctx, true);
			}
		}
		if (
			run &&
			compactionChecklistRunId === run.id &&
			run.effectiveRoute === "executor" &&
			(run.phase === "active" || run.phase === "completed")
		) {
			pi.sendMessage(
				{
					customType: PREWALK_CHECKLIST_MESSAGE_TYPE,
					content: prompts.checklist,
					display: false,
					details: { runId: run.id },
				},
				{ deliverAs: "nextTurn" },
			);
		}
		compactionChecklistRunId = undefined;
		if (!event.compactionEntry.usage || !analyticsState) return;
		const selected = ctx.model;
		const provider = selected?.provider ?? run?.planner.provider;
		const model = selected?.id ?? run?.planner.model;
		if (provider && model) {
			try {
				await recordAnalyticsUsage(
					"compaction",
					`compaction:${event.compactionEntry.id}`,
					provider,
					model,
					"compaction",
					event.compactionEntry.usage,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(
					`Prewalk could not record compaction analytics (${message}); this did not affect compaction.`,
					"warning",
				);
			}
		}
	});

	pi.on("model_select", async (event, ctx) => {
		if (event.source === "restore") return;
		if (evaluation) {
			restoreEvaluationTools();
			evaluation = undefined;
			pendingAdmission = false;
			evaluationMutations.resetForRun();
			updateStatus(ctx);
			return;
		}
		const run = coordinator.run;
		if (!run || run.phase === "cancelled") return;
		await cancel(isPlannerSelected(event.model, run.planner), ctx);
		coordinator.reset();
		deactivatePrewalkTools();
		lastOutcome = undefined;
		updateStatus(ctx);
	});

	pi.on("thinking_level_select", (event, ctx) => {
		const run = coordinator.run;
		if (
			run?.effectiveRoute === "planner" &&
			run.phase !== "cancelled" &&
			run.phase !== "failed"
		) {
			run.planner.reasoning = event.level;
			audit("planner-reasoning-changed", ctx);
		}
		updateStatus(ctx);
	});
}

function executorRejectionLabel(reason: ExecutorRejection): string {
	if (reason === "not-registered") return "not available";
	if (reason === "authorization-unavailable") return "no credentials";
	if (reason === "output-capacity-unavailable") return "no usable output capacity";
	return "same as the planner";
}

/**
 * Names every candidate and why it was passed over, so a configuration problem
 * is legible without opening the audit log.
 */
function unavailableExecutorNotice(rejected: readonly RejectedExecutor[]): string {
	const tried = rejected
		.map(
			({ candidate, reason }) =>
				`${candidate.provider}/${candidate.model} (${executorRejectionLabel(reason)})`,
		)
		.join(", ");
	// A no-op pairing is a configuration mistake rather than an outage, so it
	// reads differently from a model that genuinely is not there.
	const summary =
		rejected.length > 0 && rejected.every(({ reason }) => reason === "same-as-planner")
			? "the configured executor is the model already running"
			: "no executor is available";
	return `Prewalk stayed unarmed: ${summary}. Tried ${tried}.`;
}

function modelLabelForNotice(model: string): string {
	if (model === "gpt-5.6-sol") return "Sol";
	if (model === "gpt-5.6-luna") return "Luna";
	return model;
}
