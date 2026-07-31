import type { ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai";
import type { PlannerProfile, PrewalkRun } from "./core.js";
import { isRecord } from "./guards.js";

export const EXECUTION_PROFILE_POLICY_VERSION = 1;
export const EXECUTION_PROFILE_POLICY_REQUEST_EVENT =
	"pi-subagents:execution-profile-policy:request:v1";

export interface ExecutionProfile {
	provider: string;
	model: string;
	reasoning: ThinkingLevel;
}

interface ExecutionProfilePolicyBase {
	version: 1;
	policyId: string;
	epoch: string;
	planner: PlannerProfile;
}

export type ExecutionProfilePolicy =
	| (ExecutionProfilePolicyBase & {
			status: "available";
			defaultProfile: ExecutionProfile;
			allowedProfiles: ExecutionProfile[];
	  })
	| (ExecutionProfilePolicyBase & {
			status: "unavailable";
			reason: "executor-matches-planner" | "executor-reasoning-not-lower-than-planner";
	  });

const REQUEST_FIELDS = new Set(["version", "requestId", "sessionId", "launchId", "respond"]);
const PLANNER_REASONING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
const EXECUTOR_REASONING_LEVELS: readonly ThinkingLevel[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

function safeIdentifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
}

function isActiveEpoch(run: PrewalkRun): boolean {
	return run.phase !== "cancelled" && run.phase !== "failed";
}

export function executionProfilePolicy(run: PrewalkRun): ExecutionProfilePolicy | undefined {
	if (!isActiveEpoch(run)) return undefined;
	const base: ExecutionProfilePolicyBase = {
		version: EXECUTION_PROFILE_POLICY_VERSION,
		policyId: run.epoch,
		epoch: run.epoch,
		planner: structuredClone(run.planner),
	};
	const executor = run.config.executor;
	if (
		executor.provider === run.planner.provider &&
		executor.model === run.planner.model &&
		executor.reasoning === run.planner.reasoning
	) {
		return { ...base, status: "unavailable", reason: "executor-matches-planner" };
	}
	const plannerRank = PLANNER_REASONING_LEVELS.indexOf(run.planner.reasoning);
	const executorRank = PLANNER_REASONING_LEVELS.indexOf(executor.reasoning);
	if (plannerRank < 1 || executorRank >= plannerRank) {
		return {
			...base,
			status: "unavailable",
			reason: "executor-reasoning-not-lower-than-planner",
		};
	}
	const allowedProfiles = EXECUTOR_REASONING_LEVELS.slice(0, executorRank).map(
		(reasoning): ExecutionProfile => ({
			provider: executor.provider,
			model: executor.model,
			reasoning,
		}),
	);
	return {
		...base,
		status: "available",
		defaultProfile: {
			provider: executor.provider,
			model: executor.model,
			reasoning: executor.reasoning,
		},
		allowedProfiles,
	};
}

export function respondToExecutionProfilePolicyRequest(
	value: unknown,
	run: PrewalkRun | undefined,
	sessionId: string,
): boolean {
	if (
		!run ||
		!isRecord(value) ||
		Object.keys(value).some((key) => !REQUEST_FIELDS.has(key)) ||
		value.version !== EXECUTION_PROFILE_POLICY_VERSION ||
		!safeIdentifier(value.requestId) ||
		!safeIdentifier(value.sessionId) ||
		value.sessionId !== sessionId ||
		!safeIdentifier(value.launchId) ||
		typeof value.respond !== "function"
	) {
		return false;
	}
	const policy = executionProfilePolicy(run);
	if (!policy) return false;
	value.respond("prewalk", policy);
	return true;
}
