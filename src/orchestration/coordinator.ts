import type { Api, Model, ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai";
import type { AnalyticsConfig } from "../analytics/index.js";

export const DEFAULT_PLANNER = {
	provider: "openai-codex",
	model: "gpt-5.6-sol",
};
export const DEFAULT_EXECUTOR = {
	provider: "openai-codex",
	model: "gpt-5.6-luna",
	reasoning: "low",
} satisfies ExecutorConfig;
export const PLANNER_PROVIDER = DEFAULT_PLANNER.provider;
export const PLANNER_MODEL_ID = DEFAULT_PLANNER.model;
export const EXECUTOR_PROVIDER = DEFAULT_EXECUTOR.provider;
export const EXECUTOR_MODEL_ID = DEFAULT_EXECUTOR.model;
export const EXECUTOR_THINKING_LEVEL = DEFAULT_EXECUTOR.reasoning;

export const PREWALK_PLAN_MESSAGE_TYPE = "prewalk-plan";
export const PREWALK_CONTINUE_MESSAGE_TYPE = "prewalk-continue";
export const PREWALK_CHECKLIST_MESSAGE_TYPE = "prewalk-checklist";

export interface PrewalkConfig {
	executor: ExecutorConfig;
	/**
	 * Alternates tried in order when the primary executor is unavailable, so a
	 * planner change or a lapsed credential degrades instead of stranding the run.
	 */
	executorFallbacks?: ExecutorConfig[];
	analytics?: AnalyticsConfig;
	experimentalChild?: ExperimentalChildConfig;
}

export type ParsedPrewalkConfig = PrewalkConfig & { analytics: AnalyticsConfig };

export interface ModelConfig {
	provider: string;
	model: string;
}

export interface ExecutorConfig extends ModelConfig {
	reasoning: ThinkingLevel;
}

export interface ExperimentalChildTarget {
	mode: "implementation" | "read-only" | "plan";
	executor: ExecutorConfig;
}

export interface ExperimentalChildConfig {
	enabled: boolean;
	agents: Record<string, ExperimentalChildTarget>;
}

export interface PlannerProfile extends ModelConfig {
	reasoning: ModelThinkingLevel;
}

export type RunMode = "automatic" | "manual";
export type RunPhase =
	| "armed"
	| "planning"
	| "ready"
	| "handoff-pending"
	| "active"
	| "completed"
	| "cancelled"
	| "failed";
export type EffectiveRoute = "planner" | "executor" | "selected";

export interface MutationTrigger {
	toolCallId: string;
	toolName: string;
}

export interface PrewalkRun {
	id: string;
	epoch: string;
	mode: RunMode;
	phase: RunPhase;
	effectiveRoute: EffectiveRoute;
	planner: PlannerProfile;
	config: PrewalkConfig;
	planningPromptInjected: boolean;
	continuePending: boolean;
	todoActive: boolean;
	todoSeen: boolean;
	trigger?: MutationTrigger;
	reasonCode?: string;
}

export interface TurnEvidence {
	todoSucceeded: boolean;
	mutation?: MutationTrigger;
}

export type CoordinatorAction =
	| { type: "none" }
	| { type: "send-planning" }
	| { type: "send-continuation" }
	| { type: "handoff"; trigger: MutationTrigger };

export const REASONING_LEVELS: readonly ThinkingLevel[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export function isReasoningLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && REASONING_LEVELS.some((level) => level === value);
}

export function isPlannerSelected(model: Model<Api> | undefined, planner: ModelConfig): boolean {
	return model?.provider === planner.provider && model.id === planner.model;
}

export function createPrewalkRun(
	id: string,
	epoch: string,
	mode: RunMode,
	todoActive: boolean,
	planner: PlannerProfile,
	config: PrewalkConfig,
): PrewalkRun {
	return {
		id,
		epoch,
		mode,
		phase: mode === "manual" ? "planning" : "armed",
		effectiveRoute: "planner",
		planner: structuredClone(planner),
		config: structuredClone(config),
		planningPromptInjected: mode === "manual",
		continuePending: false,
		todoActive,
		todoSeen: false,
	};
}
