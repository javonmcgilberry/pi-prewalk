import type {
	ChildPrewalkPolicy,
	ExecutorConfig,
	PrewalkConfig,
} from "../orchestration/coordinator.js";

export const DEFAULT_CHILD_AGENT = "worker";

export function childAgentNames(config: PrewalkConfig): string[] {
	const names = new Set([DEFAULT_CHILD_AGENT, ...Object.keys(config.children?.agents ?? {})]);
	return [
		DEFAULT_CHILD_AGENT,
		...[...names]
			.filter((name) => name !== DEFAULT_CHILD_AGENT)
			.sort((left, right) => left.localeCompare(right)),
	];
}

export function childPolicyFor(config: PrewalkConfig, agent: string): ChildPrewalkPolicy {
	return config.children?.agents[agent] ?? false;
}

export function withChildPolicy(
	config: PrewalkConfig,
	agent: string,
	policy: ChildPrewalkPolicy,
): PrewalkConfig {
	return {
		...structuredClone(config),
		children: {
			agents: {
				...(config.children?.agents ?? {}),
				[agent]: structuredClone(policy),
			},
		},
	};
}

export function executorLabel(executor: ExecutorConfig): string {
	return `${executor.provider}/${executor.model} · ${executor.reasoning}`;
}

export function childPolicyLabel(policy: ChildPrewalkPolicy, mainExecutor: ExecutorConfig): string {
	if (policy === false) return "Off";
	if (policy === true) return `On · uses ${executorLabel(mainExecutor)}`;
	return `On · custom ${executorLabel(policy.executor)}`;
}
