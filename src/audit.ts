import {
	type EffectiveRoute,
	EXECUTOR_MODEL_ID,
	EXECUTOR_PROVIDER,
	PLANNER_MODEL_ID,
	PLANNER_PROVIDER,
	type PrewalkRun,
	type RunMode,
	type RunPhase,
} from "./core.js";
import { isRecord } from "./guards.js";

export const PREWALK_AUDIT_TYPE = "prewalk-audit";
const PREWALK_AUDIT_VERSION = 1;
const OVERLAY_FINGERPRINT = "openai-codex:gpt-5.6-sol>gpt-5.6-luna:v1";

export type AuditEventKind =
	| "armed"
	| "plan-injected"
	| "continuation"
	| "progress"
	| "todo-ready"
	| "handoff-triggered"
	| "luna-active"
	| "handoff-completed"
	| "cancelled"
	| "failed";

export interface PrewalkAuditRecord {
	schemaVersion: 1;
	runId: string;
	epoch: string;
	event: AuditEventKind;
	phase: RunPhase;
	effectiveRoute: EffectiveRoute;
	mode: RunMode;
	planner: string;
	executor: string;
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
	"todo-ready",
	"handoff-triggered",
	"luna-active",
	"handoff-completed",
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
const ROUTES = new Set<string>(["sol", "luna", "selected"]);
const MODES = new Set<string>(["automatic", "manual"]);
const REASON_CODES = new Set([
	"configuration-invalid",
	"model-unavailable",
	"authorization-unavailable",
	"provider-unavailable",
	"provider-drift",
	"todo-conflict",
	"luna-stream-failed",
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

export function createAuditRecord(run: PrewalkRun, event: AuditEventKind): PrewalkAuditRecord {
	return {
		schemaVersion: PREWALK_AUDIT_VERSION,
		runId: run.id,
		epoch: run.epoch,
		event,
		phase: run.phase,
		effectiveRoute: run.effectiveRoute,
		mode: run.mode,
		planner: `${PLANNER_PROVIDER}/${PLANNER_MODEL_ID}`,
		executor: `${EXECUTOR_PROVIDER}/${EXECUTOR_MODEL_ID}`,
		overlay: OVERLAY_FINGERPRINT,
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
		value.planner !== `${PLANNER_PROVIDER}/${PLANNER_MODEL_ID}` ||
		value.executor !== `${EXECUTOR_PROVIDER}/${EXECUTOR_MODEL_ID}` ||
		value.overlay !== OVERLAY_FINGERPRINT ||
		typeof value.planningPromptInjected !== "boolean" ||
		typeof value.continuePending !== "boolean" ||
		typeof value.todoActive !== "boolean" ||
		typeof value.todoSeen !== "boolean"
	) {
		return undefined;
	}
	if (value.trigger !== undefined && !isTrigger(value.trigger)) return undefined;
	if (
		value.reasonCode !== undefined &&
		(typeof value.reasonCode !== "string" || !REASON_CODES.has(value.reasonCode))
	) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		runId: value.runId,
		epoch: value.epoch,
		event: value.event,
		phase: value.phase,
		effectiveRoute: value.effectiveRoute,
		mode: value.mode,
		planner: value.planner,
		executor: value.executor,
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
		planningPromptInjected: record.planningPromptInjected,
		continuePending: record.continuePending,
		todoActive: record.todoActive,
		todoSeen: record.todoSeen,
		...(record.trigger ? { trigger: { ...record.trigger } } : {}),
		...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
	};
}
