export const DELEGATION_ANALYTICS_VERSION = 1;
export const SUBAGENT_DELEGATION_ANALYTICS_START_EVENT = "subagent:delegation-analytics:start";
export const SUBAGENT_DELEGATION_ANALYTICS_PROGRESS_EVENT =
	"subagent:delegation-analytics:progress";
export const SUBAGENT_DELEGATION_ANALYTICS_TERMINAL_EVENT =
	"subagent:delegation-analytics:terminal";
export const SUBAGENT_DELEGATION_ANALYTICS_REPLAY_REQUEST_EVENT =
	"subagent:delegation-analytics:replay-request";
type DelegationAnalyticsPhase = "start" | "progress" | "terminal";
type DelegationAnalyticsLifecycle =
	| "running"
	| "completed"
	| "failed"
	| "interrupted"
	| "timed-out"
	| "stopped"
	| "incomplete";
type DelegationAnalyticsEvent = DelegationEvidence;

import type { DelegationEvidence, DelegationLifecycle, DelegationUsageSlice } from "./analytics.js";
import { isRecord } from "./guards.js";

const LIFECYCLES: readonly DelegationAnalyticsLifecycle[] = [
	"running",
	"completed",
	"failed",
	"interrupted",
	"timed-out",
	"stopped",
	"incomplete",
];
const PHASES: readonly DelegationAnalyticsPhase[] = ["start", "progress", "terminal"];
const EVENT_KEYS = new Set([
	"version",
	"eventId",
	"phase",
	"rootSessionId",
	"parentSessionId",
	"invocationId",
	"delegationRunId",
	"childIndex",
	"childSessionId",
	"lifecycle",
	"observedAt",
	"usage",
	"replay",
]);
const USAGE_KEYS = new Set([
	"evidenceKey",
	"category",
	"inputTokens",
	"outputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"totalTokens",
	"turns",
	"costUsd",
]);

function safeId(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) {
		throw new Error(`${label} must be a content-free identifier.`);
	}
	return value;
}
function integer(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label} must be a non-negative integer.`);
	}
	return value;
}
function finite(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`${label} must be finite and non-negative.`);
	}
	return value;
}
function exact(record: Record<string, unknown>, keys: Set<string>, label: string): void {
	const extras = Object.keys(record).filter((key) => !keys.has(key));
	if (extras.length > 0)
		throw new Error(`${label} contains unsupported fields: ${extras.join(", ")}`);
}
function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
	const found = values.find((candidate) => candidate === value);
	if (typeof value !== "string" || found === undefined)
		throw new Error(`${label} is unsupported.`);
	return found;
}

export function parseDelegationAnalyticsEvent(value: unknown): DelegationEvidence {
	if (!isRecord(value)) throw new Error("Delegation analytics event must be an object.");
	exact(value, EVENT_KEYS, "Delegation analytics event");
	if (value.version !== DELEGATION_ANALYTICS_VERSION)
		throw new Error("Unsupported delegation analytics version.");
	const phase = enumValue(value.phase, PHASES, "Delegation analytics phase");
	const lifecycle = enumValue(value.lifecycle, LIFECYCLES, "Delegation analytics lifecycle");
	if (!Array.isArray(value.usage)) throw new Error("Delegation analytics usage is invalid.");
	const usage = value.usage.map((item): DelegationUsageSlice => {
		if (!isRecord(item)) throw new Error("Delegation analytics usage must be an object.");
		exact(item, USAGE_KEYS, "Delegation analytics usage");
		if (item.category !== "child")
			throw new Error("Delegation analytics usage category is unsupported.");
		const inputTokens = integer(item.inputTokens, "inputTokens");
		const outputTokens = integer(item.outputTokens, "outputTokens");
		const cacheReadTokens = integer(item.cacheReadTokens, "cacheReadTokens");
		const cacheWriteTokens = integer(item.cacheWriteTokens, "cacheWriteTokens");
		const totalTokens = integer(item.totalTokens, "totalTokens");
		if (totalTokens !== inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens)
			throw new Error("Delegation usage totalTokens does not reconcile.");
		return {
			evidenceKey: safeId(item.evidenceKey, "evidenceKey"),
			category: "child",
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			totalTokens,
			turns: integer(item.turns, "turns"),
			costUsd: finite(item.costUsd, "costUsd"),
		};
	});
	return {
		schemaVersion: DELEGATION_ANALYTICS_VERSION,
		eventId: safeId(value.eventId, "eventId"),
		phase,
		lifecycle,
		rootSessionId: safeId(value.rootSessionId, "rootSessionId"),
		parentSessionId: safeId(value.parentSessionId, "parentSessionId"),
		invocationId: safeId(value.invocationId, "invocationId"),
		delegationRunId: safeId(value.delegationRunId, "delegationRunId"),
		childIndex: integer(value.childIndex, "childIndex"),
		...(value.childSessionId === undefined
			? {}
			: { childSessionId: safeId(value.childSessionId, "childSessionId") }),
		observedAt: integer(value.observedAt, "observedAt"),
		usage,
	};
}

export function delegationEvidenceKey(
	evidence: Pick<
		DelegationEvidence,
		"rootSessionId" | "parentSessionId" | "invocationId" | "delegationRunId" | "childIndex"
	>,
): string {
	return `${evidence.rootSessionId}:${evidence.parentSessionId}:${evidence.invocationId}:${evidence.delegationRunId}:${evidence.childIndex}`;
}

export function mergeDelegationEvidence(
	records: Map<string, DelegationEvidence>,
	evidence: DelegationEvidence,
): boolean {
	const key = delegationEvidenceKey(evidence);
	const previous = records.get(key);
	const rank = (phase: DelegationAnalyticsPhase): number =>
		phase === "start" ? 0 : phase === "progress" ? 1 : 2;
	if (previous) {
		if (rank(previous.phase) > rank(evidence.phase) || previous.eventId === evidence.eventId)
			return false;
		if (previous.childSessionId && previous.childSessionId !== evidence.childSessionId)
			return false;
		if (rank(previous.phase) === rank(evidence.phase)) {
			const previousUsage = new Set(previous.usage.map((slice) => slice.evidenceKey));
			if (
				previous.usage.length > evidence.usage.length ||
				evidence.usage.some(
					(slice) =>
						previousUsage.has(slice.evidenceKey) &&
						!previous.usage.some(
							(previousSlice) =>
								previousSlice.evidenceKey === slice.evidenceKey &&
								JSON.stringify(previousSlice) === JSON.stringify(slice),
						),
				) ||
				previous.usage.some(
					(slice) =>
						!evidence.usage.some((candidate) => candidate.evidenceKey === slice.evidenceKey),
				)
			)
				return false;
			if (
				previous.lifecycle !== "running" &&
				previous.lifecycle !== "incomplete" &&
				previous.lifecycle !== evidence.lifecycle
			)
				return false;
			if (previous.lifecycle !== "running" && evidence.lifecycle === "running") return false;
		}
	}
	records.set(key, evidence);
	return true;
}

export function delegationEventChannel(phase: DelegationAnalyticsPhase): string {
	return phase === "start"
		? SUBAGENT_DELEGATION_ANALYTICS_START_EVENT
		: phase === "progress"
			? SUBAGENT_DELEGATION_ANALYTICS_PROGRESS_EVENT
			: SUBAGENT_DELEGATION_ANALYTICS_TERMINAL_EVENT;
}

export function isTerminalDelegation(evidence: DelegationEvidence): boolean {
	return evidence.phase === "terminal" && evidence.lifecycle !== "running";
}

export type DelegationAnalyticsProtocol = DelegationAnalyticsEvent;
export type DelegationAnalyticsLifecycleValue = DelegationLifecycle;
