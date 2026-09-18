import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type AgentMessage, convertToLlm } from "@earendil-works/pi-agent-core";
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
import { estimateRequestTokens } from "../executor/context.js";
import {
	type ContextCompactionPolicy,
	ContextPressureController,
	DEFAULT_CONTEXT_COMPACTION_POLICY,
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
import {
	type BoundaryValue,
	isBoolean,
	isNumber,
	isRecord,
	isString,
	parseBoundaryValue,
} from "../guards.js";
import { type HostRunIdentity, PiHostEventCorrelation } from "../host-event-correlation.js";
import {
	DEFAULT_EXECUTOR,
	DEFAULT_HANDOFF_CONFIG,
	DEFAULT_PLANNER_RECOVERY_CONFIG,
	isPlannerSelected,
	MUTATION_TOOLS_UNAVAILABLE_REASON,
	type PlannerProfile,
	PREWALK_CHECKLIST_MESSAGE_TYPE,
	PREWALK_CONTINUE_MESSAGE_TYPE,
	PREWALK_PLAN_MESSAGE_TYPE,
	PREWALK_RECOVER_MESSAGE_TYPE,
	type PrewalkConfig,
	type PrewalkRun,
	REASONING_LEVELS,
} from "../orchestration/coordinator.js";
import { PrewalkApplication } from "../orchestration/prewalk-application.js";
import { type AuditEventKind, createAuditRecord, PREWALK_AUDIT_TYPE } from "../session/audit.js";
import { loadSessionTitlesForIds } from "../session/metadata.js";
import { latestAuditRecord, latestPrewalkToolSlate, SessionRecovery } from "../session/recovery.js";
import { blocksPlannerDelegation } from "../turn/delegation-guard.js";
import { hasRecognizedMutationPath, RECOGNIZED_MUTATION_TOOL_NAMES } from "../turn/mutation.js";
import { PREWALK_TODO_TOOL_NAME } from "../turn/todo.js";
import { TurnGate } from "../turn/turn-gate.js";
import { compactStatus, type DelegationStatus, type SessionStatus } from "../ui/status.js";
import { registerPrewalkCommand } from "./register-commands.js";
import { registerPrewalkTools } from "./register-tools.js";

const STATUS_KEY = "prewalk";
const PREWALK_TOOL_SLATE_TYPE = "prewalk-tool-slate";
// Remove this name from a stale Pi tool slate left by older Prewalk builds;
// the assessment tool is no longer registered or part of the lifecycle.
const LEGACY_PREWALK_ASSESS_TOOL_NAME = "prewalk_assess";
const PROMPT_TYPES = new Set([
	PREWALK_PLAN_MESSAGE_TYPE,
	PREWALK_RECOVER_MESSAGE_TYPE,
	PREWALK_CONTINUE_MESSAGE_TYPE,
	PREWALK_CHECKLIST_MESSAGE_TYPE,
]);

function activeChildAgentFromSystemPrompt(systemPrompt?: string): string | undefined {
	const match = systemPrompt?.match(/(?:^|\n)<active_agent name="([^"\r\n]+)"\/>/);
	return match?.[1];
}

function failureNotice(reasonCode: string): string {
	if (reasonCode === MUTATION_TOOLS_UNAVAILABLE_REASON) {
		const toolNames = RECOGNIZED_MUTATION_TOOL_NAMES;
		const options = `${toolNames.slice(0, -1).join(", ")}, or ${toolNames[toolNames.length - 1]}`;
		return `Prewalk failed: no active mutation-capable tool can prove the first edit. Enable ${options}.`;
	}
	if (reasonCode === "host-correlation-retry-failed")
		return "Prewalk could not recover its planning checkpoint after a stale host event. Run /prewalk run to retry safely.";
	if (reasonCode === "planner-recovery-exhausted")
		return "Prewalk failed: planner recovery reached its configured retry limit.";
	return `Prewalk failed: ${reasonCode}.`;
}

function readContextCompactionPolicy(ctx: ExtensionContext): ContextCompactionPolicy {
	try {
		const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		}).getCompactionSettings();
		return {
			enabled: settings.enabled,
			reserveTokens:
				Number.isFinite(settings.reserveTokens) && settings.reserveTokens >= 0
					? settings.reserveTokens
					: DEFAULT_CONTEXT_COMPACTION_POLICY.reserveTokens,
		};
	} catch {
		// A settings read must not prevent the extension from loading. The stock
		// reserve is safer than sending an unguarded Prewalk request.
		return DEFAULT_CONTEXT_COMPACTION_POLICY;
	}
}

interface PromptSet {
	plan: string;
	recover: string;
	continue: string;
	checklist: string;
	todo: string;
}

interface PromptDispatch {
	content: string;
	event: AuditEventKind;
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
		recover: readFileSync(promptFile("prewalk-recover.md"), "utf8"),
		continue: readFileSync(promptFile("prewalk-continue.md"), "utf8"),
		checklist: readFileSync(promptFile("prewalk-checklist.md"), "utf8"),
		todo: readFileSync(promptFile("todo.md"), "utf8"),
	};
}

const prompts = loadPrompts();

function nativeResponsesCompactionState(): "disabled" | "enabled" | "invalid" {
	let raw: string;
	try {
		raw = readFileSync(path.join(getAgentDir(), "pi-codex-conversion.json"), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return "disabled";
		return "invalid";
	}
	let config: BoundaryValue;
	try {
		config = JSON.parse(raw);
	} catch {
		return "invalid";
	}
	if (!isRecord(config)) return "invalid";
	if (config.compaction === undefined) {
		const legacyResponsesCompaction = config.responsesCompaction;
		if (legacyResponsesCompaction === undefined) return "disabled";
		if (!isBoolean(legacyResponsesCompaction)) return "invalid";
		return legacyResponsesCompaction ? "enabled" : "disabled";
	}
	if (!isRecord(config.compaction)) return "invalid";
	if (config.compaction.responsesCompaction === undefined) return "disabled";
	if (!isBoolean(config.compaction.responsesCompaction)) return "invalid";
	return config.compaction.responsesCompaction ? "enabled" : "disabled";
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
): run is PrewalkRun {
	return identity !== undefined && run?.id === identity.runId && run?.epoch === identity.epoch;
}

function sameCapturedRun(
	identity: HostRunIdentity | undefined,
	run: PrewalkRun | undefined,
): boolean {
	return identity === undefined ? run === undefined : sameRunIdentity(identity, run);
}

function shouldExposePrompt(message: AgentMessage, run: PrewalkRun | undefined): boolean {
	if (message.role !== "custom" || !PROMPT_TYPES.has(message.customType)) return true;
	if (!isRecord(message.details)) return false;
	const messageRunId = isString(message.details.runId) ? message.details.runId : undefined;
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
			message.customType === PREWALK_RECOVER_MESSAGE_TYPE)
	);
}

function delegatedAgent(value: BoundaryValue): string {
	if (!isRecord(value)) return "subagent";
	const raw = isString(value.agent) ? value.agent.trim() : "";
	return raw ? raw.slice(0, 32) : "subagent";
}

function delegatedChildCount(value: BoundaryValue): number {
	if (!isRecord(value)) return 1;
	const requestedCount = (item: BoundaryValue): number => {
		if (!isRecord(item) || !isNumber(item.count) || !Number.isSafeInteger(item.count)) {
			return 1;
		}
		return Math.max(1, item.count);
	};
	if (Array.isArray(value.tasks)) {
		return Math.max(
			1,
			value.tasks.reduce<number>(
				(count: number, item: BoundaryValue) => count + requestedCount(item),
				0,
			),
		);
	}
	if (Array.isArray(value.chain)) {
		return Math.max(
			1,
			value.chain.reduce<number>((count: number, step: BoundaryValue) => {
				if (!isRecord(step)) return count + 1;
				return (
					count +
					(Array.isArray(step.parallel)
						? step.parallel.reduce<number>(
								(parallelCount: number, item: BoundaryValue) =>
									parallelCount + requestedCount(item),
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
	details: BoundaryValue,
	isError: boolean,
	fallbackAgent: string,
): DelegationStatus {
	if (!isRecord(details) || !Array.isArray(details.results)) {
		const status: DelegationStatus = {
			agent: fallbackAgent,
			state: isError ? "failed" : "completed",
		};
		if (isError) status.reason = "subagent-tool-failed";
		return status;
	}
	for (const value of details.results) {
		if (!isRecord(value)) continue;
		const agent = delegatedAgent(value);
		if (
			value.timedOut === true ||
			value.stopped === true ||
			value.interrupted === true ||
			(isNumber(value.exitCode) && value.exitCode !== 0) ||
			isString(value.error)
		) {
			return {
				agent,
				state: "failed",
				reason: value.timedOut === true ? "timed-out" : "subagent-tool-failed",
			};
		}
	}
	const status: DelegationStatus = {
		agent: fallbackAgent,
		state: isError ? "failed" : "completed",
	};
	if (isError) status.reason = "subagent-tool-failed";
	return status;
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
	let lastOutcome: "bypassed" | "completed" | "failed" | "released" | undefined;
	let runtimeController: TemporaryModelController | undefined;
	const getRuntimeController = (ctx: ExtensionContext): TemporaryModelController => {
		runtimeController ??= new TemporaryModelController(() =>
			createTemporaryModelRuntime(pi, ctx.modelRegistry),
		);
		return runtimeController;
	};
	let prewalkToolSlate: string[] | undefined;
	let lastAuditKey: string | undefined;
	let lastStatus: string | undefined;
	let retainedCancelledRun: PrewalkRun | undefined;
	let childDiagnostic: string | undefined;
	let delegation: DelegationStatus | undefined;
	let planningRetry: HostRunIdentity | undefined;
	let planningRetryStarted = false;
	let planningRecoveryAttempts = 0;
	let planningRecoveryPaused = false;
	const contextPressure = new ContextPressureController();
	let removeTerminalInputListener: (() => void) | undefined;
	const refreshContextCompactionPolicy = (ctx: ExtensionContext): ContextCompactionPolicy => {
		const policy = readContextCompactionPolicy(ctx);
		contextPressure.setPolicy(policy);
		return policy;
	};
	const deactivatePrewalkTools = (): void => {
		const baseline = prewalkToolSlate ?? pi.getActiveTools();
		prewalkToolSlate = undefined;
		const next = baseline.filter(
			(name) => name !== PREWALK_TODO_TOOL_NAME && name !== LEGACY_PREWALK_ASSESS_TOOL_NAME,
		);
		if (JSON.stringify(next) !== JSON.stringify(pi.getActiveTools())) pi.setActiveTools(next);
	};
	const activatePlanningTools = (toolSlate = pi.getActiveTools(), requireTodo = false): void => {
		const todoWasActive =
			requireTodo ||
			toolSlate.includes(PREWALK_TODO_TOOL_NAME) ||
			application.run?.todoActive === true;
		const baseline = toolSlate.filter(
			(name) => name !== PREWALK_TODO_TOOL_NAME && name !== LEGACY_PREWALK_ASSESS_TOOL_NAME,
		);
		prewalkToolSlate ??= baseline;
		const next = todoWasActive
			? [
					...baseline.filter((name) => name !== "todo" && name !== PREWALK_TODO_TOOL_NAME),
					PREWALK_TODO_TOOL_NAME,
				]
			: [...baseline];
		if (JSON.stringify(next) !== JSON.stringify(pi.getActiveTools())) pi.setActiveTools(next);
	};
	const assertCurrentToolExecution = (
		toolCallId: string,
		ctx: ExtensionContext | undefined,
		retryPlanning: boolean,
	): void => {
		const correlation = hostCorrelation.observe(
			{ type: "tool", toolCallId },
			identityOf(application.run),
		);
		if (correlation.decision !== "ignore") return;
		if (retryPlanning && ctx)
			queuePlanningRetry(
				ctx,
				"next-turn",
				"Prewalk rejected a stale planning tool call; the preserved planning checkpoint was queued for recovery.",
			);
		throw new Error("Prewalk tool execution is stale.");
	};
	const analytics = new PrewalkAnalytics(getAgentDir());
	const analyticsHost = (ctx: ExtensionContext) => ({
		sessionId: ctx.sessionManager.getSessionId(),
		findModel: (provider: string, model: string) => ctx.modelRegistry.find(provider, model),
	});
	const updateStatus = (ctx: ExtensionContext): void => {
		const sessionStatus: SessionStatus = { mode: "manual" };
		if (lastOutcome) sessionStatus.lastOutcome = lastOutcome;
		const nextStatus =
			childDiagnostic && !application.run
				? `prewalk: child ${childDiagnostic}`
				: compactStatus(
						application.run ?? retainedCancelledRun,
						ctx.model,
						ctx.thinkingLevel,
						delegation,
						sessionStatus,
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
	const clearPlanningRetry = (): void => {
		if (planningRetry && sameRunIdentity(planningRetry, application.run)) {
			planningRetry = undefined;
			planningRetryStarted = false;
		}
	};
	const resetPlanningRecovery = (): void => {
		clearPlanningRetry();
		planningRecoveryAttempts = 0;
		planningRecoveryPaused = false;
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
		details: BoundaryValue,
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
		const runId = isString(payload.runId) ? payload.runId : undefined;
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
		resetPlanningRecovery();
		if (failedIdentity !== undefined) hostCorrelation.discardPendingForRun(failedIdentity);
		contextPressure.reset();
		if (!application.run) {
			if (!ctx.model) {
				ctx.ui.notify(failureNotice(reasonCode), "error");
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
				{
					enabled: false,
					executor: { ...DEFAULT_EXECUTOR },
					analytics: structuredClone(DEFAULT_ANALYTICS_CONFIG),
					plannerRecovery: structuredClone(DEFAULT_PLANNER_RECOVERY_CONFIG),
				},
			);
		}
		application.fail(reasonCode, holdExecutorRoute);
		void getRuntimeController(ctx)
			.restore(identityOf(failedRun))
			.catch(() => undefined);
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
		ctx.ui.notify(failureNotice(reasonCode), "error");
	};

	const cancel = async (selectedModelIsPlanner: boolean, ctx: ExtensionContext): Promise<void> => {
		const run = application.run;
		if (!run) return;
		const runIdentity = identityOf(run);
		resetPlanningRecovery();
		hostCorrelation.discardPendingForRun(runIdentity);
		contextPressure.reset();
		ctx.abort();
		application.cancel(selectedModelIsPlanner);
		turnGate.resetMutationEvidence();
		audit("cancelled", ctx);
		await getRuntimeController(ctx).restore(runIdentity, selectedModelIsPlanner);
		updateStatus(ctx);
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
		)
			return ctx.ui.notify("Prewalk release is valid only after the executor handoff.", "error");
		const runIdentity = identityOf(run);
		contextPressure.reset();
		application.release();
		audit("manual-release", ctx);
		await getRuntimeController(ctx).restore(runIdentity);
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
		)
			return true;
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
			| typeof PREWALK_RECOVER_MESSAGE_TYPE
			| typeof PREWALK_CONTINUE_MESSAGE_TYPE
			| typeof PREWALK_CHECKLIST_MESSAGE_TYPE,
		ctx: ExtensionContext,
		triggerTurn = false,
	): Promise<void> => {
		const run = application.run;
		if (!run) return;
		let prompt: PromptDispatch;
		switch (type) {
			case PREWALK_PLAN_MESSAGE_TYPE:
				prompt = { content: prompts.plan, event: "plan-injected" };
				break;
			case PREWALK_RECOVER_MESSAGE_TYPE:
				prompt = { content: prompts.recover, event: "planning-retry" };
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

	const plannerCanRecover = (run: PrewalkRun | undefined): run is PrewalkRun =>
		run?.effectiveRoute === "planner" && (run.phase === "planning" || run.phase === "ready");
	const planningNeedsCheckpoint = (run: PrewalkRun | undefined): boolean =>
		Boolean(plannerCanRecover(run) && run?.todoActive && !run.todoSeen);

	const queuePlanningRetry = (
		ctx: ExtensionContext,
		delivery: "next-turn" | "trigger-turn",
		notice?: string,
	): void => {
		const run = application.run;
		const identity = identityOf(run);
		if (
			!plannerCanRecover(run) ||
			!identity ||
			planningRecoveryPaused ||
			(planningRetry !== undefined && sameRunIdentity(planningRetry, run))
		)
			return;
		const maxRetries =
			run.config.plannerRecovery?.maxRetries ?? DEFAULT_PLANNER_RECOVERY_CONFIG.maxRetries;
		if (planningRecoveryAttempts >= maxRetries) {
			clearPlanningRetry();
			planningRecoveryPaused = true;
			audit("planning-paused", ctx);
			ctx.ui.notify(
				"Prewalk paused automatic planner recovery after the configured retry limit. The saved planning trace and checklist remain active; send another message to continue or run /prewalk cancel to stop.",
				"warning",
			);
			updateStatus(ctx);
			return;
		}
		planningRecoveryAttempts += 1;
		planningRetry = identity;
		planningRetryStarted = false;
		audit("planning-retry", ctx);
		const prompt = run.todoSeen
			? { type: PREWALK_CONTINUE_MESSAGE_TYPE, content: prompts.continue }
			: { type: PREWALK_RECOVER_MESSAGE_TYPE, content: prompts.recover };
		pi.sendMessage(
			{
				customType: prompt.type,
				content: prompt.content,
				display: false,
				details: { runId: run.id },
			},
			delivery === "next-turn" ? { deliverAs: "nextTurn" } : { triggerTurn: true },
		);
		if (notice) ctx.ui.notify(notice, "warning");
		updateStatus(ctx);
	};

	const contextPressureHost = (ctx: ExtensionContext) => ({
		currentRun: () => application.run,
		compact: (callbacks: { onComplete: () => void; onError: (error: Error) => void }) =>
			ctx.compact(callbacks),
		notify: (message: string, level: "error" | "warning") => ctx.ui.notify(message, level),
		fail: (reason: string, holdExecutorRoute: boolean, expected: HostRunIdentity) =>
			fail(reason, holdExecutorRoute, ctx, expected),
		sendRetryPlanning: async (expected: HostRunIdentity) => {
			const run = application.run;
			if (!run || !sameRunIdentity(expected, run)) return;
			await sendPrompt(
				run.todoSeen ? PREWALK_CONTINUE_MESSAGE_TYPE : PREWALK_RECOVER_MESSAGE_TYPE,
				ctx,
				true,
			);
		},
		sendRetryChecklist: async (expected: HostRunIdentity) => {
			if (!sameRunIdentity(expected, application.run)) return;
			await sendPrompt(PREWALK_CHECKLIST_MESSAGE_TYPE, ctx, true);
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
			if (
				mode === "manual" &&
				ctx.isIdle() &&
				(expectedCurrent === undefined ||
					expectedCurrent.phase === "cancelled" ||
					expectedCurrent.phase === "failed")
			)
				hostCorrelation.observe({ type: "idle-boundary" }, undefined);
			const config = configOverride ?? (await readPrewalkConfig());
			const compactionState = nativeResponsesCompactionState();
			if (compactionState === "invalid") throw new Error("configuration-invalid");
			if (compactionState === "enabled") throw new Error("native-compaction-unsupported");
			activatePlanningTools(undefined, requireTodo);
			if (!ctx.model) throw new Error("model-unavailable");
			if (!hasRecognizedMutationPath(pi.getActiveTools()))
				throw new Error(MUTATION_TOOLS_UNAVAILABLE_REASON);
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
			const action = application.start(
				randomUUID(),
				randomUUID(),
				mode,
				pi.getActiveTools().includes(PREWALK_TODO_TOOL_NAME),
				planner,
				{ ...config, executor: resolution.executor },
			);
			retainedCancelledRun = undefined;
			const armedRun = application.run;
			armedRunIdentity = identityOf(armedRun);
			if (armedRun && prewalkToolSlate)
				pi.appendEntry(PREWALK_TOOL_SLATE_TYPE, {
					schemaVersion: 1,
					runId: armedRun.id,
					tools: [...prewalkToolSlate],
				});
			refreshContextCompactionPolicy(ctx);
			ensureModelRuntime(ctx);
			if (armedRun)
				await analytics.open(armedRun, analyticsHost(ctx)).catch(() => {
					analytics.resetActive();
					ctx.ui.notify("Prewalk analytics could not start; routing is unchanged.", "error");
				});
			if (
				!armedRun ||
				!sameRunIdentity(armedRunIdentity, application.run) ||
				(armedRun.phase !== "armed" &&
					armedRun.phase !== "planning" &&
					armedRun.phase !== "ready")
			) {
				if (armedRun && sameRunIdentity(armedRunIdentity, application.run)) {
					await getRuntimeController(ctx).restore(armedRunIdentity);
					await analytics
						.finalize(armedRun.phase === "failed" ? "failed" : "cancelled", armedRun)
						.catch(() => undefined);
				}
				return "failed";
			}
			turnGate.resetMutationEvidence();
			audit("armed", ctx);
			if (action.type === "send-planning")
				await sendPrompt(PREWALK_PLAN_MESSAGE_TYPE, ctx, triggerTurn);
			return "armed";
		} catch (error) {
			const currentRun = application.run;
			if (
				expectedRun !== undefined &&
				(expectedRun === null
					? currentRun !== undefined
					: !sameRunIdentity(expectedRun, currentRun))
			)
				return "failed";
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
					MUTATION_TOOLS_UNAVAILABLE_REASON,
				].includes(error.message)
					? error.message
					: "provider-unavailable";
			fail(reason, false, ctx);
			return "failed";
		}
	};

	const startChildPrewalkRun = async (
		ctx: ExtensionContext,
		activeChildAgent?: string,
	): Promise<void> => {
		const isChildHost = process.env.PI_SUBAGENT_CHILD === "1";
		if (!isChildHost && !activeChildAgent) return;
		const agent = activeChildAgent?.trim() || process.env.PI_SUBAGENT_CHILD_AGENT?.trim();
		const runId = process.env.PI_SUBAGENT_RUN_ID?.trim();
		const identity = agent && (activeChildAgent || runId) ? { agent, runId } : undefined;
		if (!identity) {
			childDiagnostic = "identity-unavailable";
			return updateStatus(ctx);
		}
		let config: PrewalkConfig;
		try {
			config = await readPrewalkConfig();
		} catch {
			childDiagnostic = "configuration-invalid";
			return updateStatus(ctx);
		}
		const policy = config.children?.agents[identity.agent];
		if (policy === undefined || policy === false) {
			childDiagnostic = policy === false ? "child-disabled" : "agent-not-opted-in";
			return updateStatus(ctx);
		}
		if (!hasRecognizedMutationPath(pi.getActiveTools())) {
			childDiagnostic = "read-only";
			return updateStatus(ctx);
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
			return updateStatus(ctx);
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
		onTodoInitialized: resetPlanningRecovery,
	});

	registerPrewalkCommand(pi, {
		application,
		turnGate,
		analytics,
		delegation: () => delegation,
		childDiagnostic: () => childDiagnostic,
		lastOutcome: () => lastOutcome,
		updateStatus,
		onCancel: async (ctx) => {
			updateStatus(ctx);
			if (!application.run) return;
			const cancelledRun = identityOf(application.run);
			await cancel(true, ctx);
			if (!sameRunIdentity(cancelledRun, application.run)) return;
			deactivatePrewalkTools();
			retainedCancelledRun = application.run;
			application.reset();
		},
		onRelease: release,
		startManual: async (ctx) => {
			await startRun("manual", ctx, false, undefined, undefined, true);
		},
		startAutomatic: async (ctx) => {
			await startRun("automatic", ctx, false, undefined, undefined, true);
		},
		onConfigure: configurePrewalk,
		loadSessionTitles,
		analyticsConfig: () => application.run?.config.analytics ?? DEFAULT_ANALYTICS_CONFIG,
	});

	pi.on("session_start", async (event, ctx) => {
		contextPressure.reset();
		await getRuntimeController(ctx).restore();
		retainedCancelledRun = undefined;
		refreshContextCompactionPolicy(ctx);
		activeSessionId = ctx.sessionManager.getSessionId();
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
			)
				return undefined;
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
		const entries = ctx.sessionManager.getBranch();
		const record = latestAuditRecord(entries);
		const canRestoreExistingPlan =
			(event.reason === "startup" || event.reason === "resume") &&
			record?.effectiveRoute === "planner" &&
			(record.phase === "armed" || record.phase === "planning" || record.phase === "ready");
		if (event.reason === "reload" || canRestoreExistingPlan) {
			const recovery = await sessionRecovery.recover(record, {
				nativeCompactionState: nativeResponsesCompactionState,
				restoreRun: (restored) => {
					application.restore(restored);
					planningRecoveryPaused = record?.event === "planning-paused";
					prewalkToolSlate = latestPrewalkToolSlate(entries, restored.id);
					if (
						restored.todoActive &&
						restored.phase !== "cancelled" &&
						restored.phase !== "failed"
					)
						activatePlanningTools();
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
				installRuntime: () => ensureModelRuntime(ctx).sync(),
				restoreAnalyticsJournal: (restored) => analytics.restore(restored, analyticsHost(ctx)),
			});
			switch (recovery.type) {
				case "terminal":
					application.reset();
					lastAuditKey = JSON.stringify(recovery.record);
					return updateStatus(ctx);
				case "restart":
					application.reset();
					if (record) lastAuditKey = JSON.stringify(record);
					await startRun("automatic", ctx);
					return;
				case "refused":
					application.reset();
					await getRuntimeController(ctx).restore();
					turnGate.resetMutationEvidence();
					deactivatePrewalkTools();
					ctx.ui.notify(unavailableExecutorNotice(recovery.rejected), "error");
					return updateStatus(ctx);
				case "failed":
					fail(
						recovery.reason,
						recovery.run.effectiveRoute === "executor",
						ctx,
						identityOf(recovery.run),
					);
					return updateStatus(ctx);
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
					return updateStatus(ctx);
				case "none":
					return startChildPrewalkRun(
						ctx,
						activeChildAgentFromSystemPrompt(ctx.getSystemPrompt?.() ?? ""),
					);
			}
		}
		application.reset();
		lastOutcome = undefined;
		turnGate.resetMutationEvidence();
		lastAuditKey = undefined;
		await analytics.finalizeInterrupted(activeSessionId, analyticsHost(ctx)).catch(() => {
			ctx.ui.notify(
				"Prewalk could not finalize interrupted analytics; planner routing is unchanged.",
				"error",
			);
		});
		const activeChildAgent = activeChildAgentFromSystemPrompt(ctx.getSystemPrompt?.() ?? "");
		if (process.env.PI_SUBAGENT_CHILD === "1" || activeChildAgent)
			return startChildPrewalkRun(ctx, activeChildAgent);
		if (
			ctx.mode === "tui" &&
			(event.reason === "startup" || event.reason === "new" || event.reason === "fork")
		) {
			try {
				const config = await readPrewalkConfig();
				if (config.enabled) await startRun("automatic", ctx, false, config, undefined, true);
			} catch {
				// Missing or invalid configuration keeps the safe manual default. The
				// normal run command reports the actionable configuration error.
			}
		}
	});

	pi.on("input", async (event, ctx) => {
		const control = event.text.trim().toLowerCase();
		if ((control !== "stop" && control !== "cancel") || event.source === "extension") {
			if (event.source !== "extension" && plannerCanRecover(application.run)) {
				resetPlanningRecovery();
			}
			return { action: "continue" };
		}
		if (!application.run) return { action: "continue" };
		const cancelledRun = identityOf(application.run);
		await cancel(true, ctx);
		if (!sameRunIdentity(cancelledRun, application.run)) return { action: "handled" };
		lastOutcome = "completed";
		deactivatePrewalkTools();
		application.reset();
		updateStatus(ctx);
		return { action: "handled" };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		hostCorrelation.observe({ type: "before-agent" }, identityOf(application.run));
		const childAgent = activeChildAgentFromSystemPrompt(event.systemPrompt);
		if (childAgent && !application.run) await startChildPrewalkRun(ctx, childAgent);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		contextPressure.reset();
		activeSessionId = undefined;
		delegation = undefined;
		const run = application.run;
		await getRuntimeController(ctx).restore();
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

	pi.on("agent_start", async (_event, ctx) => {
		const correlation = hostCorrelation.observe(
			{ type: "agent-start" },
			identityOf(application.run),
		);
		if (correlation.decision === "ignore") return;
		if (planningRetry && sameRunIdentity(planningRetry, application.run)) {
			planningRetryStarted = true;
		}
		if (application.run) {
			try {
				await ensureModelRuntime(ctx).sync();
			} catch {
				return;
			}
		}
		if (!verifyModelRuntimeOwnership(ctx)) return;
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!application.run) return;
		try {
			await ensureModelRuntime(ctx).sync();
		} catch {
			return;
		}
		if (!verifyModelRuntimeOwnership(ctx)) return;
		refreshContextCompactionPolicy(ctx);
	});

	pi.on("agent_end", (event, ctx) => {
		const correlation = hostCorrelation.observe(
			{ type: "agent-end", messages: event.messages },
			identityOf(application.run),
		);
		if (correlation.decision === "ignore") return;
		let lastAssistant: Extract<AgentMessage, { role: "assistant" }> | undefined;
		for (let index = event.messages.length - 1; index >= 0; index -= 1) {
			const message = event.messages[index];
			if (message?.role === "assistant") {
				lastAssistant = message;
				break;
			}
		}
		if (lastAssistant?.role !== "assistant" || lastAssistant.stopReason !== "aborted") return;
		if (
			planningRetryStarted &&
			planningRetry !== undefined &&
			sameRunIdentity(planningRetry, application.run)
		)
			clearPlanningRetry();
		queuePlanningRetry(
			ctx,
			"next-turn",
			"Prewalk planning was interrupted; the preserved planner trace was queued for automatic recovery.",
		);
	});

	pi.on("message_start", async (event, ctx) => {
		const run = application.run;
		const correlation = hostCorrelation.observe(
			{ type: "message-start", message: event.message },
			identityOf(run),
		);
		const identity = identityOf(run);
		if (
			correlation.decision !== "ignore" &&
			run &&
			identity &&
			event.message.role === "assistant" &&
			event.message.provider === run.config.executor.provider &&
			event.message.model === run.config.executor.model &&
			(run.phase === "handoff-pending" ||
				(run.effectiveRoute === "executor" &&
					(run.phase === "active" || run.phase === "completed")))
		) {
			try {
				contextPressure.onExecutorStreamStarted(identity);
				if (run.phase === "handoff-pending") {
					application.activateExecutor();
					audit("executor-active", ctx);
				}
			} catch {
				fail("provider-drift", false, ctx, identity);
				await analytics.waitForWrites();
			}
		}
	});

	pi.on("message_end", async (event, ctx) => {
		const run = application.run;
		const correlation = hostCorrelation.observe(
			{ type: "message", message: event.message },
			identityOf(run),
		);
		if (
			correlation.decision === "ignore" ||
			!run ||
			event.message.role !== "assistant" ||
			event.message.stopReason === "aborted"
		)
			return;
		const identity = identityOf(run);
		if (
			event.message.provider === run.config.executor.provider &&
			event.message.model === run.config.executor.model
		) {
			if (event.message.stopReason === "error") {
				contextPressure.onExecutorStreamFailed(identity);
			} else {
				contextPressure.onExecutorStreamSucceeded(identity);
				if (run.phase === "active") {
					try {
						application.completeHandoff();
						audit("handoff-completed", ctx);
					} catch {
						fail("provider-drift", true, ctx, identity);
					}
				}
			}
		}
		if (!analytics.hasStateFor(run)) return;
		await analytics.recordUsage(
			"assistant",
			`message:${event.message.timestamp}:${event.message.provider}:${event.message.model}`,
			event.message.provider,
			event.message.model,
			analytics.usageRole(run, event.message.provider, event.message.model),
			event.message.usage,
			run,
		);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const correlation = hostCorrelation.observe(
			{ type: "agent-settled" },
			identityOf(application.run),
		);
		if (correlation.decision === "ignore") return;
		const run = application.run;
		if (!run) return;
		const runIdentity = identityOf(run);
		if (run.phase === "cancelled") return;
		const pressureObservation = contextPressure.settle(run, contextPressureHost(ctx));
		if (
			pressureObservation === "host-compacted" ||
			pressureObservation === "compaction-requested" ||
			pressureObservation === "compaction-pending"
		) {
			// ctx.compact() aborts the active Agent loop before its completion callback
			// runs. The pressure controller keeps this handoff alive until that
			// callback settles and owns the only checklist retry.
			await analytics.waitForWrites().catch(() => {
				ctx.ui.notify("Prewalk analytics finalization failed; retrying is safe.", "error");
			});
			return updateStatus(ctx);
		}
		const retrySettled =
			planningRetryStarted && planningRetry !== undefined && sameRunIdentity(planningRetry, run);
		if (
			planningNeedsCheckpoint(run) ||
			(retrySettled && plannerCanRecover(run) && turnGate.hasActionableTodo())
		) {
			clearPlanningRetry();
			queuePlanningRetry(ctx, "trigger-turn");
			return;
		}
		if (retrySettled) clearPlanningRetry();
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
		)
			return updateStatus(ctx);
		const action = application.requestContinuation(turnGate.hasActionableTodo());
		if (action.type === "send-continuation") {
			await sendPrompt(PREWALK_CONTINUE_MESSAGE_TYPE, ctx, true);
			if (!sameRunIdentity(runIdentity, application.run)) return;
			return;
		}
		const failedRun = run.phase === "failed";
		await getRuntimeController(ctx).restore(runIdentity);
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
			identityOf(application.run),
		);
		if (correlation.decision === "ignore") return;
		if (
			application.run?.config.blockPlannerDelegation === true &&
			(acceptsMutationEvidence(application.run) ||
				application.run.phase === "handoff-pending") &&
			blocksPlannerDelegation(event.toolName, event.input)
		) {
			return {
				block: true,
				reason:
					"Prewalk planning must stay in this session through the first successful code edit and executor handoff. Child edits cannot trigger the parent handoff. Discovery and stopping children remain available.",
			};
		}
	});

	pi.on("tool_execution_update", (event) => {
		const correlation = hostCorrelation.observe(
			{ type: "tool", toolCallId: event.toolCallId },
			identityOf(application.run),
		);
		if (correlation.decision === "ignore") return;
		if (!acceptsMutationEvidence(application.run)) return;
		turnGate.recordExecutionUpdate(event);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		const correlatedRun = identityOf(application.run);
		const correlation = hostCorrelation.observe(
			{ type: "tool-claim", toolCallId: event.toolCallId },
			correlatedRun,
		);
		if (correlation.decision === "ignore") return;
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
		const details = parseBoundaryValue(event.details);
		const run = application.run;
		const runIdentity = identityOf(application.run);
		const correlation = hostCorrelation.observe(
			{ type: "tool", toolCallId: event.toolCallId },
			runIdentity,
		);
		if (correlation.decision === "ignore") return;
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
			if (invocation) await recordDelegationProjection(invocation, details, event.isError);
			if (!sameCapturedRun(runIdentity, application.run)) return;
			delegation = delegationFromResult(
				details,
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
			details,
		});
	});

	pi.on("turn_end", async (event, ctx) => {
		const correlation = hostCorrelation.observe(
			{ type: "message", message: event.message },
			identityOf(application.run),
		);
		if (correlation.decision === "ignore") return;
		if (event.message.role === "assistant" && event.message.stopReason === "aborted") return;
		if (!verifyModelRuntimeOwnership(ctx)) return;
		refreshContextCompactionPolicy(ctx);
		const run = application.run;
		if (!run) return;
		const runIdentity = identityOf(run);
		if (contextPressure.hasPlannerPressure(run)) return updateStatus(ctx);
		if (acceptsMutationEvidence(run)) {
			const evidence = turnGate.finishTurn(event.message, {
				todoActive: run.todoActive,
				todoSeen: run.todoSeen,
				ignoreExtensions:
					run.config.handoff?.ignoreExtensions ?? DEFAULT_HANDOFF_CONFIG.ignoreExtensions,
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
		if (runIdentity !== undefined && sameRunIdentity(runIdentity, application.run)) {
			try {
				await ensureModelRuntime(ctx).sync();
			} catch {
				return;
			}
			if (!verifyModelRuntimeOwnership(ctx)) return;
		}
		const currentRun = application.run;
		if (
			sameRunIdentity(identityOf(run), currentRun) &&
			event.message.role === "assistant" &&
			!contextPressure.hasRetryPressure(run)
		) {
			const executor = ctx.modelRegistry.find(
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

	pi.on("context", (event, ctx) => {
		const run = application.run;
		if (run && ctx.model) {
			let tokens: number;
			try {
				tokens = estimateRequestTokens({
					systemPrompt: "",
					messages: convertToLlm([...event.messages]),
					tools: [],
				});
			} catch {
				tokens = Number.POSITIVE_INFINITY;
			}
			const pressure =
				tokens > Math.max(0, ctx.model.contextWindow - contextPressure.reserveTokens());
			const identity = identityOf(run);
			if (identity && pressure) {
				if (run.phase === "handoff-pending" || run.effectiveRoute === "executor") {
					contextPressure.onExecutorContextPressure(identity, true);
				} else if (run.effectiveRoute === "planner") {
					contextPressure.onPlannerContextPressure(identity);
				}
			} else if (identity && run.effectiveRoute === "planner") {
				contextPressure.onPlannerContextSafe(identity);
			}
			if (pressure && ctx.signal) ctx.abort();
		}
		return {
			messages: event.messages.filter((message) => shouldExposePrompt(message, application.run)),
		};
	});

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

	pi.on("session_before_tree", (_event, ctx) => {
		const run = application.run;
		if (!run || run.phase === "cancelled" || run.phase === "failed") return;
		ctx.ui.notify(
			"Prewalk blocks session-tree navigation while its run is active; cancel or release first.",
			"warning",
		);
		return { cancel: true };
	});

	pi.on("session_compact", async (event, ctx) => {
		const run = application.run;
		const correlation = hostCorrelation.observe({ type: "compaction" }, identityOf(run));
		if (correlation.decision === "ignore") return;
		await contextPressure.afterCompaction(run, contextPressureHost(ctx), event.willRetry);
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

	pi.on("session_compact_failed", (event, ctx) => {
		const run = application.run;
		const correlation = hostCorrelation.observe({ type: "compaction-failed" }, identityOf(run));
		if (correlation.decision === "ignore") return;
		contextPressure.compactionFailed(run, contextPressureHost(ctx), event.willRetry);
		updateStatus(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		if (event.source === "restore") return;
		if (
			event.source === "set" &&
			runtimeController?.consumeInternalModelSelect(event.model, event.source)
		)
			return;
		const run = application.run;
		if (!run && retainedCancelledRun) updateStatus(ctx);
		if (!run) return;
		if (run.phase === "cancelled") return updateStatus(ctx);
		const runIdentity = identityOf(run);
		await cancel(isPlannerSelected(event.model, run.planner), ctx);
		if (!sameRunIdentity(runIdentity, application.run)) return;
		application.reset();
		deactivatePrewalkTools();
		lastOutcome = undefined;
		updateStatus(ctx);
	});

	pi.on("thinking_level_select", (event, ctx) => {
		if (runtimeController?.consumeInternalThinkingLevel(event.level)) return;
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
