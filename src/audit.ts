import {
	type AnalyticsConfig,
	DEFAULT_ANALYTICS_CONFIG,
	parseAnalyticsConfig,
} from "./analytics.js";
import type {
	EffectiveRoute,
	ExecutorConfig,
	ModelConfig,
	PlannerProfile,
	PrewalkRun,
	RunMode,
	RunPhase,
} from "./core.js";
import { isRecord } from "./guards.js";

export const PREWALK_AUDIT_TYPE = "prewalk-audit";
export const PREWALK_AUTO_MODE_TYPE = "prewalk-auto-mode";
const PREWALK_AUDIT_VERSION = 2;
const PREWALK_AUTO_MODE_VERSION = 1;

export interface PrewalkAutoModeRecord {
	schemaVersion: 1;
	sessionId: string;
	enabled: boolean;
}

export type AuditEventKind =
	| "armed"
	| "plan-injected"
	| "continuation"
	| "progress"
	| "planner-reasoning-changed"
	| "todo-ready"
	| "handoff-triggered"
	| "executor-active"
	| "handoff-completed"
	| "manual-release"
	| "cancelled"
	| "failed";

export interface PrewalkAuditRecord {
	schemaVersion: 2;
	runId: string;
	epoch: string;
	event: AuditEventKind;
	phase: RunPhase;
	effectiveRoute: EffectiveRoute;
	mode: RunMode;
	planner: PlannerProfile;
	executor: ExecutorConfig;
	analytics?: AnalyticsConfig;
	overlay: string;
	planningPromptInjected: boolean;
	continuePending: boolean;
	todoActive: boolean;
	todoSeen: boolean;
	trigger?: {
		toolCallId: string;
		toolName: string;
	};
	reasonCode?: string;
}

const EVENTS = new Set<string>([
	"armed",
	"plan-injected",
	"continuation",
	"progress",
	"planner-reasoning-changed",
	"todo-ready",
	"handoff-triggered",
	"executor-active",
	"handoff-completed",
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
	"executor-stream-failed",
	"native-compaction-unsupported",
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
	"analytics",
	"overlay",
	"planningPromptInjected",
	"continuePending",
	"todoActive",
	"todoSeen",
	"trigger",
	"reasonCode",
]);

function isEvent(value: unknown): value is AuditEventKind {
	return typeof value === "string" && EVENTS.has(value);
}

function isPhase(value: unknown): value is RunPhase {
	return typeof value === "string" && PHASES.has(value);
}

function isRoute(value: unknown): value is EffectiveRoute {
	return typeof value === "string" && ROUTES.has(value);
}

function isMode(value: unknown): value is RunMode {
	return typeof value === "string" && MODES.has(value);
}

function isTrigger(value: unknown): value is { toolCallId: string; toolName: string } {
	return (
		isRecord(value) &&
		Object.keys(value).every((key) => key === "toolCallId" || key === "toolName") &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string"
	);
}

function isPlannerProfile(value: unknown): value is PlannerProfile {
	return (
		isRecord(value) &&
		Object.keys(value).every(
			(key) => key === "provider" || key === "model" || key === "reasoning",
		) &&
		typeof value.provider === "string" &&
		typeof value.model === "string" &&
		typeof value.reasoning === "string" &&
		["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.reasoning)
	);
}

function isExecutorConfig(value: unknown): value is ExecutorConfig {
	return (
		isRecord(value) &&
		Object.keys(value).every(
			(key) => key === "provider" || key === "model" || key === "reasoning",
		) &&
		typeof value.provider === "string" &&
		typeof value.model === "string" &&
		typeof value.reasoning === "string" &&
		["minimal", "low", "medium", "high", "xhigh", "max"].includes(value.reasoning)
	);
}

function overlayFingerprint(planner: ModelConfig, executor: ExecutorConfig): string {
	return `${planner.provider}:${planner.model}>${executor.model}:${executor.reasoning}:v1`;
}

export function createAuditRecord(run: PrewalkRun, event: AuditEventKind): PrewalkAuditRecord {
	return {
		schemaVersion: PREWALK_AUDIT_VERSION,
		runId: run.id,
		epoch: run.epoch,
		event,
		phase: run.phase,
		effectiveRoute: run.effectiveRoute,
		mode: run.mode,
		planner: structuredClone(run.planner),
		executor: structuredClone(run.config.executor),
		analytics: structuredClone(run.config.analytics ?? DEFAULT_ANALYTICS_CONFIG),
		overlay: overlayFingerprint(run.planner, run.config.executor),
		planningPromptInjected: run.planningPromptInjected,
		continuePending: run.continuePending,
		todoActive: run.todoActive,
		todoSeen: run.todoSeen,
		...(run.trigger
			? {
					trigger: {
						toolCallId: run.trigger.toolCallId,
						toolName: run.trigger.toolName,
					},
				}
			: {}),
		...(run.reasonCode ? { reasonCode: run.reasonCode } : {}),
	};
}

export function parseAuditRecord(value: unknown): PrewalkAuditRecord | undefined {
	if (
		!isRecord(value) ||
		Object.keys(value).some((key) => !AUDIT_KEYS.has(key)) ||
		value.schemaVersion !== PREWALK_AUDIT_VERSION ||
		typeof value.runId !== "string" ||
		typeof value.epoch !== "string" ||
		!isEvent(value.event) ||
		!isPhase(value.phase) ||
		!isRoute(value.effectiveRoute) ||
		!isMode(value.mode) ||
		!isPlannerProfile(value.planner) ||
		!isExecutorConfig(value.executor) ||
		value.planner.provider !== value.executor.provider ||
		value.overlay !== overlayFingerprint(value.planner, value.executor) ||
		typeof value.planningPromptInjected !== "boolean" ||
		typeof value.continuePending !== "boolean" ||
		typeof value.todoActive !== "boolean" ||
		typeof value.todoSeen !== "boolean"
	) {
		return undefined;
	}
	if (value.trigger !== undefined && !isTrigger(value.trigger)) return undefined;
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
		(typeof value.reasonCode !== "string" || !REASON_CODES.has(value.reasonCode))
	) {
		return undefined;
	}
	return {
		schemaVersion: 2,
		runId: value.runId,
		epoch: value.epoch,
		event: value.event,
		phase: value.phase,
		effectiveRoute: value.effectiveRoute,
		mode: value.mode,
		planner: value.planner,
		executor: value.executor,
		...(analytics ? { analytics } : {}),
		overlay: value.overlay,
		planningPromptInjected: value.planningPromptInjected,
		continuePending: value.continuePending,
		todoActive: value.todoActive,
		todoSeen: value.todoSeen,
		...(value.trigger ? { trigger: value.trigger } : {}),
		...(value.reasonCode ? { reasonCode: value.reasonCode } : {}),
	};
}

export function runFromAudit(record: PrewalkAuditRecord): PrewalkRun {
	return {
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
		config: {
			executor: structuredClone(record.executor),
			...(record.analytics ? { analytics: structuredClone(record.analytics) } : {}),
		},
		...(record.trigger ? { trigger: { ...record.trigger } } : {}),
		...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
	};
}

export function createAutoModeRecord(sessionId: string, enabled: boolean): PrewalkAutoModeRecord {
	return { schemaVersion: PREWALK_AUTO_MODE_VERSION, sessionId, enabled };
}

export function parseAutoModeRecord(value: unknown): PrewalkAutoModeRecord | undefined {
	if (
		!isRecord(value) ||
		Object.keys(value).some(
			(key) => key !== "schemaVersion" && key !== "sessionId" && key !== "enabled",
		) ||
		value.schemaVersion !== PREWALK_AUTO_MODE_VERSION ||
		typeof value.sessionId !== "string" ||
		value.sessionId.length === 0 ||
		typeof value.enabled !== "boolean"
	) {
		return undefined;
	}
	return { schemaVersion: 1, sessionId: value.sessionId, enabled: value.enabled };
}
