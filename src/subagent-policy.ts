import type { ExecutionProfile, ExecutionProfilePolicy } from "./execution-profile-policy.js";
import { isRecord } from "./guards.js";

export const PREWALK_EXECUTION_PROFILE_POLICY_ENV = "PI_PREWALK_EXECUTION_PROFILE_POLICY_V1";

type PolicyApplication = { ok: true } | { ok: false; reason: string };

const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const PROFILE_FIELDS = new Set(["provider", "model", "reasoning"]);
const AVAILABLE_POLICY_FIELDS = new Set([
	"version",
	"policyId",
	"epoch",
	"planner",
	"status",
	"defaultProfile",
	"allowedProfiles",
]);
const UNAVAILABLE_POLICY_FIELDS = new Set([
	"version",
	"policyId",
	"epoch",
	"planner",
	"status",
	"reason",
]);

function hasExactFields(value: Record<string, unknown>, fields: Set<string>): boolean {
	return (
		Object.keys(value).length === fields.size &&
		Object.keys(value).every((key) => fields.has(key))
	);
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function profile(value: unknown): value is ExecutionProfile {
	return (
		isRecord(value) &&
		hasExactFields(value, PROFILE_FIELDS) &&
		nonEmpty(value.provider) &&
		nonEmpty(value.model) &&
		typeof value.reasoning === "string" &&
		REASONING_LEVELS.includes(value.reasoning)
	);
}

function policy(value: unknown): value is ExecutionProfilePolicy {
	if (!isRecord(value)) return false;
	const planner = value.planner;
	if (
		value.version !== 1 ||
		!nonEmpty(value.policyId) ||
		!nonEmpty(value.epoch) ||
		value.policyId !== value.epoch ||
		!profile(planner) ||
		(value.status !== "available" && value.status !== "unavailable")
	) {
		return false;
	}
	if (value.status === "unavailable") {
		return (
			hasExactFields(value, UNAVAILABLE_POLICY_FIELDS) &&
			(value.reason === "executor-matches-planner" ||
				value.reason === "executor-reasoning-not-lower-than-planner")
		);
	}
	const defaultProfile = value.defaultProfile;
	const allowedProfiles = value.allowedProfiles;
	if (
		!hasExactFields(value, AVAILABLE_POLICY_FIELDS) ||
		!profile(defaultProfile) ||
		!Array.isArray(allowedProfiles) ||
		!allowedProfiles.every(profile)
	) {
		return false;
	}
	const plannerRank = REASONING_LEVELS.indexOf(planner.reasoning);
	const defaultRank = REASONING_LEVELS.indexOf(defaultProfile.reasoning);
	const allowedReasoning = new Set<string>();
	return (
		defaultRank < plannerRank &&
		allowedProfiles.every((candidate) => {
			if (
				candidate.provider !== defaultProfile.provider ||
				candidate.model !== defaultProfile.model ||
				REASONING_LEVELS.indexOf(candidate.reasoning) >= defaultRank ||
				allowedReasoning.has(candidate.reasoning)
			) {
				return false;
			}
			allowedReasoning.add(candidate.reasoning);
			return true;
		})
	);
}

export function encodeExecutionProfilePolicy(value: ExecutionProfilePolicy): string {
	return JSON.stringify(value);
}

export function decodeExecutionProfilePolicy(
	value: string | undefined,
): ExecutionProfilePolicy | undefined {
	if (!value) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return policy(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function splitModel(value: string): { model: string; reasoning?: string } {
	const separator = value.lastIndexOf(":");
	if (separator < 0) return { model: value };
	const reasoning = value.slice(separator + 1);
	if (!REASONING_LEVELS.includes(reasoning)) return { model: value };
	return { model: value.slice(0, separator), reasoning };
}

function allowedReasoning(value: ExecutionProfilePolicy & { status: "available" }): Set<string> {
	return new Set([
		value.defaultProfile.reasoning,
		...value.allowedProfiles.map((candidate) => candidate.reasoning),
	]);
}

function rejection(value: ExecutionProfilePolicy & { status: "available" }): PolicyApplication {
	return {
		ok: false,
		reason: `Prewalk requires subagents to use ${value.defaultProfile.provider}/${value.defaultProfile.model} at ${value.defaultProfile.reasoning} reasoning or lower.`,
	};
}

function resolveRequestedProfile(
	modelValue: unknown,
	thinkingValue: unknown,
	value: ExecutionProfilePolicy & { status: "available" },
): { model: string; reasoning: string } | undefined {
	const expectedModel = `${value.defaultProfile.provider}/${value.defaultProfile.model}`;
	const parsed = nonEmpty(modelValue) ? splitModel(modelValue) : { model: expectedModel };
	const reasoning =
		typeof thinkingValue === "string"
			? thinkingValue
			: thinkingValue === false
				? "off"
				: (parsed.reasoning ?? value.defaultProfile.reasoning);
	if (parsed.model !== expectedModel || !allowedReasoning(value).has(reasoning)) return undefined;
	return { model: expectedModel, reasoning };
}

function applyNestedProfile(
	value: Record<string, unknown>,
	policyValue: ExecutionProfilePolicy & { status: "available" },
): boolean {
	const resolved = resolveRequestedProfile(value.model, undefined, policyValue);
	if (!resolved) return false;
	value.model = `${resolved.model}:${resolved.reasoning}`;
	return true;
}

function applyParallel(
	value: unknown,
	policyValue: ExecutionProfilePolicy & { status: "available" },
): boolean {
	if (Array.isArray(value)) {
		return value.every((item) => isRecord(item) && applyNestedProfile(item, policyValue));
	}
	return isRecord(value) && applyNestedProfile(value, policyValue);
}

function applyCandidate(
	input: Record<string, unknown>,
	policyValue: ExecutionProfilePolicy & { status: "available" },
): boolean {
	if (Array.isArray(input.tasks)) {
		return input.tasks.every((item) => isRecord(item) && applyNestedProfile(item, policyValue));
	}
	if (Array.isArray(input.chain)) {
		for (const item of input.chain) {
			if (!isRecord(item)) return false;
			if (item.parallel !== undefined) {
				if (!applyParallel(item.parallel, policyValue)) return false;
				continue;
			}
			if (!applyNestedProfile(item, policyValue)) return false;
		}
		return true;
	}
	const resolved = resolveRequestedProfile(input.model, input.thinking, policyValue);
	if (!resolved) return false;
	input.model = resolved.model;
	input.thinking = resolved.reasoning;
	return true;
}

export function applyExecutionProfilePolicy(
	input: Record<string, unknown>,
	value: ExecutionProfilePolicy,
): PolicyApplication {
	if (value.status === "unavailable") {
		return {
			ok: false,
			reason: `Prewalk cannot launch a cheaper subagent profile: ${value.reason}.`,
		};
	}
	if (typeof input.action === "string" && input.action !== "append-step") return { ok: true };
	const candidate = structuredClone(input);
	if (!applyCandidate(candidate, value)) return rejection(value);
	Object.assign(input, candidate);
	return { ok: true };
}
