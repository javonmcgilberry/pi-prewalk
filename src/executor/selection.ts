import {
	type Api,
	clampThinkingLevel,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type {
	ExecutorConfig,
	PlannerProfile,
	PrewalkConfig,
} from "../orchestration/coordinator.js";
import { inferDefaultExecutorChain } from "./defaults.js";

/**
 * Registry access the chain needs, narrowed so resolution stays testable
 * without a live Pi model registry.
 */
export interface ExecutorProbe {
	find(provider: string, model: string): Model<Api> | undefined;
	hasAuth(model: Model<Api>): Promise<boolean>;
}

export type ExecutorRejection =
	| "not-registered"
	| "authorization-unavailable"
	| "output-capacity-unavailable"
	| "same-as-planner";

export interface RejectedExecutor {
	candidate: ExecutorConfig;
	reason: ExecutorRejection;
}

export type ExecutorChainResolution =
	| {
			ok: true;
			executor: ExecutorConfig;
			model: Model<Api>;
			/** Candidates rejected before the winner, in the order they were tried. */
			skipped: RejectedExecutor[];
	  }
	| { ok: false; rejected: RejectedExecutor[] };

export interface ExecutorSelectionRegistry {
	find(provider: string, model: string): Model<Api> | undefined;
	getAvailable(): readonly Model<Api>[];
	getApiKeyAndHeaders(model: Model<Api>): Promise<{ ok: boolean }>;
}

/**
 * Validates the selected planner and resolves the configured or inferred
 * executor chain. Keeping this sequence here prevents the Pi adapter from
 * coordinating planner auth, fallback inference, and candidate validation.
 */
export async function resolveConfiguredExecutor(
	plannerProfile: PlannerProfile,
	config: PrewalkConfig,
	selectedModel: Model<Api> | undefined,
	registry: ExecutorSelectionRegistry,
): Promise<ExecutorChainResolution> {
	const planner = registry.find(plannerProfile.provider, plannerProfile.model);
	if (
		!planner ||
		selectedModel?.provider !== plannerProfile.provider ||
		selectedModel.id !== plannerProfile.model
	) {
		throw new Error("model-unavailable");
	}
	if (planner.contextWindow <= 0 || planner.maxTokens <= 0) {
		throw new Error("model-unavailable");
	}
	const plannerAuth = await registry.getApiKeyAndHeaders(planner);
	if (!plannerAuth.ok) throw new Error("authorization-unavailable");
	const fallbackChain =
		config.executorFallbacks ??
		inferDefaultExecutorChain(
			planner.provider,
			registry.getAvailable(),
			config.executor.reasoning,
		);
	return resolveExecutorChain(
		planner,
		plannerProfile.reasoning,
		[config.executor, ...fallbackChain],
		{
			find: (provider, model) => registry.find(provider, model),
			hasAuth: async (target) => (await registry.getApiKeyAndHeaders(target)).ok,
		},
	);
}

/** Returns whether a target model/effort would be a no-op from the planner. */
export function isSameModelAtEffectiveReasoning(
	planner: Model<Api>,
	plannerReasoning: ModelThinkingLevel,
	target: Model<Api>,
	targetReasoning: ModelThinkingLevel,
): boolean {
	return (
		target.provider === planner.provider &&
		target.id === planner.id &&
		clampThinkingLevel(target, targetReasoning) === clampThinkingLevel(target, plannerReasoning)
	);
}

/**
 * Picks the first usable executor from an ordered chain.
 *
 * Oh My Pi resolves its hand-off target from a priority list so an unavailable
 * model degrades to the next one instead of stranding the session. This is the
 * same idea over an explicitly configured chain: every candidate is checked
 * against the live registry and the planner it would take over from, and the
 * first that clears every rule wins.
 */
export async function resolveExecutorChain(
	planner: Model<Api>,
	plannerReasoning: ModelThinkingLevel,
	candidates: readonly ExecutorConfig[],
	probe: ExecutorProbe,
): Promise<ExecutorChainResolution> {
	const rejected: RejectedExecutor[] = [];
	for (const candidate of candidates) {
		const outcome = await evaluate(planner, plannerReasoning, candidate, probe);
		if (outcome.viable) {
			return { ok: true, executor: candidate, model: outcome.model, skipped: rejected };
		}
		rejected.push({ candidate, reason: outcome.reason });
	}
	return { ok: false, rejected };
}

type CandidateOutcome =
	| { viable: true; model: Model<Api> }
	| { viable: false; reason: ExecutorRejection };

/**
 * Resolves a candidate exactly once and returns either the model that was
 * actually validated or the reason it was passed over. Looking the model up a
 * second time after the authorization await would let a registry change swap in
 * an unvalidated replacement.
 */
async function evaluate(
	planner: Model<Api>,
	plannerReasoning: ModelThinkingLevel,
	candidate: ExecutorConfig,
	probe: ExecutorProbe,
): Promise<CandidateOutcome> {
	const executor = probe.find(candidate.provider, candidate.model);
	if (!executor) return { viable: false, reason: "not-registered" };
	if (executor.maxTokens <= 0) return { viable: false, reason: "output-capacity-unavailable" };
	// Handing off to the running model at the same effective effort is a no-op
	// that still costs a planning nudge and a checklist. Pi clamps unsupported
	// levels before sending them, so compare the effective labels rather than
	// raw config values. A different effective effort is a real downgrade and
	// stays allowed.
	if (isSameModelAtEffectiveReasoning(planner, plannerReasoning, executor, candidate.reasoning)) {
		return { viable: false, reason: "same-as-planner" };
	}
	// A credential probe can reject outright, such as during a token refresh.
	// That is this candidate's problem, not the chain's, so it is recorded and
	// the next candidate still gets its turn.
	try {
		if (!(await probe.hasAuth(executor))) {
			return { viable: false, reason: "authorization-unavailable" };
		}
	} catch {
		return { viable: false, reason: "authorization-unavailable" };
	}
	return { viable: true, model: executor };
}
