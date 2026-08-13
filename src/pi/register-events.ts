import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { DEFAULT_ANALYTICS_CONFIG, type RunOutcome } from "../analytics/index.js";
import { PrewalkAnalytics } from "../analytics/run-accounting.js";
import { configurePrewalk, readPrewalkConfig } from "../config/prewalk-config.js";
import {
	ContextPressureController,
	DEFAULT_EXECUTOR_COMPACTION_POLICY,
	type ExecutorCompactionPolicy,
} from "../executor/context-pressure.js";
import {
	type ExecutorChainResolution,
	type ExecutorRejection,
	isSameModelAtEffectiveReasoning,
	type RejectedExecutor,
	resolveConfiguredExecutor,
} from "../executor/selection.js";
import {
	createTemporaryModelRuntime,
	TemporaryModelController,
	type TemporaryModelLease,
} from "../executor/temporary-runtime.js";
import { isRecord } from "../guards.js";
import { type HostRunIdentity, PiHostEventCorrelation } from "../host-event-correlation.js";
import { admitAutomaticPrewalk } from "../orchestration/admission.js";
import {
	DEFAULT_EXECUTOR,
	isPlannerSelected,
	type PlannerProfile,
	PREWALK_CHECKLIST_MESSAGE_TYPE,
	PREWALK_CONTINUE_MESSAGE_TYPE,
	PREWALK_PLAN_MESSAGE_TYPE,
	type PrewalkConfig,
	type PrewalkRun,
	REASONING_LEVELS,
} from "../orchestration/coordinator.js";
import { PrewalkApplication } from "../orchestration/prewalk-application.js";
import {
	type AuditEventKind,
	createAuditRecord,
	createAutoModeRecord,
	PREWALK_AUDIT_TYPE,
	PREWALK_AUTO_MODE_TYPE,
} from "../session/audit.js";
import { loadSessionTitlesForIds } from "../session/metadata.js";
import {
	latestAuditRecord,
	latestAutoModeRecord,
	latestPrewalkToolSlate,
	SessionRecovery,
} from "../session/recovery.js";
import { PREWALK_TODO_TOOL_NAME } from "../turn/todo.js";
import { TurnGate } from "../turn/turn-gate.js";
import { compactStatus, type DelegationStatus } from "../ui/status.js";
import { registerPrewalkCommand } from "./register-commands.js";
import { registerPrewalkTools } from "./register-tools.js";

const STATUS_KEY = "prewalk";
const PREWALK_TOOL_SLATE_TYPE = "prewalk-tool-slate";
const PREWALK_ASSESS_MESSAGE_TYPE = "prewalk-assess";
const PREWALK_ASSESS_TOOL_NAME = "prewalk_assess";
const PROMPT_TYPES = new Set([
	PREWALK_PLAN_MESSAGE_TYPE,
	PREWALK_CONTINUE_MESSAGE_TYPE,
	PREWALK_CHECKLIST_MESSAGE_TYPE,
	PREWALK_ASSESS_MESSAGE_TYPE,
]);

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

interface PromptSet {
	plan: string;
	assess: string;
	continue: string;
	checklist: string;
	todo: string;
}

function promptFile(name: string): URL {
	return new URL(`../../prompts/${name}`, import.meta.url);
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

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
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

function defaultConfig(): PrewalkConfig {
	return {
		enabled: false,
		executor: { ...DEFAULT_EXECUTOR },
		analytics: structuredClone(DEFAULT_ANALYTICS_CONFIG),
	};
}

function identityOf(run: PrewalkRun): HostRunIdentity;
function identityOf(run: undefined): undefined;
function identityOf(run: PrewalkRun | undefined): HostRunIdentity | undefined;
function identityOf(run: PrewalkRun | undefined): HostRunIdentity | undefined {
	return run ? { runId: run.id, epoch: run.epoch } : undefined;
}

function sameRunIdentity(
	identity: HostRunIdentity | undefined,
	run: PrewalkRun | undefined,
): boolean {
	return (
		identity !== undefined &&
		run !== undefined &&
		identity.runId === run.id &&
		identity.epoch === run.epoch
	);
}

function sameCapturedRun(
	identity: HostRunIdentity | undefined,
	run: PrewalkRun | undefined,
): boolean {
	return identity === undefined ? run === undefined : sameRunIdentity(identity, run);
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

export function registerPrewalkEvents(pi: ExtensionAPI): void {
	const application = new PrewalkApplication();
	const hostCorrelation = new PiHostEventCorrelation();
	const turnGate = new TurnGate();
	const sessionRecovery = new SessionRecovery();
	const loadSessionTitles = async (
		sessionIds?: readonly string[],
	): Promise<ReadonlyMap<string, string>> =>
		loadSessionTitlesForIds(getAgentDir(), sessionIds, process.env.PI_CODING_AGENT_SESSION_DIR);
	let activeSessionId: string | undefined;
	let autoEnabled = false;
	let lastOutcome: "bypassed" | "completed" | "failed" | "released" | undefined;
	let pendingAdmission = false;
	let evaluation: EvaluationState | undefined;
	let runtimeController: TemporaryModelController | undefined;
	const getRuntimeController = (ctx: ExtensionContext): TemporaryModelController => {
		if (!runtimeController) {
			runtimeController = new TemporaryModelController(() =>
				createTemporaryModelRuntime(pi, ctx.modelRegistry),
			);
		}
		return runtimeController;
	};
	let primaryAgentStream = false;
	let prewalkToolSlate: string[] | undefined;
	let lastAuditKey: string | undefined;
	let lastStatus: string | undefined;
	let retainedCancelledRun: PrewalkRun | undefined;
	let childDiagnostic: string | undefined;
	let delegation: DelegationStatus | undefined;
	const contextPressure = new ContextPressureController();
	let removeTerminalInputListener: (() => void) | undefined;
	const refreshExecutorCompactionPolicy = (ctx: ExtensionContext): ExecutorCompactionPolicy => {
		const policy = readExecutorCompactionPolicy(ctx);
		contextPressure.setPolicy(policy);
		return policy;
	};
	const deactivatePrewalkTools = (): void => {
		const capturedSlate = prewalkToolSlate;
		const baseline =
			capturedSlate ?? pi.getActiveTools().filter((name) => name !== PREWALK_ASSESS_TOOL_NAME);
		prewalkToolSlate = undefined;
		const restoreCapturedChildSlate =
			process.env.PI_SUBAGENT_CHILD === "1" && capturedSlate !== undefined;
		const next = restoreCapturedChildSlate
			? [...baseline]
			: baseline.filter((name) => name !== PREWALK_TODO_TOOL_NAME);
		if (
			!restoreCapturedChildSlate &&
			(process.env.PI_SUBAGENT_CHILD !== "1" ||
				baseline.includes(PREWALK_TODO_TOOL_NAME) ||
				application.run?.todoActive)
		)
			next.push(PREWALK_TODO_TOOL_NAME);
		if (JSON.stringify(next) !== JSON.stringify(pi.getActiveTools())) pi.setActiveTools(next);
	};
	const activatePlanningTools = (toolSlate = pi.getActiveTools(), requireTodo = false): void => {
		const baseline = toolSlate.filter((name) => name !== PREWALK_ASSESS_TOOL_NAME);
		prewalkToolSlate ??= baseline;
		const todoWasActive =
			requireTodo ||
			baseline.includes(PREWALK_TODO_TOOL_NAME) ||
			application.run?.todoActive === true;
		const next = todoWasActive
			? [
					...baseline.filter((name) => name !== "todo" && name !== PREWALK_TODO_TOOL_NAME),
					PREWALK_TODO_TOOL_NAME,
				]
			: [...baseline];
		if (JSON.stringify(next) !== JSON.stringify(pi.getActiveTools())) pi.setActiveTools(next);
	};
	const beginEvaluation = (): EvaluationState => {
		const toolSlate = pi.getActiveTools().filter((name) => name !== PREWALK_ASSESS_TOOL_NAME);
		const state: EvaluationState = { id: randomUUID(), toolSlate, invalid: false };
		evaluation = state;
		turnGate.resetEvaluation();
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
	const correlationIdentity = (): HostRunIdentity | undefined => {
		const runIdentity = identityOf(application.run);
		return (
			runIdentity ?? (evaluation ? { runId: evaluation.id, epoch: evaluation.id } : undefined)
		);
	};
	const assertCurrentToolExecution = (toolCallId: string): void => {
		const correlation = hostCorrelation.observe(
			{ type: "tool", toolCallId },
			correlationIdentity(),
		);
		if (correlation.decision === "ignore") {
			throw new Error("Prewalk tool execution is stale.");
		}
	};
	const analytics = new PrewalkAnalytics(getAgentDir());
	const analyticsHost = (ctx: ExtensionContext) => ({
		sessionId: ctx.sessionManager.getSessionId(),
		findModel: (provider: string, model: string) => ctx.modelRegistry.find(provider, model),
	});
	const updateStatus = (ctx: ExtensionContext): void => {
		const nextStatus =
			childDiagnostic && !application.run
				? `prewalk: child ${childDiagnostic}`
				: compactStatus(
						application.run ?? retainedCancelledRun,
						ctx.model,
						ctx.thinkingLevel,
						delegation,
						{
							mode: autoEnabled ? "auto-ready" : "manual",
							...(lastOutcome ? { lastOutcome } : {}),
						},
					);
		if (nextStatus === lastStatus) return;
		ctx.ui.setStatus(STATUS_KEY, nextStatus);
		lastStatus = nextStatus;
	};
	const audit = (event: AuditEventKind, ctx: ExtensionContext): void => {
		const run = application.run;
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
	const resetExecutorCompactionState = (): void => {
		contextPressure.reset();
	};
	type DelegationInvocation = {
		toolCallId: string;
		rootSessionId: string;
		parentSessionId: string;
		analyticsGeneration: string;
		childCount: number;
		delegationRunId?: string;
	};
	const delegationInvocations: DelegationInvocation[] = [];

	const recordDelegationProjection = async (
		invocation: DelegationInvocation,
		details: unknown,
		isError: boolean,
	): Promise<void> => {
		try {
			const delegationRunId = await analytics.recordDelegation({
				rootSessionId: invocation.rootSessionId,
				parentSessionId: invocation.parentSessionId,
				invocationId: invocation.toolCallId,
				childCount: invocation.childCount,
				details,
				isError,
				generation: invocation.analyticsGeneration,
			});
			if (delegationRunId) invocation.delegationRunId = delegationRunId;
		} catch {
			// Delegation analytics are best-effort and must not block routing.
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

	const fail = (
		reasonCode: string,
		holdExecutorRoute: boolean,
		ctx: ExtensionContext,
		expectedRun?: HostRunIdentity,
	): void => {
		const failedRun = application.run;
		if (expectedRun !== undefined && !sameRunIdentity(expectedRun, failedRun)) return;
		const failedIdentity = identityOf(failedRun);
		if (failedIdentity !== undefined) hostCorrelation.discardPendingForRun(failedIdentity);
		resetExecutorCompactionState();
		if (!application.run) {
			if (!ctx.model) {
				ctx.ui.notify(`Prewalk failed: ${reasonCode}.`, "error");
				return;
			}
			application.start(
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
		application.fail(reasonCode, holdExecutorRoute);
		getRuntimeController(ctx).restore(identityOf(failedRun));
		turnGate.resetMutationEvidence();
		audit("failed", ctx);
		if (
			reasonCode === "executor-stream-failed" ||
			(reasonCode !== "provider-drift" && analytics.hasUsageFor(failedRun))
		) {
			void analytics.finalize("failed", failedRun).catch(() => {
				ctx.ui.notify("Prewalk analytics finalization failed; retrying is safe.", "error");
			});
		}
		deactivatePrewalkTools();
		ctx.ui.notify(`Prewalk failed: ${reasonCode}.`, "error");
	};

	const cancel = async (selectedModelIsPlanner: boolean, ctx: ExtensionContext): Promise<void> => {
		const run = application.run;
		if (!run) return;
		const runIdentity = identityOf(run);
		hostCorrelation.discardPendingForRun(runIdentity);
		resetExecutorCompactionState();
		application.cancel(selectedModelIsPlanner);
		primaryAgentStream = false;
		turnGate.resetMutationEvidence();
		audit("cancelled", ctx);
		getRuntimeController(ctx).restore(runIdentity);
		await analytics.finalize("cancelled", run).catch(() => {
			ctx.ui.notify("Prewalk analytics finalization failed; retrying is safe.", "error");
		});
	};

	const release = async (ctx: ExtensionContext): Promise<void> => {
		const run = application.run;
		if (
			!run ||
			run.effectiveRoute !== "executor" ||
			(run.phase !== "active" && run.phase !== "completed")
		) {
			ctx.ui.notify("Prewalk release is valid only after the executor handoff.", "error");
			return;
		}
		const runIdentity = identityOf(run);
		resetExecutorCompactionState();
		application.release();
		audit("manual-release", ctx);
		getRuntimeController(ctx).restore(runIdentity);
		await analytics.finalize("released", run).catch(() => {
			ctx.ui.notify("Prewalk analytics finalization failed; retrying is safe.", "error");
		});
		if (!sameRunIdentity(runIdentity, application.run)) return;
		application.reset();
		turnGate.resetMutationEvidence();
		lastOutcome = "released";
		deactivatePrewalkTools();
		updateStatus(ctx);
		ctx.ui.notify("Prewalk released; the planner is active again.", "info");
	};

	const ensureModelRuntime = (ctx: ExtensionContext): TemporaryModelLease => {
		const run = application.run;
		if (!run) throw new Error("Prewalk is inactive.");
		const runIdentity: HostRunIdentity = { runId: run.id, epoch: run.epoch };
		return getRuntimeController(ctx).ensure(
			{
				runId: run.id,
				planner: run.planner,
				executor: run.config.executor,
				hiddenPlanPrompt: prompts.plan,
			},
			runIdentity,
			{
				isCurrent: () => sameRunIdentity(runIdentity, application.run),
				shouldRouteToExecutor: () =>
					application.run?.phase === "handoff-pending" ||
					application.run?.effectiveRoute === "executor",
				isPrimaryAgentStream: () => primaryAgentStream,
				getExecutorCompactionReserveTokens: () => contextPressure.reserveTokens(),
				onExecutorStreamStarted: async () => {
					if (!sameRunIdentity(runIdentity, application.run)) return;
					contextPressure.onExecutorStreamStarted(runIdentity);
					if (application.run?.phase !== "handoff-pending") return;
					try {
						application.activateExecutor();
						audit("executor-active", ctx);
					} catch {
						fail("provider-drift", false, ctx, runIdentity);
						await analytics.waitForWrites();
					}
				},
				onExecutorStreamSucceeded: async () => {
					if (!sameRunIdentity(runIdentity, application.run)) return;
					contextPressure.onExecutorStreamSucceeded(runIdentity);
					if (application.run?.phase !== "active") return;
					try {
						application.completeHandoff();
						audit("handoff-completed", ctx);
					} catch {
						fail("provider-drift", true, ctx, runIdentity);
						await analytics.waitForWrites();
					}
				},
				onExecutorStreamFailed: async () => {
					if (!sameRunIdentity(runIdentity, application.run)) return;
					contextPressure.onExecutorStreamFailed(runIdentity);
				},
				onExecutorContextPressure: (retry) => {
					if (!sameRunIdentity(runIdentity, application.run)) return;
					contextPressure.onExecutorContextPressure(runIdentity, retry);
				},
				onProviderDrift: () => {
					if (!sameRunIdentity(runIdentity, application.run)) return;
					fail(
						"provider-drift",
						application.run?.effectiveRoute === "executor",
						ctx,
						runIdentity,
					);
				},
			},
		);
	};

	const verifyModelRuntimeOwnership = (ctx: ExtensionContext): boolean => {
		if (
			getRuntimeController(ctx).ownsRoute() ||
			application.run?.phase === "cancelled" ||
			application.run?.phase === "failed"
		) {
			return true;
		}
		fail("provider-drift", application.run?.effectiveRoute === "executor", ctx);
		return false;
	};

	const resolveExecutor = (
		plannerProfile: PlannerProfile,
		config: PrewalkConfig,
		ctx: ExtensionContext,
	): Promise<ExecutorChainResolution> =>
		resolveConfiguredExecutor(plannerProfile, config, ctx.model, ctx.modelRegistry);

	const sendPrompt = async (
		type:
			| typeof PREWALK_PLAN_MESSAGE_TYPE
			| typeof PREWALK_CONTINUE_MESSAGE_TYPE
			| typeof PREWALK_CHECKLIST_MESSAGE_TYPE,
		ctx: ExtensionContext,
		triggerTurn = false,
	): Promise<void> => {
		const run = application.run;
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

	const contextPressureHost = (ctx: ExtensionContext) => ({
		currentRun: () => application.run,
		compact: (callbacks: { onComplete: () => void; onError: (error: Error) => void }) =>
			ctx.compact(callbacks),
		notify: (message: string, level: "error" | "warning") => ctx.ui.notify(message, level),
		fail: (reason: string, holdExecutorRoute: boolean, expected: HostRunIdentity) =>
			fail(reason, holdExecutorRoute, ctx, expected),
		sendRetryChecklist: async (expected: HostRunIdentity) => {
			if (!sameRunIdentity(expected, application.run)) return;
			await sendPrompt(PREWALK_CHECKLIST_MESSAGE_TYPE, ctx, true);
		},
		sendNextTurnChecklist: (expected: HostRunIdentity) => {
			const run = application.run;
			if (!run || !sameRunIdentity(expected, run)) return;
			pi.sendMessage(
				{
					customType: PREWALK_CHECKLIST_MESSAGE_TYPE,
					content: prompts.checklist,
					display: false,
					details: { runId: run.id },
				},
				{ deliverAs: "nextTurn" },
			);
		},
	});

	/**
	 * Reports whether the run took hold, so a caller such as the child path can
	 * explain an unarmed session instead of leaving the reason nowhere.
	 */
	const startRun = async (
		mode: "automatic" | "manual",
		ctx: ExtensionContext,
		triggerTurn = false,
		configOverride?: PrewalkConfig,
		expectedRun?: HostRunIdentity | null,
		requireTodo = false,
	): Promise<"armed" | "executor-unavailable" | "failed"> => {
		let armedRunIdentity: HostRunIdentity | undefined;
		try {
			const expectedCurrent = application.run;
			if (
				expectedRun !== undefined &&
				(expectedRun === null
					? expectedCurrent !== undefined
					: !sameRunIdentity(expectedRun, expectedCurrent))
			) {
				return "failed";
			}
			const config = configOverride ?? (await readPrewalkConfig());
			const compactionState = nativeResponsesCompactionState();
			if (compactionState === "invalid") throw new Error("configuration-invalid");
			if (compactionState === "enabled") {
				throw new Error("native-compaction-unsupported");
			}
			activatePlanningTools(undefined, requireTodo);
			if (!ctx.model) throw new Error("model-unavailable");
			const planner: PlannerProfile = {
				provider: ctx.model.provider,
				model: ctx.model.id,
				reasoning: ctx.thinkingLevel ?? "off",
			};
			const resolution = await resolveExecutor(planner, config, ctx);
			const beforeArm = application.run;
			if (
				expectedRun !== undefined &&
				(expectedRun === null
					? beforeArm !== undefined
					: !sameRunIdentity(expectedRun, beforeArm))
			) {
				return "failed";
			}
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
			const action = application.start(
				randomUUID(),
				randomUUID(),
				mode,
				todoActive,
				planner,
				effectiveConfig,
			);
			retainedCancelledRun = undefined;
			const armedRun = application.run;
			armedRunIdentity = identityOf(armedRun);
			if (armedRun && prewalkToolSlate) {
				pi.appendEntry(PREWALK_TOOL_SLATE_TYPE, {
					schemaVersion: 1,
					runId: armedRun.id,
					tools: [...prewalkToolSlate],
				});
			}
			refreshExecutorCompactionPolicy(ctx);
			ensureModelRuntime(ctx);
			if (armedRun) {
				await analytics.open(armedRun, analyticsHost(ctx)).catch(() => {
					analytics.resetActive();
					ctx.ui.notify("Prewalk analytics could not start; routing is unchanged.", "error");
				});
			}
			if (
				!armedRun ||
				!sameRunIdentity(armedRunIdentity, application.run) ||
				(armedRun.phase !== "armed" &&
					armedRun.phase !== "planning" &&
					armedRun.phase !== "ready")
			) {
				if (armedRun && sameRunIdentity(armedRunIdentity, application.run)) {
					getRuntimeController(ctx).restore(armedRunIdentity);
					await analytics
						.finalize(armedRun.phase === "failed" ? "failed" : "cancelled", armedRun)
						.catch(() => undefined);
				}
				return "failed";
			}
			turnGate.resetMutationEvidence();
			audit("armed", ctx);
			if (action.type === "send-planning") {
				await sendPrompt(PREWALK_PLAN_MESSAGE_TYPE, ctx, triggerTurn);
			}
			return "armed";
		} catch (error) {
			const currentRun = application.run;
			if (
				expectedRun !== undefined &&
				(expectedRun === null
					? currentRun !== undefined
					: !sameRunIdentity(expectedRun, currentRun))
			) {
				return "failed";
			}
			if (
				armedRunIdentity !== undefined &&
				(!sameRunIdentity(armedRunIdentity, currentRun) ||
					currentRun?.phase === "cancelled" ||
					currentRun?.phase === "failed")
			)
				return "failed";
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

	const startChildPrewalkRun = async (ctx: ExtensionContext): Promise<void> => {
		if (process.env.PI_SUBAGENT_CHILD !== "1") return;
		const identity = childIdentity();
		if (!identity) {
			childDiagnostic = "identity-unavailable";
			updateStatus(ctx);
			return;
		}
		let config: PrewalkConfig;
		try {
			config = await readPrewalkConfig();
		} catch {
			childDiagnostic = "configuration-invalid";
			updateStatus(ctx);
			return;
		}
		const policy = config.children?.agents[identity.agent];
		if (policy === undefined || policy === false) {
			childDiagnostic = policy === false ? "child-disabled" : "agent-not-opted-in";
			updateStatus(ctx);
			return;
		}
		if (!pi.getActiveTools().some((tool) => CHILD_MUTATION_TOOLS.has(tool))) {
			childDiagnostic = "read-only";
			updateStatus(ctx);
			return;
		}
		const targetExecutor = policy === true ? config.executor : policy.executor;
		const targetModel = ctx.modelRegistry.find(targetExecutor.provider, targetExecutor.model);
		if (
			ctx.model &&
			targetModel &&
			isSameModelAtEffectiveReasoning(
				ctx.model,
				ctx.thinkingLevel ?? "off",
				targetModel,
				targetExecutor.reasoning,
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
		const outcome = await startRun(
			"automatic",
			ctx,
			false,
			{
				...config,
				executor: targetExecutor,
				executorFallbacks: [],
			},
			undefined,
			true,
		);
		if (outcome === "executor-unavailable") {
			// Without this the child reports no diagnostic at all, so `/prewalk
			// status` cannot say why the hand-off never happened.
			childDiagnostic = "executor-unavailable";
			updateStatus(ctx);
		}
	};

	registerPrewalkTools(pi, {
		application,
		turnGate,
		assertCurrentToolExecution,
		getAssessment: () => evaluation,
		setAssessmentDecision: (decision) => {
			if (evaluation) evaluation.decision = decision;
		},
	});

	registerPrewalkCommand(pi, {
		application,
		turnGate,
		analytics,
		delegation: () => delegation,
		childDiagnostic: () => childDiagnostic,
		autoEnabled: () => autoEnabled,
		lastOutcome: () => lastOutcome,
		setAutoEnabled,
		updateStatus,
		onCancel: async (ctx) => {
			setAutoEnabled(false, ctx);
			updateStatus(ctx);
			if (evaluation) {
				restoreEvaluationTools();
				evaluation = undefined;
			}
			pendingAdmission = false;
			if (application.run) {
				const cancelledRun = identityOf(application.run);
				await cancel(isPlannerSelected(ctx.model, application.run.planner), ctx);
				if (sameRunIdentity(cancelledRun, application.run)) {
					deactivatePrewalkTools();
					retainedCancelledRun = application.run;
					application.reset();
				}
			}
		},
		onRelease: release,
		startManual: async (ctx) => {
			await startRun("manual", ctx);
		},
		onConfigure: configurePrewalk,
		loadSessionTitles,
		analyticsConfig: () => application.run?.config.analytics ?? DEFAULT_ANALYTICS_CONFIG,
	});

	pi.on("session_start", async (event, ctx) => {
		resetExecutorCompactionState();
		retainedCancelledRun = undefined;
		refreshExecutorCompactionPolicy(ctx);
		activeSessionId = ctx.sessionManager.getSessionId();
		primaryAgentStream = false;
		hostCorrelation.resetSession();
		delegation = undefined;
		delegationInvocations.length = 0;
		removeTerminalInputListener?.();
		removeTerminalInputListener = ctx.ui.onTerminalInput((data) => {
			const run = application.run;
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
		// Child sessions keep the exact tool slate supplied by pi-subagents until
		// their own policy has positively opted them in. In particular, an
		// unconfigured or read-only child must not gain prewalk_todo just because
		// this extension was loaded.
		if (process.env.PI_SUBAGENT_CHILD !== "1") deactivatePrewalkTools();
		turnGate.restoreTodo(
			ctx.sessionManager
				.buildContextEntries()
				.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
		);
		if (event.reason === "reload") {
			const entries = ctx.sessionManager.getBranch();
			const autoMode = latestAutoModeRecord(entries);
			autoEnabled = autoMode?.sessionId === activeSessionId && autoMode.enabled;
			const record = latestAuditRecord(entries);
			if (evaluation) {
				restoreEvaluationTools();
				evaluation = undefined;
			}
			const recovery = await sessionRecovery.recover(record, {
				nativeCompactionState: nativeResponsesCompactionState,
				restoreRun: (restored) => {
					application.restore(restored);
					prewalkToolSlate = latestPrewalkToolSlate(entries, restored.id);
					if (
						restored.todoActive &&
						restored.phase !== "cancelled" &&
						restored.phase !== "failed"
					) {
						activatePlanningTools();
					}
					if (record) lastAuditKey = JSON.stringify(record);
				},
				resolveExecutor: async (restored) => {
					const resolution = await resolveExecutor(
						restored.planner,
						{ ...restored.config, executorFallbacks: [] },
						ctx,
					);
					return resolution.ok ? { ok: true } : { ok: false, rejected: resolution.rejected };
				},
				installRuntime: () => {
					ensureModelRuntime(ctx);
				},
				restoreAnalyticsJournal: (restored) => analytics.restore(restored, analyticsHost(ctx)),
			});
			switch (recovery.type) {
				case "terminal":
					application.reset();
					lastAuditKey = JSON.stringify(recovery.record);
					updateStatus(ctx);
					return;
				case "restart":
					application.reset();
					if (record) lastAuditKey = JSON.stringify(record);
					await startRun("automatic", ctx);
					return;
				case "refused":
					application.reset();
					getRuntimeController(ctx).restore();
					turnGate.resetMutationEvidence();
					deactivatePrewalkTools();
					ctx.ui.notify(unavailableExecutorNotice(recovery.rejected), "error");
					updateStatus(ctx);
					return;
				case "failed":
					fail(
						recovery.reason,
						recovery.run.effectiveRoute === "executor",
						ctx,
						identityOf(recovery.run),
					);
					updateStatus(ctx);
					return;
				case "restored":
					if (
						!recovery.analyticsRestored &&
						recovery.run.phase !== "failed" &&
						recovery.run.phase !== "cancelled"
					) {
						analytics.resetActive();
						ctx.ui.notify(
							"Prewalk analytics could not restore; routing is unchanged.",
							"error",
						);
					}
					updateStatus(ctx);
					return;
				case "none":
					await startChildPrewalkRun(ctx);
					return;
			}
		}
		application.reset();
		autoEnabled = false;
		lastOutcome = undefined;
		pendingAdmission = false;
		evaluation = undefined;
		turnGate.resetMutationEvidence();
		lastAuditKey = undefined;
		await analytics.finalizeInterrupted(activeSessionId, analyticsHost(ctx)).catch(() => {
			ctx.ui.notify(
				"Prewalk could not finalize interrupted analytics; planner routing is unchanged.",
				"error",
			);
		});
		if (process.env.PI_SUBAGENT_CHILD === "1") {
			await startChildPrewalkRun(ctx);
			return;
		}
		if (event.reason === "startup" || event.reason === "new" || event.reason === "fork") {
			try {
				const config = await readPrewalkConfig();
				if (config.enabled) {
					setAutoEnabled(true, ctx);
					updateStatus(ctx);
				}
			} catch {
				// Missing or invalid configuration keeps the safe manual default. The
				// normal run command reports the actionable configuration error.
			}
		}
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
			if (application.run) {
				const cancelledRun = identityOf(application.run);
				await cancel(isPlannerSelected(ctx.model, application.run.planner), ctx);
				if (!sameRunIdentity(cancelledRun, application.run)) return { action: "handled" };
				lastOutcome = "completed";
				deactivatePrewalkTools();
				application.reset();
				updateStatus(ctx);
				return { action: "handled" };
			}
			return { action: "continue" };
		}
		if (
			!autoEnabled ||
			application.run ||
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
		hostCorrelation.observe({ type: "before-agent" }, identityOf(application.run));
		if (!pendingAdmission || application.run || evaluation) return;
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
		const run = application.run;
		getRuntimeController(ctx).restore();
		if (event.reason !== "reload") {
			const outcome: RunOutcome =
				run?.effectiveRoute === "executor" &&
				(run.phase === "active" || run.phase === "completed")
					? "session-ended"
					: run?.phase === "failed"
						? "failed"
						: "cancelled";
			// Analytics must never block shutdown; a lost receipt is recoverable from
			// its journal, an unfinished shutdown is not.
			try {
				await analytics.finalize(outcome, run);
				if (run) audit("session-ended", ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(
					`Prewalk could not record the final analytics receipt (${message}).`,
					"error",
				);
			}
		} else {
			await analytics.waitForWrites();
		}
		removeTerminalInputListener?.();
		removeTerminalInputListener = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		lastStatus = undefined;
	});

	pi.on("agent_start", (_event, ctx) => {
		const correlation = hostCorrelation.observe(
			{ type: "agent-start" },
			identityOf(application.run),
		);
		if (correlation.decision === "ignore") return;
		if (!verifyModelRuntimeOwnership(ctx)) return;
		refreshExecutorCompactionPolicy(ctx);
		primaryAgentStream = true;
	});

	pi.on("agent_end", (event) => {
		const correlation = hostCorrelation.observe(
			{ type: "agent-end", messages: event.messages },
			identityOf(application.run),
		);
		if (correlation.decision === "ignore") return;
		primaryAgentStream = false;
	});

	pi.on("message_start", (event) => {
		hostCorrelation.observe(
			{ type: "message-start", message: event.message },
			identityOf(application.run),
		);
	});

	pi.on("message_end", async (event) => {
		const run = application.run;
		const correlation = hostCorrelation.observe(
			{ type: "message", message: event.message },
			identityOf(run),
		);
		if (
			correlation.decision === "ignore" ||
			!run ||
			!analytics.hasStateFor(run) ||
			event.message.role !== "assistant" ||
			event.message.stopReason === "aborted"
		)
			return;
		const role = analytics.usageRole(run, event.message.provider, event.message.model);
		await analytics.recordUsage(
			"assistant",
			`message:${event.message.timestamp}:${event.message.provider}:${event.message.model}`,
			event.message.provider,
			event.message.model,
			role,
			event.message.usage,
			run,
		);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const settledRun = application.run;
		const correlation = hostCorrelation.observe(
			{ type: "agent-settled" },
			identityOf(settledRun),
		);
		if (correlation.decision === "ignore") return;
		primaryAgentStream = false;
		const settledIdentity = identityOf(settledRun);
		if (evaluation) {
			const current = evaluation;
			if (current.decision === "continue" && !current.invalid) {
				activatePlanningTools(current.toolSlate);
				evaluation = undefined;
				const startResult = await startRun("automatic", ctx, true, undefined, null);
				if (startResult !== "armed") return;
				if (settledIdentity !== undefined && !sameRunIdentity(settledIdentity, application.run))
					return;
				if (
					application.run?.phase === "cancelled" ||
					application.run?.phase === "failed" ||
					!application.run
				)
					return;
				const action = application.settle({ todoSucceeded: false });
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
		const run = application.run;
		if (!run) return;
		const runIdentity = identityOf(run);
		if (run.phase === "cancelled") {
			primaryAgentStream = false;
			return;
		}
		refreshExecutorCompactionPolicy(ctx);
		const pressureObservation = contextPressure.settle(run, contextPressureHost(ctx));
		if (
			pressureObservation === "host-compacted" ||
			pressureObservation === "compaction-requested" ||
			pressureObservation === "compaction-pending"
		) {
			// ctx.compact() aborts the active Agent loop before its completion callback
			// runs. The pressure controller keeps this handoff alive until that
			// callback settles and owns the only checklist retry.
			updateStatus(ctx);
			return;
		}
		if (pressureObservation === "executor-failure") {
			fail("executor-stream-failed", run.effectiveRoute === "executor", ctx, runIdentity);
			if (!sameRunIdentity(runIdentity, application.run)) return;
			await analytics.finalize("failed", run).catch(() => {
				ctx.ui.notify("Prewalk analytics finalization failed; retrying is safe.", "error");
			});
			if (!sameRunIdentity(runIdentity, application.run)) return;
		}
		if (
			run.effectiveRoute === "executor" &&
			(run.phase === "active" || run.phase === "completed")
		) {
			updateStatus(ctx);
			return;
		}
		const action = application.requestContinuation(turnGate.hasActionableTodo());
		if (action.type === "send-continuation") {
			await sendPrompt(PREWALK_CONTINUE_MESSAGE_TYPE, ctx, true);
			if (!sameRunIdentity(runIdentity, application.run)) return;
			return;
		}
		const failedRun = run.phase === "failed";
		getRuntimeController(ctx).restore(runIdentity);
		let finalized = false;
		try {
			await analytics.finalize(failedRun ? "failed" : "succeeded", run);
			finalized = true;
		} catch {
			ctx.ui.notify("Prewalk analytics finalization failed; retrying is safe.", "error");
		}
		if (!sameRunIdentity(runIdentity, application.run)) return;
		if (!failedRun && finalized) audit("completed", ctx);
		application.reset();
		lastOutcome = failedRun ? "failed" : "completed";
		turnGate.resetMutationEvidence();
		deactivatePrewalkTools();
		updateStatus(ctx);
	});

	pi.on("tool_call", (event) => {
		const correlation = hostCorrelation.observe(
			{ type: "tool-claim", toolCallId: event.toolCallId },
			correlationIdentity(),
		);
		if (correlation.decision === "ignore") return;
		if (evaluation && !ASSESSMENT_READ_ONLY_TOOLS.has(event.toolName)) {
			evaluation.invalid = true;
			return { block: true, reason: "Prewalk assessment only allows read-only inspection." };
		}
	});

	pi.on("tool_execution_update", (event) => {
		const correlation = hostCorrelation.observe(
			{ type: "tool", toolCallId: event.toolCallId },
			correlationIdentity(),
		);
		if (correlation.decision === "ignore") return;
		if (evaluation) {
			turnGate.recordExecutionUpdate(event, true);
			return;
		}
		if (!acceptsMutationEvidence(application.run)) return;
		turnGate.recordExecutionUpdate(event);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		const correlatedRun = correlationIdentity();
		const correlation = hostCorrelation.observe(
			{ type: "tool-claim", toolCallId: event.toolCallId },
			correlatedRun,
		);
		if (correlation.decision === "ignore") return;
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
				const analyticsGeneration = await analytics.currentGeneration();
				if (!sameCapturedRun(correlatedRun, application.run)) return;
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
		if (!sameCapturedRun(correlatedRun, application.run)) return;
		delegation = {
			agent: delegatedAgent(event.args),
			state: "running",
		};
		updateStatus(ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		const run = application.run;
		const runIdentity = correlationIdentity();
		const correlation = hostCorrelation.observe(
			{ type: "tool", toolCallId: event.toolCallId },
			runIdentity,
		);
		if (correlation.decision === "ignore") return;
		if (evaluation) {
			turnGate.recordResult(
				{
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					input: event.input,
					isError: event.isError,
					details: event.details,
				},
				true,
			);
		}
		if (event.usage && run && analytics.hasStateFor(run)) {
			const selected = ctx.model;
			const provider = selected?.provider ?? run.planner.provider;
			const model = selected?.id ?? run.planner.model;
			if (provider && model) {
				await analytics.recordUsage(
					"tool-result",
					`tool:${event.toolCallId}`,
					provider,
					model,
					"auxiliary",
					event.usage,
					run,
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
			if (!sameCapturedRun(runIdentity, application.run)) return;
			delegation = delegationFromResult(
				event.details,
				event.isError,
				delegation?.agent ?? delegatedAgent(event.input),
			);
			updateStatus(ctx);
		}
		if (!sameRunIdentity(runIdentity, application.run)) return;
		if (!acceptsMutationEvidence(application.run)) return;
		turnGate.recordResult({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			input: event.input,
			isError: event.isError,
			details: event.details,
		});
	});

	pi.on("turn_end", async (event, ctx) => {
		const correlation = hostCorrelation.observe(
			{ type: "message", message: event.message },
			identityOf(application.run),
		);
		if (correlation.decision === "ignore") return;
		if (event.message.role === "assistant" && event.message.stopReason === "aborted") return;
		if (evaluation) {
			const evidence = turnGate.finishTurn(
				event.message,
				{
					todoActive: false,
					todoSeen: false,
				},
				true,
			);
			if (evidence.mutation) evaluation.invalid = true;
			return;
		}
		if (!verifyModelRuntimeOwnership(ctx)) return;
		refreshExecutorCompactionPolicy(ctx);
		const run = application.run;
		if (!run) return;
		const runIdentity = identityOf(run);
		if (acceptsMutationEvidence(run)) {
			const evidence = turnGate.finishTurn(event.message, {
				todoActive: run.todoActive,
				todoSeen: run.todoSeen,
			});
			const wasTodoReady = run.todoSeen;
			const wasContinuePending = run.continuePending;
			const action = application.settle(evidence);
			if (!wasTodoReady && application.run?.todoSeen) audit("todo-ready", ctx);
			if (!wasContinuePending && application.run?.continuePending) audit("progress", ctx);
			if (action.type === "send-planning") {
				await sendPrompt(PREWALK_PLAN_MESSAGE_TYPE, ctx);
				if (!sameRunIdentity(runIdentity, application.run)) return;
			} else if (action.type === "send-continuation") {
				await sendPrompt(PREWALK_CONTINUE_MESSAGE_TYPE, ctx);
				if (!sameRunIdentity(runIdentity, application.run)) return;
			} else if (action.type === "handoff") {
				audit("handoff-triggered", ctx);
				await sendPrompt(PREWALK_CHECKLIST_MESSAGE_TYPE, ctx);
				if (!sameRunIdentity(runIdentity, application.run)) return;
				turnGate.resetMutationEvidence();
			}
		}
		const currentRun = application.run;
		if (
			sameRunIdentity(identityOf(run), currentRun) &&
			event.message.role === "assistant" &&
			!contextPressure.hasRetryPressure(run)
		) {
			const executor =
				currentRun &&
				ctx.modelRegistry.find(
					currentRun.config.executor.provider,
					currentRun.config.executor.model,
				);
			const usage = ctx.getContextUsage();
			if (currentRun && executor && usage?.tokens !== null && usage?.tokens !== undefined) {
				contextPressure.observeContextUsage(
					currentRun,
					usage.tokens,
					executor,
					event.message.provider,
					event.message.model,
					event.message.stopReason,
				);
			}
		}
		if (sameRunIdentity(identityOf(run), application.run)) updateStatus(ctx);
	});

	pi.on("context", (event) => ({
		messages: event.messages.filter((message) =>
			shouldExposePrompt(message, application.run, evaluation?.id),
		),
	}));

	pi.on("session_before_compact", (event) => {
		hostCorrelation.observe({ type: "before-compaction" }, identityOf(application.run));
		const run = application.run;
		const compactedMessages = [
			...event.preparation.messagesToSummarize,
			...event.preparation.turnPrefixMessages,
		];
		contextPressure.beforeCompaction(
			run,
			compactedMessages,
			(message, runId) =>
				isRecord(message) &&
				message.role === "custom" &&
				message.customType === PREWALK_CHECKLIST_MESSAGE_TYPE &&
				isRecord(message.details) &&
				message.details.runId === runId,
		);
		event.preparation.messagesToSummarize = event.preparation.messagesToSummarize.filter(
			(message) => !isEphemeralPrewalkPrompt(message),
		);
		event.preparation.turnPrefixMessages = event.preparation.turnPrefixMessages.filter(
			(message) => !isEphemeralPrewalkPrompt(message),
		);
	});

	pi.on("session_compact", async (event, ctx) => {
		const run = application.run;
		const correlation = hostCorrelation.observe({ type: "compaction" }, identityOf(run));
		if (correlation.decision === "ignore") return;
		await contextPressure.afterCompaction(run, contextPressureHost(ctx));
		if (!event.compactionEntry.usage || !run || !analytics.hasStateFor(run)) return;
		const selected = ctx.model;
		const provider = selected?.provider ?? run?.planner.provider;
		const model = selected?.id ?? run?.planner.model;
		if (provider && model) {
			try {
				await analytics.recordUsage(
					"compaction",
					`compaction:${event.compactionEntry.id}`,
					provider,
					model,
					"compaction",
					event.compactionEntry.usage,
					run,
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
			turnGate.resetEvaluation();
			updateStatus(ctx);
			return;
		}
		const run = application.run;
		if (!run) {
			if (retainedCancelledRun) updateStatus(ctx);
			return;
		}
		if (run.phase === "cancelled") {
			updateStatus(ctx);
			return;
		}
		const runIdentity = identityOf(run);
		await cancel(isPlannerSelected(event.model, run.planner), ctx);
		if (!sameRunIdentity(runIdentity, application.run)) return;
		application.reset();
		deactivatePrewalkTools();
		lastOutcome = undefined;
		updateStatus(ctx);
	});

	pi.on("thinking_level_select", (event, ctx) => {
		const run = application.run;
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
