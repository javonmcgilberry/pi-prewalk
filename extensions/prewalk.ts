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
	type UsageObservationSource,
	type UsageRole,
	usageEvidenceKey,
} from "../src/analytics.js";
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
import {
	type ExecutionProfilePolicy,
	executionProfilePolicy,
} from "../src/execution-profile-policy.js";
import { isRecord } from "../src/guards.js";
import { MutationTurnBuffer } from "../src/mutation.js";
import { createProviderOverlay, type ProviderOverlay } from "../src/provider-overlay.js";
import { compactStatus, type DelegationStatus, detailedStatus } from "../src/status.js";
import {
	applyExecutionProfilePolicy,
	decodeExecutionProfilePolicy,
	encodeExecutionProfilePolicy,
	PREWALK_EXECUTION_PROFILE_POLICY_ENV,
} from "../src/subagent-policy.js";
import {
	applyTodoOperation,
	hasActionableTodo,
	latestTodoPhases,
	type TodoInput,
	type TodoPhase,
	TodoReminder,
} from "../src/todo.js";

const STATUS_KEY = "prewalk";
const PREWALK_TODO_REMINDER_MESSAGE_TYPE = "prewalk-todo-reminder";
const PREWALK_ASSESS_MESSAGE_TYPE = "prewalk-assess";
const PREWALK_ASSESS_TOOL_NAME = "prewalk_assess";
const PREWALK_DELEGATION_POLICY_TYPE = "prewalk-delegation-policy-v1";
const PREWALK_COMMANDS = [
	"status",
	"stats",
	"run",
	"auto",
	"cancel",
	"configure",
	"help",
	"--help",
];
const PROMPT_TYPES = new Set([
	PREWALK_PLAN_MESSAGE_TYPE,
	PREWALK_CONTINUE_MESSAGE_TYPE,
	PREWALK_CHECKLIST_MESSAGE_TYPE,
	PREWALK_TODO_REMINDER_MESSAGE_TYPE,
	PREWALK_ASSESS_MESSAGE_TYPE,
]);

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
		plan: readFileSync(promptFile("prewalk-plan.md"), "utf8"),
		assess: readFileSync(promptFile("prewalk-assess.md"), "utf8"),
		continue: readFileSync(promptFile("prewalk-continue.md"), "utf8"),
		checklist: readFileSync(promptFile("prewalk-checklist.md"), "utf8"),
		todo: readFileSync(promptFile("todo.md"), "utf8"),
	};
}

interface EvaluationState {
	toolSlate: string[];
	decision?: "continue" | "bypass";
	invalid: boolean;
}

const ASSESSMENT_READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

const prompts = loadPrompts();

function configPath(): string {
	return path.join(getAgentDir(), "prewalk.json");
}

function helpText(): string {
	return [
		"Prewalk quick guide",
		"",
		"/prewalk status  Show the current planner, executor, gate, route, and failure reason.",
		"/prewalk stats  Show lifetime, month, week, session, and recent local analytics.",
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
		"/prewalk configure  Choose the executor and control analytics collection and catalog fallback.",
		"/todos           Show the current Prewalk implementation checklist.",
		"",
		"Reset the current run: /prewalk cancel, then /prewalk run.",
		"Type exactly stop or cancel to close only the current task; /prewalk cancel also disables session automatic mode.",
		"Reload extension and config changes: /reload.",
		`Configuration file: ${configPath()}`,
		"Configuration is written atomically by /prewalk configure.",
		"Analytics stay local. Actual means Pi-reported attributed cost; estimated and catalog-estimated values are labeled counterfactuals; unavailable means evidence was insufficient; unfinished means no terminal receipt exists; verified is reserved for accepted benchmark evidence.",
		"Disabling collection preserves existing receipts and does not change routing. Export refuses existing destinations. Reset excludes any active prior-generation run, and collection resumes on the next run.",
		"",
		"Prewalk derives the planner from Pi's selected model and reasoning for each epoch. Only primary Agent-loop requests route to the executor after the handoff gate.",
		"Shift+Tab changes Sol reasoning while Sol is active and Luna reasoning after Luna takes over.",
		"Sol and Luna reasoning are independent; Luna defaults to low unless you configure another level.",
		"Subagents run independent Prewalk lifecycles. A strict child without todo still switches after its first successful code change.",
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

function shouldExposePrompt(message: AgentMessage, run: PrewalkRun | undefined): boolean {
	if (!isPrewalkPrompt(message)) return true;
	const messageRunId = runIdFromMessage(message);
	if (!messageRunId) return false;
	if (!run || messageRunId !== run.id || run.phase === "cancelled") return false;
	if (message.customType === PREWALK_TODO_REMINDER_MESSAGE_TYPE) return true;
	if (
		run.phase === "handoff-pending" ||
		run.phase === "active" ||
		run.phase === "completed" ||
		(run.phase === "failed" && run.effectiveRoute === "executor")
	) {
		return message.customType === PREWALK_CHECKLIST_MESSAGE_TYPE;
	}
	return message.customType !== PREWALK_CHECKLIST_MESSAGE_TYPE;
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

function delegationPolicies(ctx: ExtensionContext): Map<string, ExecutionProfilePolicy> {
	const records = new Map<string, ExecutionProfilePolicy>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (
			entry?.type !== "custom" ||
			entry.customType !== PREWALK_DELEGATION_POLICY_TYPE ||
			!isRecord(entry.data) ||
			Object.keys(entry.data).length !== 4 ||
			entry.data.version !== 1 ||
			entry.data.sessionId !== ctx.sessionManager.getSessionId() ||
			typeof entry.data.runId !== "string" ||
			!entry.data.runId.trim()
		) {
			continue;
		}
		const policyValue = decodeExecutionProfilePolicy(JSON.stringify(entry.data.policy));
		if (policyValue?.status === "available") records.set(entry.data.runId, policyValue);
	}
	return records;
}

function matchingDelegationPolicy(
	input: Record<string, unknown>,
	records: Map<string, ExecutionProfilePolicy>,
): ExecutionProfilePolicy | undefined {
	const requested =
		typeof input.id === "string"
			? input.id.trim()
			: typeof input.runId === "string"
				? input.runId.trim()
				: "";
	if (!requested) return undefined;
	const exact = records.get(requested);
	if (exact) return exact;
	const matches = [...records].filter(([runId]) => runId.startsWith(requested));
	return matches.length === 1 ? matches[0]?.[1] : undefined;
}

export default function prewalkExtension(pi: ExtensionAPI): void {
	const coordinator = new PrewalkCoordinator();
	const mutations = new MutationTurnBuffer();
	const evaluationMutations = new MutationTurnBuffer();
	const todoReminder = new TodoReminder();
	const analyticsStore = new AnalyticsStore(getAgentDir());
	const hasInheritedExecutionProfilePolicy =
		process.env[PREWALK_EXECUTION_PROFILE_POLICY_ENV] !== undefined;
	const inheritedExecutionProfilePolicy = decodeExecutionProfilePolicy(
		process.env[PREWALK_EXECUTION_PROFILE_POLICY_ENV],
	);
	const originalExecutionProfilePolicyEnvironment =
		process.env[PREWALK_EXECUTION_PROFILE_POLICY_ENV];
	const policyToolCalls = new Map<string, ExecutionProfilePolicy>();
	let persistedDelegationPolicies = new Map<string, ExecutionProfilePolicy>();
	let activeSessionId: string | undefined;
	let autoEnabled = false;
	let lastOutcome: "bypassed" | "completed" | undefined;
	let pendingAdmission = false;
	let evaluation: EvaluationState | undefined;
	let overlay: ProviderOverlay | undefined;
	let primaryAgentStream = false;
	let todoPhases: TodoPhase[] = [];
	let todoConflict = false;
	let lastAuditKey: string | undefined;
	let lastStatus: string | undefined;
	let delegation: DelegationStatus | undefined;
	let removeTerminalInputListener: (() => void) | undefined;
	const deactivatePrewalkTools = (): void => {
		const active = pi.getActiveTools().filter((name) => name !== PREWALK_ASSESS_TOOL_NAME);
		pi.setActiveTools(todoConflict ? active : active.filter((name) => name !== "todo"));
	};
	const activatePlanningTools = (toolSlate = pi.getActiveTools()): void => {
		const withoutAssessment = toolSlate.filter((name) => name !== PREWALK_ASSESS_TOOL_NAME);
		pi.setActiveTools([...withoutAssessment.filter((name) => name !== "todo"), "todo"]);
	};
	const beginEvaluation = (): void => {
		const toolSlate = pi.getActiveTools().filter((name) => name !== PREWALK_ASSESS_TOOL_NAME);
		evaluation = { toolSlate, invalid: false };
		evaluationMutations.resetForRun();
		const evaluationTools = todoConflict
			? toolSlate
			: toolSlate.filter((name) => name !== "todo");
		pi.setActiveTools([...evaluationTools, PREWALK_ASSESS_TOOL_NAME]);
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
		childCount: number;
		delegationRunId?: string;
		policy?: ExecutionProfilePolicy;
	};
	const delegationInvocations: DelegationInvocation[] = [];

	const updateStatus = (ctx: ExtensionContext): void => {
		const nextStatus = compactStatus(coordinator.run, ctx.model, ctx.thinkingLevel, delegation, {
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
				evidenceKeys: [...(journal.evidenceKeys ?? [])],
				...(journal.lineage === undefined ? {} : { lineage: journal.lineage }),
			};
			await analyticsStore.promoteReceipt(receipt);
			if (analyticsState === state) analyticsState = undefined;
		}).catch((error) => {
			if (analyticsFinalization?.promise === promise) analyticsFinalization = undefined;
			throw error;
		});
		analyticsFinalization = { runId: journal.runId, epoch: journal.epoch, promise };
		return promise;
	};

	const fail = (reasonCode: string, holdExecutorRoute: boolean, ctx: ExtensionContext): void => {
		if (!coordinator.run) {
			if (!ctx.model) {
				ctx.ui.notify(`Prewalk failed: ${reasonCode}.`, "error");
				return;
			}
			coordinator.arm(
				randomUUID(),
				randomUUID(),
				"automatic",
				pi.getActiveTools().includes("todo"),
				{
					provider: ctx.model.provider,
					model: ctx.model.id,
					reasoning: ctx.thinkingLevel ?? "off",
				},
				defaultConfig(),
			);
		}
		coordinator.fail(reasonCode, holdExecutorRoute);
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
		ctx.ui.notify(`Prewalk failed: ${reasonCode}.`, "error");
	};

	const cancel = async (selectedModelIsPlanner: boolean, ctx: ExtensionContext): Promise<void> => {
		coordinator.cancel(selectedModelIsPlanner);
		mutations.resetForRun();
		audit("cancelled", ctx);
		await finalizeAnalytics("cancelled");
		overlay?.restore();
		overlay = undefined;
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
			onExecutorStreamStarted: async (runId) => {
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
				if (coordinator.run.phase === "handoff-pending") {
					fail("executor-stream-failed", false, ctx);
				} else if (coordinator.run.phase === "active") {
					fail("executor-stream-failed", true, ctx);
				}
				await analyticsWrites;
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

	const validateModels = async (
		plannerProfile: PlannerProfile,
		config: PrewalkConfig,
		ctx: ExtensionContext,
	): Promise<void> => {
		const planner = ctx.modelRegistry.find(plannerProfile.provider, plannerProfile.model);
		const executor = ctx.modelRegistry.find(config.executor.provider, config.executor.model);
		if (!planner || !executor || !isPlannerSelected(ctx.model, plannerProfile)) {
			throw new Error("model-unavailable");
		}
		if (
			planner.provider !== executor.provider ||
			planner.api !== executor.api ||
			planner.contextWindow <= 0 ||
			executor.contextWindow < planner.contextWindow ||
			planner.maxTokens <= 0 ||
			executor.maxTokens <= 0
		) {
			throw new Error("model-unavailable");
		}
		const [plannerAuth, executorAuth] = await Promise.all([
			ctx.modelRegistry.getApiKeyAndHeaders(planner),
			ctx.modelRegistry.getApiKeyAndHeaders(executor),
		]);
		if (!plannerAuth.ok || !executorAuth.ok) {
			throw new Error("authorization-unavailable");
		}
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

	const startRun = async (
		mode: "automatic" | "manual",
		ctx: ExtensionContext,
		triggerTurn = false,
	): Promise<void> => {
		try {
			const config = await readConfig();
			if (todoConflict) throw new Error("todo-conflict");
			activatePlanningTools();
			if (!ctx.model) throw new Error("model-unavailable");
			const planner: PlannerProfile = {
				provider: ctx.model.provider,
				model: ctx.model.id,
				reasoning: ctx.thinkingLevel ?? "off",
			};
			await validateModels(planner, config, ctx);
			const todoActive = pi.getActiveTools().includes("todo");
			const action = coordinator.arm(
				randomUUID(),
				randomUUID(),
				mode,
				todoActive,
				planner,
				config,
			);
			ensureOverlay(ctx);
			const armedRun = coordinator.run;
			if (armedRun) {
				await openAnalyticsJournal(armedRun, ctx).catch(() => {
					analyticsState = undefined;
					ctx.ui.notify("Prewalk analytics could not start; routing is unchanged.", "error");
				});
			}
			mutations.resetForRun();
			todoReminder.reset();
			audit("armed", ctx);
			if (action.type === "send-planning") {
				await sendPrompt(PREWALK_PLAN_MESSAGE_TYPE, ctx, triggerTurn);
			}
		} catch (error) {
			const reason =
				error instanceof Error &&
				[
					"configuration-invalid",
					"model-unavailable",
					"authorization-unavailable",
					"provider-unavailable",
					"provider-drift",
					"todo-conflict",
				].includes(error.message)
					? error.message
					: "provider-unavailable";
			fail(reason, false, ctx);
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
		const executorCandidates = available.filter(
			(model) =>
				model.provider === planner.provider &&
				model.api === planner.api &&
				model.id !== planner.id,
		);
		if (executorCandidates.length === 0) {
			ctx.ui.notify(
				"That planner has no second available model on the same provider and API.",
				"error",
			);
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
				ctx.ui.notify(renderTaskTreeReport(report), "info");
				return;
			}
			if (input.startsWith("receipt ")) {
				const runId = input.slice("receipt ".length).trim();
				const receipt = (await analyticsStore.listReceipts()).find(
					(candidate) => candidate.runId === runId,
				);
				ctx.ui.notify(
					receipt
						? renderReceiptReport(receipt)
						: `No analytics receipt found for run ${runId}.`,
					receipt ? "info" : "error",
				);
				return;
			}
			const successfulOnly = input === "--successful";
			if (input && !successfulOnly) throw new Error("unknown-stats-arguments");
			const outcomes: readonly RunOutcome[] | undefined = successfulOnly
				? ["succeeded"]
				: undefined;
			const common = outcomes ? { outcomes } : {};
			const analytics = coordinator.run?.config.analytics ?? DEFAULT_ANALYTICS_CONFIG;
			const snapshot = await analyticsStore.snapshot();
			const now = new Date();
			const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
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
						sessionId: ctx.sessionManager.getSessionId(),
					},
					snapshot,
				),
			]);
			const verifiedBenchmark = await analyticsStore.readVerifiedBenchmarkSummary();
			ctx.ui.notify(
				renderAnalyticsOverview({
					lifetime,
					month,
					week,
					session,
					verifiedBenchmark: verifiedBenchmark ?? undefined,
				}),
				"info",
			);
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
		name: "todo",
		label: "Todo",
		description: "Create and maintain the phased implementation checklist required by Prewalk.",
		promptSnippet: prompts.todo,
		promptGuidelines: [
			"Initialize the todo list before the first implementation mutation.",
			"Keep todo state current as work advances.",
		],
		parameters: TodoParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
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
			if (params.op !== "view") todoReminder.reset();
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
				setAutoEnabled(false, ctx);
				updateStatus(ctx);
				if (evaluation) {
					restoreEvaluationTools();
					evaluation = undefined;
				}
				pendingAdmission = false;
				if (coordinator.run) {
					await cancel(isPlannerSelected(ctx.model, coordinator.run.planner), ctx);
				}
				ctx.ui.notify("Prewalk automatic mode disabled for this session.", "info");
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
				if (hasInheritedExecutionProfilePolicy) {
					ctx.ui.notify(
						"Prewalk automatic mode is disabled inside a constrained child session.",
						"error",
					);
					return;
				}
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
			ctx.ui.notify(
				"Usage: /prewalk [status|stats|run|auto|cancel|configure|help|--help]",
				"error",
			);
		},
	});

	pi.registerCommand("todos", {
		description: "Show the current Prewalk todo list.",
		async handler(_args, ctx) {
			ctx.ui.notify(applyTodoOperation(todoPhases, { op: "view" }).text, "info");
		},
	});

	pi.on("session_start", async (event, ctx) => {
		activeSessionId = ctx.sessionManager.getSessionId();
		policyToolCalls.clear();
		persistedDelegationPolicies = delegationPolicies(ctx);
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
		const todoTool = pi.getAllTools().find((tool) => tool.name === "todo");
		todoConflict =
			todoTool !== undefined && !todoTool.sourceInfo.path.toLowerCase().includes("prewalk");
		deactivatePrewalkTools();
		todoPhases = latestTodoPhases(
			ctx.sessionManager
				.buildContextEntries()
				.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
		);
		todoReminder.reset();
		if (event.reason === "reload") {
			const autoMode = latestAutoModeRecord(ctx);
			autoEnabled =
				!hasInheritedExecutionProfilePolicy &&
				autoMode?.sessionId === activeSessionId &&
				autoMode.enabled;
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
				coordinator.restore(restored);
				if (
					restored.todoActive &&
					!todoConflict &&
					restored.phase !== "cancelled" &&
					restored.phase !== "failed"
				) {
					pi.setActiveTools([
						...pi.getActiveTools().filter((name) => name !== "todo"),
						"todo",
					]);
				}
				lastAuditKey = JSON.stringify(record);
				if (restored.phase === "cancelled") {
					updateStatus(ctx);
					return;
				}
				try {
					await validateModels(restored.planner, restored.config, ctx);
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
			return;
		}
		coordinator.reset();
		autoEnabled = false;
		lastOutcome = undefined;
		pendingAdmission = false;
		evaluation = undefined;
		mutations.resetForRun();
		lastAuditKey = undefined;
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
			hasInheritedExecutionProfilePolicy ||
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
		beginEvaluation();
		return {
			message: {
				customType: PREWALK_ASSESS_MESSAGE_TYPE,
				content: prompts.assess,
				display: false,
			},
		};
	});

	pi.on("session_shutdown", async (event, ctx) => {
		activeSessionId = undefined;
		policyToolCalls.clear();
		persistedDelegationPolicies.clear();
		if (!inheritedExecutionProfilePolicy) {
			if (originalExecutionProfilePolicyEnvironment === undefined) {
				delete process.env[PREWALK_EXECUTION_PROFILE_POLICY_ENV];
			} else {
				process.env[PREWALK_EXECUTION_PROFILE_POLICY_ENV] =
					originalExecutionProfilePolicyEnvironment;
			}
		}
		primaryAgentStream = false;
		delegation = undefined;
		pendingAdmission = false;
		evaluation = undefined;
		if (event.reason !== "reload") autoEnabled = false;
		if (event.reason !== "reload") {
			await finalizeAnalytics(
				coordinator.run?.phase === "completed" ? "succeeded" : "cancelled",
			);
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
		primaryAgentStream = true;
	});

	pi.on("agent_end", () => {
		primaryAgentStream = false;
	});

	pi.on("message_end", async (event) => {
		const run = coordinator.run;
		if (!analyticsState || !run || event.message.role !== "assistant") return;
		let role: UsageRole = "auxiliary";
		if (
			event.message.provider === run.planner.provider &&
			event.message.model === run.planner.model
		) {
			role = "planner-primary";
		} else if (
			event.message.provider === run.config.executor.provider &&
			event.message.model === run.config.executor.model
		) {
			role = "executor-primary";
		}
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
				pi.setActiveTools([...current.toolSlate.filter((name) => name !== "todo"), "todo"]);
				evaluation = undefined;
				await startRun("automatic", ctx, true);
				const action = coordinator.onTurnEnd({ hasToolResults: false, todoSucceeded: false });
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
		const action = coordinator.requestContinuation(hasActionableTodo(todoPhases));
		if (action.type === "send-continuation") {
			await sendPrompt(PREWALK_CONTINUE_MESSAGE_TYPE, ctx, true);
			return;
		}
		await finalizeAnalytics(run.phase === "failed" ? "failed" : "succeeded");
		overlay?.restore();
		overlay = undefined;
		coordinator.reset();
		lastOutcome = "completed";
		mutations.resetForRun();
		todoReminder.reset();
		deactivatePrewalkTools();
		updateStatus(ctx);
	});

	pi.on("tool_call", (event) => {
		if (evaluation && !ASSESSMENT_READ_ONLY_TOOLS.has(event.toolName)) {
			evaluation.invalid = true;
			return { block: true, reason: "Prewalk assessment only allows read-only inspection." };
		}
		if (event.toolName !== "subagent") return;
		if (hasInheritedExecutionProfilePolicy && !inheritedExecutionProfilePolicy) {
			return {
				block: true,
				reason: "Prewalk rejected an invalid inherited execution-profile policy.",
			};
		}
		const action = typeof event.input.action === "string" ? event.input.action : undefined;
		const existingRunAction =
			action === "resume" || action === "steer" || action === "append-step";
		if (action === "schedule") {
			const activePolicy =
				inheritedExecutionProfilePolicy ??
				(coordinator.run ? executionProfilePolicy(coordinator.run) : undefined);
			if (activePolicy) {
				return {
					block: true,
					reason:
						"Prewalk cannot safely propagate an active execution-profile policy to a delayed scheduled launch.",
				};
			}
			return;
		}
		if (action && !existingRunAction) return;
		const originalPolicy = existingRunAction
			? matchingDelegationPolicy(event.input, persistedDelegationPolicies)
			: undefined;
		const activePolicy =
			originalPolicy ??
			inheritedExecutionProfilePolicy ??
			(coordinator.run ? executionProfilePolicy(coordinator.run) : undefined);
		if (existingRunAction && !originalPolicy && activePolicy) {
			return {
				block: true,
				reason: `Prewalk cannot prove the original execution-profile policy for this ${action}.`,
			};
		}
		if (!activePolicy) return;
		if (!isRecord(event.input)) {
			return {
				block: true,
				reason: "Prewalk could not validate the subagent launch arguments.",
			};
		}
		const pendingPolicy = [...policyToolCalls.values()][0];
		if (
			pendingPolicy &&
			encodeExecutionProfilePolicy(pendingPolicy) !== encodeExecutionProfilePolicy(activePolicy)
		) {
			return {
				block: true,
				reason:
					"Prewalk cannot launch concurrent subagents with different execution-profile policies.",
			};
		}
		const applied = applyExecutionProfilePolicy(event.input, activePolicy);
		if (!applied.ok) return { block: true, reason: applied.reason };
		process.env[PREWALK_EXECUTION_PROFILE_POLICY_ENV] =
			encodeExecutionProfilePolicy(activePolicy);
		policyToolCalls.set(event.toolCallId, activePolicy);
	});

	pi.on("tool_execution_update", (event) => {
		if (evaluation) {
			evaluationMutations.recordExecutionUpdate(event);
			return;
		}
		if (!acceptsMutationEvidence(coordinator.run)) return;
		mutations.recordExecutionUpdate(event);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (evaluation && (event.toolName === "todo" || event.toolName === "subagent")) {
			evaluation.invalid = true;
		}
		if (event.toolName !== "subagent") return;
		const parentSessionId = ctx.sessionManager.getSessionId();
		if (parentSessionId) {
			delegationInvocations.push({
				toolCallId: event.toolCallId,
				rootSessionId: parentSessionId,
				parentSessionId,
				childCount: delegatedChildCount(event.args),
				policy: policyToolCalls.get(event.toolCallId),
			});
			if (delegationInvocations.length > 64) delegationInvocations.shift();
		}
		delegation = {
			agent: delegatedAgent(event.args),
			state: "running",
		};
		updateStatus(ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "subagent" && policyToolCalls.delete(event.toolCallId)) {
			if (!inheritedExecutionProfilePolicy && policyToolCalls.size === 0) {
				if (originalExecutionProfilePolicyEnvironment === undefined) {
					delete process.env[PREWALK_EXECUTION_PROFILE_POLICY_ENV];
				} else {
					process.env[PREWALK_EXECUTION_PROFILE_POLICY_ENV] =
						originalExecutionProfilePolicyEnvironment;
				}
			}
		}
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
				const evidence = projectDelegationToolResult({
					rootSessionId: invocation.rootSessionId,
					parentSessionId: invocation.parentSessionId,
					invocationId: invocation.toolCallId,
					childCount: invocation.childCount,
					details: event.details,
					isError: event.isError,
				});
				const primaryDelegationRunId = evidence[0]?.delegationRunId;
				if (primaryDelegationRunId) invocation.delegationRunId = primaryDelegationRunId;
				for (const item of evidence) {
					const { schemaVersion, ...eventValue } = item;
					await enqueueAnalytics(async () => {
						await analyticsStore.writeDelegationEvidence({
							...eventValue,
							version: schemaVersion,
						});
					}).catch(() => undefined);
				}
				if (
					invocation.policy?.status === "available" &&
					invocation.delegationRunId &&
					!persistedDelegationPolicies.has(invocation.delegationRunId)
				) {
					persistedDelegationPolicies.set(invocation.delegationRunId, invocation.policy);
					pi.appendEntry(PREWALK_DELEGATION_POLICY_TYPE, {
						version: 1,
						sessionId: invocation.parentSessionId,
						runId: invocation.delegationRunId,
						policy: invocation.policy,
					});
				}
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
		const run = coordinator.run;
		if (!run || !acceptsMutationEvidence(run)) return;
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
		updateStatus(ctx);
	});

	pi.on("context", (event) => ({
		messages: event.messages.filter((message) => shouldExposePrompt(message, coordinator.run)),
	}));

	pi.on("session_before_compact", (event) => {
		event.preparation.messagesToSummarize = event.preparation.messagesToSummarize.filter(
			(message) => !isPrewalkPrompt(message),
		);
		event.preparation.turnPrefixMessages = event.preparation.turnPrefixMessages.filter(
			(message) => !isPrewalkPrompt(message),
		);
	});

	pi.on("session_compact", async (event, ctx) => {
		if (!event.compactionEntry.usage || !analyticsState) return;
		const run = coordinator.run;
		const selected = ctx.model;
		const provider = selected?.provider ?? run?.planner.provider;
		const model = selected?.id ?? run?.planner.model;
		if (provider && model) {
			await recordAnalyticsUsage(
				"compaction",
				`compaction:${event.compactionEntry.id}`,
				provider,
				model,
				"compaction",
				event.compactionEntry.usage,
			);
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

function modelLabelForNotice(model: string): string {
	if (model === "gpt-5.6-sol") return "Sol";
	if (model === "gpt-5.6-luna") return "Luna";
	return model;
}
