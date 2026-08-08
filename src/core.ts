import type { Api, Model, ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai";
import {
	type AnalyticsConfig,
	DEFAULT_ANALYTICS_CONFIG,
	parseAnalyticsConfig,
} from "./analytics.js";
import { isRecord } from "./guards.js";

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

const CONFIG_KEYS = new Set(["executor", "executorFallbacks", "analytics", "experimentalChild"]);
const EXECUTOR_KEYS = new Set(["provider", "model", "reasoning"]);
const EXPERIMENTAL_CHILD_KEYS = new Set(["enabled", "agents"]);
const EXPERIMENTAL_CHILD_TARGET_KEYS = new Set(["mode", "executor"]);
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

export function parseConfig(value: unknown): ParsedPrewalkConfig {
	if (!isRecord(value)) {
		throw new Error("Prewalk config must be a JSON object.");
	}
	const unknownKeys = Object.keys(value).filter((key) => !CONFIG_KEYS.has(key));
	if (unknownKeys.length > 0) {
		throw new Error(`Unknown Prewalk config field: ${unknownKeys.join(", ")}.`);
	}
	const executor = parseExecutorConfig(value.executor, "executor");
	const executorFallbacks = parseExecutorFallbacks(value.executorFallbacks);
	const analytics =
		value.analytics === undefined
			? structuredClone(DEFAULT_ANALYTICS_CONFIG)
			: parseAnalyticsConfig(value.analytics);
	return {
		executor,
		...(executorFallbacks === undefined ? {} : { executorFallbacks }),
		analytics,
		...(value.experimentalChild === undefined
			? {}
			: { experimentalChild: parseExperimentalChildConfig(value.experimentalChild) }),
	};
}

function parseExecutorConfig(value: unknown, name: string): ExecutorConfig {
	const model = parseModelConfig(value, name, EXECUTOR_KEYS);
	if (!isRecord(value) || !isReasoningLevel(value.reasoning)) {
		throw new Error(`Prewalk config ${name}.reasoning is invalid.`);
	}
	return { ...model, reasoning: value.reasoning };
}

function parseExecutorFallbacks(value: unknown): ExecutorConfig[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error("Prewalk config executorFallbacks must be an array.");
	}
	return value.map((entry, index) => parseExecutorConfig(entry, `executorFallbacks[${index}]`));
}

function parseExperimentalChildConfig(value: unknown): ExperimentalChildConfig {
	if (!isRecord(value)) throw new Error("Prewalk config experimentalChild must be a JSON object.");
	const unknownKeys = Object.keys(value).filter((key) => !EXPERIMENTAL_CHILD_KEYS.has(key));
	if (unknownKeys.length > 0) {
		throw new Error(`Unknown Prewalk config experimentalChild field: ${unknownKeys.join(", ")}.`);
	}
	if (typeof value.enabled !== "boolean") {
		throw new Error("Prewalk config experimentalChild.enabled must be a boolean.");
	}
	if (!isRecord(value.agents)) {
		throw new Error("Prewalk config experimentalChild.agents must be an object.");
	}
	const agents: Record<string, ExperimentalChildTarget> = {};
	for (const [agent, target] of Object.entries(value.agents)) {
		if (!agent.trim()) throw new Error("Prewalk child agent names must be non-empty.");
		if (!isRecord(target)) throw new Error(`Prewalk child target ${agent} must be an object.`);
		const targetUnknownKeys = Object.keys(target).filter(
			(key) => !EXPERIMENTAL_CHILD_TARGET_KEYS.has(key),
		);
		if (targetUnknownKeys.length > 0) {
			throw new Error(
				`Unknown Prewalk child target ${agent} field: ${targetUnknownKeys.join(", ")}.`,
			);
		}
		if (
			target.mode !== "implementation" &&
			target.mode !== "read-only" &&
			target.mode !== "plan"
		) {
			throw new Error(`Prewalk child target ${agent}.mode is invalid.`);
		}
		agents[agent] = {
			mode: target.mode,
			executor: parseExecutorConfig(
				target.executor,
				`experimentalChild.agents.${agent}.executor`,
			),
		};
	}
	return { enabled: value.enabled, agents };
}

function parseModelConfig(value: unknown, name: string, keys: ReadonlySet<string>): ModelConfig {
	if (!isRecord(value)) throw new Error(`Prewalk config ${name} must be a JSON object.`);
	const unknownKeys = Object.keys(value).filter((key) => !keys.has(key));
	if (unknownKeys.length > 0) {
		throw new Error(`Unknown Prewalk config ${name} field: ${unknownKeys.join(", ")}.`);
	}
	if (typeof value.provider !== "string" || value.provider.length === 0) {
		throw new Error(`Prewalk config ${name}.provider must be a non-empty string.`);
	}
	if (typeof value.model !== "string" || value.model.length === 0) {
		throw new Error(`Prewalk config ${name}.model must be a non-empty string.`);
	}
	return { provider: value.provider, model: value.model };
}

function createRun(
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

export class PrewalkCoordinator {
	#run: PrewalkRun | undefined;

	get run(): PrewalkRun | undefined {
		return this.#run;
	}

	arm(
		id: string,
		epoch: string,
		mode: RunMode,
		todoActive: boolean,
		planner: PlannerProfile,
		config: PrewalkConfig,
	): CoordinatorAction {
		if (this.#run && this.#run.phase !== "cancelled" && this.#run.phase !== "failed") {
			throw new Error("Prewalk is already active.");
		}
		this.#run = createRun(id, epoch, mode, todoActive, planner, config);
		return mode === "manual" ? { type: "send-planning" } : { type: "none" };
	}

	restore(run: PrewalkRun): void {
		this.#run = structuredClone(run);
	}

	reset(): void {
		this.#run = undefined;
	}

	onTurnEnd(evidence: TurnEvidence): CoordinatorAction {
		const run = this.#run;
		if (
			!run ||
			run.phase === "active" ||
			run.phase === "completed" ||
			run.phase === "cancelled" ||
			run.phase === "failed"
		) {
			return { type: "none" };
		}

		if (evidence.todoSucceeded) run.todoSeen = true;

		const gateOpen = run.todoSeen || !run.todoActive;
		if (gateOpen && evidence.mutation) {
			run.phase = "handoff-pending";
			run.trigger = evidence.mutation;
			return { type: "handoff", trigger: evidence.mutation };
		}

		if (!run.planningPromptInjected) {
			run.planningPromptInjected = true;
			run.phase = gateOpen ? "ready" : "planning";
			return { type: "send-planning" };
		}

		run.phase = gateOpen ? "ready" : "planning";
		return { type: "none" };
	}

	requestContinuation(actionableTodo: boolean): CoordinatorAction {
		const run = this.#run;
		if (
			!run ||
			(run.phase !== "planning" && run.phase !== "ready") ||
			!run.todoSeen ||
			!actionableTodo ||
			run.continuePending
		) {
			return { type: "none" };
		}
		run.continuePending = true;
		return { type: "send-continuation" };
	}

	activateExecutor(): void {
		const run = this.requiredRun();
		if (run.phase !== "handoff-pending") {
			throw new Error("Prewalk handoff is not pending.");
		}
		run.phase = "active";
		run.effectiveRoute = "executor";
	}

	completeHandoff(): void {
		const run = this.requiredRun();
		if (run.phase !== "active") {
			throw new Error("The Prewalk executor is not active.");
		}
		run.phase = "completed";
	}

	release(): void {
		const run = this.requiredRun();
		if (
			run.effectiveRoute !== "executor" ||
			(run.phase !== "active" && run.phase !== "completed")
		) {
			throw new Error("The Prewalk executor is not active.");
		}
		run.effectiveRoute = "planner";
	}

	cancel(selectedModelIsPlanner: boolean): void {
		const run = this.requiredRun();
		run.phase = "cancelled";
		run.effectiveRoute = selectedModelIsPlanner ? "planner" : "selected";
		run.continuePending = false;
	}

	fail(reasonCode: string, holdExecutorRoute: boolean): void {
		const run = this.requiredRun();
		run.phase = "failed";
		run.reasonCode = reasonCode;
		run.effectiveRoute = holdExecutorRoute ? "executor" : "planner";
		run.continuePending = false;
	}

	private requiredRun(): PrewalkRun {
		if (!this.#run) throw new Error("Prewalk is not active.");
		return this.#run;
	}
}
