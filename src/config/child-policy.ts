import type {
	ChildPrewalkPolicy,
	ExecutorConfig,
	PrewalkConfig,
} from "../orchestration/coordinator.js";

export const DEFAULT_CHILD_AGENT = "worker";

export const DEFAULT_CHILD_AGENTS = [
	{
		name: "scout",
		description: "Fast local codebase recon: relevant files, entry points, data flow, risks.",
	},
	{
		name: "researcher",
		description: "Web/docs research with sources and a concise research brief.",
	},
	{
		name: "worker",
		description:
			"Implementation work. Edits files, validates, escalates unapproved decisions instead of guessing.",
	},
	{
		name: "reviewer",
		description:
			"Code review and small fixes against the task/plan, tests, edge cases, and simplicity.",
	},
	{
		name: "oracle",
		description: "A second opinion before acting. Challenges assumptions without editing.",
	},
	{
		name: "delegate",
		description: "A lightweight general delegate that behaves close to the parent session.",
	},
] as const;

const DEFAULT_CHILD_AGENT_NAMES = DEFAULT_CHILD_AGENTS.map(({ name }) => name);
const DEFAULT_CHILD_AGENT_NAME_SET = new Set<string>(DEFAULT_CHILD_AGENT_NAMES);

export function childAgentNames(config: PrewalkConfig): string[] {
	const names = new Set([
		...DEFAULT_CHILD_AGENT_NAMES,
		...Object.keys(config.children?.agents ?? {}),
	]);
	return [
		...DEFAULT_CHILD_AGENT_NAMES,
		...[...names]
			.filter((name) => !DEFAULT_CHILD_AGENT_NAME_SET.has(name))
			.sort((left, right) => left.localeCompare(right)),
	];
}

export function childAgentDescription(agent: string): string {
	return (
		DEFAULT_CHILD_AGENTS.find((candidate) => candidate.name === agent)?.description ??
		"Launcher-owned child agent. Configure its independent Prewalk policy."
	);
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
