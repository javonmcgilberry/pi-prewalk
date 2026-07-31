import type { ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai";
import type { PlannerProfile, PrewalkRun } from "./core.js";

export const EXECUTION_PROFILE_POLICY_VERSION = 1;

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
