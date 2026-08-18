import {
	readFile as readFileAsync,
	rename as renameFile,
	writeFile as writeFileAsync,
} from "node:fs/promises";
import path from "node:path";
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	ANALYTICS_SCHEMA_VERSION,
	type AnalyticsConfig,
	DEFAULT_ANALYTICS_CONFIG,
	parseAnalyticsConfig,
} from "../analytics/index.js";
import { isSameModelAtEffectiveReasoning } from "../executor/selection.js";
import { isRecord } from "../guards.js";
import type {
	ChildPrewalkConfig,
	ChildPrewalkPolicy,
	ExecutorConfig,
	ExperimentalChildConfig,
	ExperimentalChildTarget,
	HandoffConfig,
	ModelConfig,
	PrewalkConfig,
} from "../orchestration/coordinator.js";
import { DEFAULT_EXECUTOR, DEFAULT_HANDOFF_CONFIG } from "../orchestration/coordinator.js";
import { showPrewalkConfigureMenu } from "./prewalk-dashboard.js";
import { selectPaged } from "./ui.js";

export function configPath(): string {
	return path.join(getAgentDir(), "prewalk.json");
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function readPrewalkConfig(): Promise<ParsedPrewalkConfig> {
	let raw: string;
	try {
		raw = await readFileAsync(configPath(), "utf8");
	} catch (error) {
		if (isMissingFile(error)) throw new Error("configuration-invalid");
		throw error;
	}
	try {
		return parseConfig(JSON.parse(raw));
	} catch {
		throw new Error("configuration-invalid");
	}
}

export async function writePrewalkConfig(config: PrewalkConfig): Promise<void> {
	const target = configPath();
	const temporary = `${target}.${process.pid}.tmp`;
	await writeFileAsync(temporary, `${JSON.stringify(config, undefined, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await renameFile(temporary, target);
}

export type ParsedPrewalkConfig = PrewalkConfig & {
	enabled: boolean;
	analytics: AnalyticsConfig;
};

const CONFIG_KEYS = new Set([
	"enabled",
	"executor",
	"executorFallbacks",
	"handoff",
	"analytics",
	"children",
	"experimentalChild",
]);
const HANDOFF_KEYS = new Set(["ignoreExtensions"]);
const EXECUTOR_KEYS = new Set(["provider", "model", "reasoning"]);
const CHILDREN_KEYS = new Set(["agents"]);
const CHILD_POLICY_KEYS = new Set(["executor"]);
const EXPERIMENTAL_CHILD_KEYS = new Set(["enabled", "agents"]);
const EXPERIMENTAL_CHILD_TARGET_KEYS = new Set(["mode", "executor"]);
const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
function isReasoningLevel(value: unknown): value is ExecutorConfig["reasoning"] {
	return typeof value === "string" && REASONING_LEVELS.some((level) => level === value);
}

export function parseConfig(value: unknown): ParsedPrewalkConfig {
	if (!isRecord(value)) {
		throw new Error("Prewalk config must be a JSON object.");
	}
	const unknownKeys = Object.keys(value).filter((key) => !CONFIG_KEYS.has(key));
	if (unknownKeys.length > 0) {
		throw new Error(`Unknown Prewalk config field: ${unknownKeys.join(", ")}.`);
	}
	if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
		throw new Error("Prewalk config enabled must be a boolean.");
	}
	const executor = parseExecutorConfig(value.executor, "executor");
	const executorFallbacks = parseExecutorFallbacks(value.executorFallbacks);
	const handoff = parseHandoffConfig(value.handoff);
	const analytics =
		value.analytics === undefined
			? structuredClone(DEFAULT_ANALYTICS_CONFIG)
			: parseAnalyticsConfig(value.analytics);
	if (value.children !== undefined && value.experimentalChild !== undefined) {
		throw new Error("Prewalk config cannot define both children and experimentalChild.");
	}
	let children: ChildPrewalkConfig | undefined;
	if (value.children !== undefined) {
		children = parseChildrenConfig(value.children);
	} else if (value.experimentalChild !== undefined) {
		children = normalizeExperimentalChildConfig(
			parseExperimentalChildConfig(value.experimentalChild),
		);
	}
	return {
		enabled: value.enabled ?? false,
		executor,
		...(executorFallbacks === undefined ? {} : { executorFallbacks }),
		handoff,
		analytics,
		...(children === undefined ? {} : { children }),
	};
}

function parseHandoffConfig(value: unknown): HandoffConfig {
	if (value === undefined) return structuredClone(DEFAULT_HANDOFF_CONFIG);
	if (!isRecord(value)) throw new Error("Prewalk config handoff must be a JSON object.");
	const unknownKeys = Object.keys(value).filter((key) => !HANDOFF_KEYS.has(key));
	if (unknownKeys.length > 0) {
		throw new Error(`Unknown Prewalk config handoff field: ${unknownKeys.join(", ")}.`);
	}
	if (!Array.isArray(value.ignoreExtensions)) {
		throw new Error("Prewalk config handoff.ignoreExtensions must be an array.");
	}
	const extensions = value.ignoreExtensions.map((extension) => {
		if (typeof extension !== "string" || !/^\.[a-z0-9_-]+$/i.test(extension)) {
			throw new Error(
				"Prewalk config handoff.ignoreExtensions entries must be file extensions such as .md.",
			);
		}
		return extension.toLowerCase();
	});
	return { ignoreExtensions: [...new Set(extensions)] };
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

function parseChildrenConfig(value: unknown): ChildPrewalkConfig {
	if (!isRecord(value)) throw new Error("Prewalk config children must be a JSON object.");
	const unknownKeys = Object.keys(value).filter((key) => !CHILDREN_KEYS.has(key));
	if (unknownKeys.length > 0) {
		throw new Error(`Unknown Prewalk config children field: ${unknownKeys.join(", ")}.`);
	}
	if (!isRecord(value.agents)) {
		throw new Error("Prewalk config children.agents must be an object.");
	}
	const agents: Record<string, ChildPrewalkPolicy> = {};
	for (const [agent, policy] of Object.entries(value.agents)) {
		if (!agent.trim()) throw new Error("Prewalk child agent names must be non-empty.");
		if (typeof policy === "boolean") {
			agents[agent] = policy;
			continue;
		}
		if (!isRecord(policy)) {
			throw new Error(
				`Prewalk config children.agents.${agent} must be true, false, or a custom executor object.`,
			);
		}
		const unknownKeys = Object.keys(policy).filter((key) => !CHILD_POLICY_KEYS.has(key));
		if (unknownKeys.length > 0) {
			throw new Error(
				`Unknown Prewalk config children.agents.${agent} field: ${unknownKeys.join(", ")}.`,
			);
		}
		agents[agent] = {
			executor: parseExecutorConfig(policy.executor, `children.agents.${agent}.executor`),
		};
	}
	return { agents };
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

function normalizeExperimentalChildConfig(value: ExperimentalChildConfig): ChildPrewalkConfig {
	const agents: Record<string, ChildPrewalkPolicy> = {};
	for (const [agent, target] of Object.entries(value.agents)) {
		agents[agent] =
			value.enabled && target.mode === "implementation" ? { executor: target.executor } : false;
	}
	return { agents };
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

export async function configurePrewalk(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/prewalk configure requires Pi's interactive UI.", "error");
		return;
	}
	const available = ctx.modelRegistry.getAvailable();
	const planner = ctx.model;
	if (!planner) {
		ctx.ui.notify("Select a planner model in Pi before configuring Prewalk.", "error");
		return;
	}
	let savedConfig: ParsedPrewalkConfig | undefined;
	try {
		savedConfig = await readPrewalkConfig();
	} catch {
		// A missing or broken file gets a safe default draft in the interactive
		// screen, so the user can repair settings without editing JSON by hand.
	}
	if (ctx.mode === "tui") {
		const result = await showPrewalkConfigureMenu({
			ctx,
			initial: savedConfig ?? {
				enabled: false,
				executor: { ...DEFAULT_EXECUTOR },
				handoff: structuredClone(DEFAULT_HANDOFF_CONFIG),
				analytics: structuredClone(DEFAULT_ANALYTICS_CONFIG),
			},
			models: ctx.modelRegistry.getAvailable(),
			planner,
			onSave: writePrewalkConfig,
		});
		ctx.ui.notify(
			result === "saved"
				? "Prewalk settings saved. Reload before using executor changes. Start a fresh session to apply automatic startup."
				: "No changes saved.",
			"info",
		);
		return;
	}
	// Any authorized model can execute, including one on another provider. The
	// planner's own provider is offered first because it is the least surprising
	// pairing, not because the others are unsupported.
	const executorCandidates = available
		// The planner's own model stays on the list: routing it at a lower effective
		// effort is a real downgrade, and only the same effective effort is a no-op.
		// The reasoning step below applies the model's clamping before rejecting that
		// pairing. A smaller executor is protected by the request-time context
		// watchdog in the provider overlay.
		.filter((model) => model.maxTokens > 0)
		.sort((left, right) => {
			const leftHome = left.provider === planner.provider ? 0 : 1;
			const rightHome = right.provider === planner.provider ? 0 : 1;
			if (leftHome !== rightHome) return leftHome - rightHome;
			return `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`);
		});
	if (executorCandidates.length === 0) {
		ctx.ui.notify("No authorized model can execute for that planner.", "error");
		return;
	}
	const executorChoices = executorCandidates.map((model) => `${model.provider}/${model.id}`);
	const executorChoice = await selectPaged(ctx, "Prewalk executor", executorChoices);
	if (!executorChoice) return;
	const executor = executorCandidates.find(
		(model) => `${model.provider}/${model.id}` === executorChoice,
	);
	if (!executor) {
		ctx.ui.notify("The selected executor is no longer available.", "error");
		return;
	}
	const savedReasoning =
		savedConfig?.executor.provider === executor.provider &&
		savedConfig.executor.model === executor.id
			? savedConfig.executor.reasoning
			: undefined;
	const preferredReasoning = savedReasoning ?? DEFAULT_EXECUTOR.reasoning;
	const reasoningChoices = [
		preferredReasoning,
		...REASONING_LEVELS.filter((level) => level !== preferredReasoning),
	];
	const reasoningChoice = await ctx.ui.select("Luna/executor reasoning", reasoningChoices);
	if (!isReasoningLevel(reasoningChoice)) return;
	// Mirrors the resolver's same-as-planner rule, so the wizard cannot save a
	// pairing that would immediately be rejected at arm time.
	if (
		isSameModelAtEffectiveReasoning(
			planner,
			ctx.thinkingLevel ?? "off",
			executor,
			reasoningChoice,
		)
	) {
		ctx.ui.notify(
			"That is the model already running at the same effective reasoning level, so there is nothing to hand off to. Pick a different model or a lower reasoning level.",
			"error",
		);
		return;
	}
	const automaticChoice = await ctx.ui.select("Automatic Prewalk for new sessions", [
		savedConfig?.enabled ? "enabled" : "disabled",
		savedConfig?.enabled ? "disabled" : "enabled",
	]);
	if (automaticChoice !== "enabled" && automaticChoice !== "disabled") return;
	const savedAnalytics = savedConfig?.analytics ?? DEFAULT_ANALYTICS_CONFIG;
	const collectionChoice = await ctx.ui.select("Analytics collection", [
		savedAnalytics.enabled ? "enabled" : "disabled",
		savedAnalytics.enabled ? "disabled" : "enabled",
	]);
	if (collectionChoice !== "enabled" && collectionChoice !== "disabled") return;
	const catalogChoice = await ctx.ui.select("Catalog fallback estimates", [
		savedAnalytics.catalogFallbackEnabled ? "enabled" : "disabled",
		savedAnalytics.catalogFallbackEnabled ? "disabled" : "enabled",
	]);
	if (catalogChoice !== "enabled" && catalogChoice !== "disabled") return;
	const nextConfig: PrewalkConfig = {
		enabled: automaticChoice === "enabled",
		executor: {
			provider: executor.provider,
			model: executor.id,
			reasoning: reasoningChoice,
		},
		analytics: {
			enabled: collectionChoice === "enabled",
			catalogFallbackEnabled: catalogChoice === "enabled",
			recentReceiptCount: savedAnalytics.recentReceiptCount,
			schemaVersion: ANALYTICS_SCHEMA_VERSION,
		},
		// The wizard only edits the primary executor. A hand-written fallback
		// chain survives it rather than being silently dropped.
		...(savedConfig?.executorFallbacks === undefined
			? {}
			: { executorFallbacks: savedConfig.executorFallbacks }),
		handoff: structuredClone(savedConfig?.handoff ?? DEFAULT_HANDOFF_CONFIG),
		...(savedConfig?.children === undefined ? {} : { children: savedConfig.children }),
	};
	const confirmed = await ctx.ui.confirm(
		"Save Prewalk configuration?",
		`${planner.provider}/${planner.id} plans, then ${executorChoice} executes at ${reasoningChoice} reasoning. Automatic startup: ${automaticChoice}.`,
	);
	if (!confirmed) return;
	await writePrewalkConfig(nextConfig);
	ctx.ui.notify("Prewalk configuration saved.", "info");
}
