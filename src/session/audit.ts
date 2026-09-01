import {
	type AnalyticsConfig,
	DEFAULT_ANALYTICS_CONFIG,
	parseAnalyticsConfig,
} from "../analytics/index.js";
import { type BoundaryValue, isBoolean, isNumber, isRecord, isString } from "../guards.js";
import {
	DEFAULT_PLANNER_RECOVERY_CONFIG,
	type EffectiveRoute,
	type ExecutorConfig,
	type ModelConfig,
	MUTATION_TOOLS_UNAVAILABLE_REASON,
	type PlannerProfile,
	type PlannerRecoveryConfig,
	type PrewalkRun,
	type RunMode,
	type RunPhase,
} from "../orchestration/coordinator.js";

export const PREWALK_AUDIT_TYPE = "prewalk-audit";
const PREWALK_AUDIT_VERSION = 4;
const LEGACY_PREWALK_AUDIT_VERSION = 2;
const PREVIOUS_PREWALK_AUDIT_VERSION = 3;

export type AuditEventKind =
	| "armed"
	| "plan-injected"
	| "planning-retry"
	| "planning-paused"
	| "continuation"
	| "progress"
	| "planner-reasoning-changed"
	| "todo-ready"
	| "handoff-triggered"
	| "executor-active"
	| "handoff-completed"
	| "completed"
	| "session-ended"
	| "manual-release"
	| "cancelled"
	| "failed";

export interface PrewalkAuditRecord {
	schemaVersion: typeof PREWALK_AUDIT_VERSION;
	runId: string;
	epoch: string;
	event: AuditEventKind;
	phase: RunPhase;
	effectiveRoute: EffectiveRoute;
	mode: RunMode;
	planner: PlannerProfile;
	executor: ExecutorConfig;
	plannerRecovery: PlannerRecoveryConfig;
	analytics?: AnalyticsConfig;
	overlay: string;
	planningPromptInjected: boolean;
	continuePending: boolean;
	todoActive: boolean;
	todoSeen: boolean;
	trigger?: PersistedMutationTrigger;
	reasonCode?: string;
}

const EVENTS = new Set<string>([
	"armed",
	"plan-injected",
	"planning-retry",
	"planning-paused",
	"continuation",
	"progress",
	"planner-reasoning-changed",
	"todo-ready",
	"handoff-triggered",
	"executor-active",
	"handoff-completed",
	"completed",
	"session-ended",
	"manual-release",
	"cancelled",
	"failed",
]);
const PHASES = new Set<string>([
	"armed",
	"planning",
	"ready",
	"handoff-pending",
	"active",
	"completed",
	"cancelled",
	"failed",
]);
const ROUTES = new Set<string>(["planner", "executor", "selected"]);
const MODES = new Set<string>(["automatic", "manual"]);
const REASON_CODES = new Set([
	"configuration-invalid",
	"model-unavailable",
	"authorization-unavailable",
	"provider-unavailable",
	"provider-drift",
	"todo-conflict",
	"planner-recovery-exhausted",
	"executor-stream-failed",
	"planner-compaction-failed",
	"executor-compaction-failed",
	"native-compaction-unsupported",
	MUTATION_TOOLS_UNAVAILABLE_REASON,
	"manual-release",
]);
const AUDIT_KEYS = new Set([
	"schemaVersion",
	"runId",
	"epoch",
	"event",
	"phase",
	"effectiveRoute",
	"mode",
	"planner",
	"executor",
	"plannerRecovery",
	"analytics",
	"overlay",
	"planningPromptInjected",
	"continuePending",
	"todoActive",
	"todoSeen",
	"trigger",
	"reasonCode",
]);
const TRIGGER_KEYS = new Set([
	"toolCallId",
	"toolName",
	"kind",
	"source",
	"cellId",
	"traceId",
	"sessionId",
]);
const MUTATION_KINDS = new Set(["edit", "write", "apply_patch"]);
const MUTATION_SOURCES = new Set([
	"builtin",
	"direct",
	"shell",
	"powershell",
	"exec_command",
	"code_mode",
	"adapter",
]);

function isMutationKind(value: BoundaryValue): value is PersistedMutationTrigger["kind"] {
	return isString(value) && MUTATION_KINDS.has(value);
}

function isMutationSource(value: BoundaryValue): value is PersistedMutationTrigger["source"] {
	return isString(value) && MUTATION_SOURCES.has(value);
}

/**
 * Persisted trigger provenance mirrors the mutation owner contract. `paths` is
 * deliberately excluded because it can contain repository-sensitive details.
 * The base fields remain sufficient for legacy audit records.
 */
export interface PersistedMutationTrigger {
	toolCallId: string;
	toolName: string;
	kind?: "edit" | "write" | "apply_patch";
	source?:
		| "builtin"
		| "direct"
		| "shell"
		| "powershell"
		| "exec_command"
		| "code_mode"
		| "adapter";
	cellId?: string;
	traceId?: string;
	sessionId?: number;
}

function isEvent(value: BoundaryValue): value is AuditEventKind {
	return isString(value) && EVENTS.has(value);
}

function isPhase(value: BoundaryValue): value is RunPhase {
	return isString(value) && PHASES.has(value);
}

function isRoute(value: BoundaryValue): value is EffectiveRoute {
	return isString(value) && ROUTES.has(value);
}

function isMode(value: BoundaryValue): value is RunMode {
	return isString(value) && MODES.has(value);
}

function parseTrigger(value: BoundaryValue): PersistedMutationTrigger | undefined {
	if (
		!isRecord(value) ||
		Object.keys(value).some((key) => !TRIGGER_KEYS.has(key)) ||
		!isString(value.toolCallId) ||
		!isString(value.toolName)
	) {
		return undefined;
	}
	if (
		(value.kind !== undefined && !isMutationKind(value.kind)) ||
		(value.source !== undefined && !isMutationSource(value.source)) ||
		(value.cellId !== undefined && !isString(value.cellId)) ||
		(value.traceId !== undefined && !isString(value.traceId)) ||
		(value.sessionId !== undefined &&
			(!isNumber(value.sessionId) || !Number.isSafeInteger(value.sessionId)))
	) {
		return undefined;
	}
	return copyTrigger({
		toolCallId: value.toolCallId,
		toolName: value.toolName,
		kind: isMutationKind(value.kind) ? value.kind : undefined,
		source: isMutationSource(value.source) ? value.source : undefined,
		cellId: isString(value.cellId) ? value.cellId : undefined,
		traceId: isString(value.traceId) ? value.traceId : undefined,
		sessionId: isNumber(value.sessionId) ? value.sessionId : undefined,
	});
}

function copyTrigger(value: {
	toolCallId: string;
	toolName: string;
	kind?: PersistedMutationTrigger["kind"];
	source?: PersistedMutationTrigger["source"];
	cellId?: string;
	traceId?: string;
	sessionId?: number;
}): PersistedMutationTrigger {
	const trigger: PersistedMutationTrigger = {
		toolCallId: value.toolCallId,
		toolName: value.toolName,
	};
	if (value.kind !== undefined) trigger.kind = value.kind;
	if (value.source !== undefined) trigger.source = value.source;
	if (value.cellId !== undefined) trigger.cellId = value.cellId;
	if (value.traceId !== undefined) trigger.traceId = value.traceId;
	if (value.sessionId !== undefined) trigger.sessionId = value.sessionId;
	return trigger;
}

function isPlannerProfile(value: BoundaryValue): value is PlannerProfile {
	return (
		isRecord(value) &&
		Object.keys(value).every(
			(key) => key === "provider" || key === "model" || key === "reasoning",
		) &&
		isString(value.provider) &&
		isString(value.model) &&
		isString(value.reasoning) &&
		["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.reasoning)
	);
}

function isExecutorConfig(value: BoundaryValue): value is ExecutorConfig {
	return (
		isRecord(value) &&
		Object.keys(value).every(
			(key) => key === "provider" || key === "model" || key === "reasoning",
		) &&
		isString(value.provider) &&
		isString(value.model) &&
		isString(value.reasoning) &&
		["minimal", "low", "medium", "high", "xhigh", "max"].includes(value.reasoning)
	);
}

function legacyOverlayFingerprint(planner: ModelConfig, executor: ExecutorConfig): string {
	return `${planner.provider}:${planner.model}>${executor.model}:${executor.reasoning}:v1`;
}

function overlayFingerprint(planner: ModelConfig, executor: ExecutorConfig): string {
	return `${planner.provider}:${planner.model}>${executor.provider}:${executor.model}:${executor.reasoning}:v2`;
}

function overlayMatchesVersion(
	version: BoundaryValue,
	planner: ModelConfig,
	executor: ExecutorConfig,
	overlay: BoundaryValue,
): boolean {
	if (version === LEGACY_PREWALK_AUDIT_VERSION) {
		return overlay === legacyOverlayFingerprint(planner, executor);
	}
	return (
		(version === PREVIOUS_PREWALK_AUDIT_VERSION || version === PREWALK_AUDIT_VERSION) &&
		overlay === overlayFingerprint(planner, executor)
	);
}

function parsePlannerRecoveryAudit(
	value: BoundaryValue,
	version: BoundaryValue,
): PlannerRecoveryConfig | undefined {
	if (value === undefined) {
		return version === PREWALK_AUDIT_VERSION
			? undefined
			: structuredClone(DEFAULT_PLANNER_RECOVERY_CONFIG);
	}
	if (
		!isRecord(value) ||
		Object.keys(value).some((key) => key !== "maxRetries") ||
		!Number.isSafeInteger(value.maxRetries) ||
		Number(value.maxRetries) <= 0
	) {
		return undefined;
	}
	return { maxRetries: Number(value.maxRetries) };
}

export function createAuditRecord(run: PrewalkRun, event: AuditEventKind): PrewalkAuditRecord {
	const record: PrewalkAuditRecord = {
		schemaVersion: PREWALK_AUDIT_VERSION,
		runId: run.id,
		epoch: run.epoch,
		event,
		phase: run.phase,
		effectiveRoute: run.effectiveRoute,
		mode: run.mode,
		planner: structuredClone(run.planner),
		executor: structuredClone(run.config.executor),
		plannerRecovery: structuredClone(
			run.config.plannerRecovery ?? DEFAULT_PLANNER_RECOVERY_CONFIG,
		),
		analytics: structuredClone(run.config.analytics ?? DEFAULT_ANALYTICS_CONFIG),
		overlay: overlayFingerprint(run.planner, run.config.executor),
		planningPromptInjected: run.planningPromptInjected,
		continuePending: run.continuePending,
		todoActive: run.todoActive,
		todoSeen: run.todoSeen,
	};
	if (run.trigger) record.trigger = copyTrigger(run.trigger);
	if (run.reasonCode) record.reasonCode = run.reasonCode;
	return record;
}

export function parseAuditRecord(value: BoundaryValue): PrewalkAuditRecord | undefined {
	if (
		!isRecord(value) ||
		Object.keys(value).some((key) => !AUDIT_KEYS.has(key)) ||
		(value.schemaVersion !== LEGACY_PREWALK_AUDIT_VERSION &&
			value.schemaVersion !== PREVIOUS_PREWALK_AUDIT_VERSION &&
			value.schemaVersion !== PREWALK_AUDIT_VERSION) ||
		!isString(value.runId) ||
		!isString(value.epoch) ||
		!isEvent(value.event) ||
		!isPhase(value.phase) ||
		!isRoute(value.effectiveRoute) ||
		!isMode(value.mode) ||
		!isPlannerProfile(value.planner) ||
		!isExecutorConfig(value.executor) ||
		!isBoolean(value.planningPromptInjected) ||
		!isBoolean(value.continuePending) ||
		!isBoolean(value.todoActive) ||
		!isBoolean(value.todoSeen)
	) {
		return undefined;
	}
	if (!overlayMatchesVersion(value.schemaVersion, value.planner, value.executor, value.overlay)) {
		return undefined;
	}
	const trigger = value.trigger === undefined ? undefined : parseTrigger(value.trigger);
	if (value.trigger !== undefined && !trigger) return undefined;
	const plannerRecovery = parsePlannerRecoveryAudit(value.plannerRecovery, value.schemaVersion);
	if (!plannerRecovery) return undefined;
	let analytics: AnalyticsConfig | undefined;
	if (value.analytics !== undefined) {
		try {
			analytics = parseAnalyticsConfig(value.analytics);
		} catch {
			return undefined;
		}
	}
	if (
		value.reasonCode !== undefined &&
		(!isString(value.reasonCode) || !REASON_CODES.has(value.reasonCode))
	) {
		return undefined;
	}
	const record: PrewalkAuditRecord = {
		schemaVersion: PREWALK_AUDIT_VERSION,
		runId: value.runId,
		epoch: value.epoch,
		event: value.event,
		phase: value.phase,
		effectiveRoute: value.effectiveRoute,
		mode: value.mode,
		planner: value.planner,
		executor: value.executor,
		plannerRecovery,
		overlay: overlayFingerprint(value.planner, value.executor),
		planningPromptInjected: value.planningPromptInjected,
		continuePending: value.continuePending,
		todoActive: value.todoActive,
		todoSeen: value.todoSeen,
	};
	if (analytics) record.analytics = analytics;
	if (trigger) record.trigger = trigger;
	if (value.reasonCode) record.reasonCode = value.reasonCode;
	return record;
}

export function runFromAudit(record: PrewalkAuditRecord): PrewalkRun {
	const config: PrewalkRun["config"] = {
		executor: structuredClone(record.executor),
		plannerRecovery: structuredClone(record.plannerRecovery),
	};
	if (record.analytics) config.analytics = structuredClone(record.analytics);
	const run: PrewalkRun = {
		id: record.runId,
		epoch: record.epoch,
		mode: record.mode,
		phase: record.phase,
		effectiveRoute: record.effectiveRoute,
		planner: structuredClone(record.planner),
		planningPromptInjected: record.planningPromptInjected,
		continuePending: record.continuePending,
		todoActive: record.todoActive,
		todoSeen: record.todoSeen,
		config,
	};
	if (record.trigger) run.trigger = copyTrigger(record.trigger);
	if (record.reasonCode) run.reasonCode = record.reasonCode;
	return run;
}
