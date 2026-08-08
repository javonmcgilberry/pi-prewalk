import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExecutorConfig } from "./core.js";

/**
 * Oh My Pi's built-in `smol` preference order. These are preference patterns,
 * not an allowlist: only models actually present in Pi's registry can enter the
 * inferred chain, and user-supplied executor configs remain unrestricted.
 */
export const DEFAULT_EXECUTOR_PREFERENCE_PATTERNS = [
	"cerebras/zai-glm-4.7",
	"cerebras/zai-glm-4.6",
	"cerebras/zai-glm",
	"google-antigravity/gemini-3.1-flash-lite",
	"google-gemini-cli/gemini-3.1-flash-lite",
	"gemini-3.1-flash-lite",
	"gemini-3-1-flash-lite",
	"flash-lite",
	"google-antigravity/gemini-3.5-flash",
	"google-antigravity/gemini-3-flash",
	"google-gemini-cli/gemini-3.5-flash",
	"google-gemini-cli/gemini-3-flash",
	"gemini-3.5-flash",
	"gemini-3-5-flash",
	"gemini-3-flash",
	"haiku-4-5",
	"haiku-4.5",
	"haiku",
	"flash",
	"mini",
] as const;

/**
 * Infer a fallback chain from the live registry using the same preference
 * patterns as OMP. Models on the planner's provider are ranked ahead of
 * equally preferred foreign-provider matches; availability and authorization
 * are still checked later by `resolveExecutorChain`.
 */
export function inferDefaultExecutorChain(
	plannerProvider: string,
	available: readonly Model<Api>[],
	reasoning: ThinkingLevel,
): ExecutorConfig[] {
	const matches = new Map<string, { config: ExecutorConfig; rank: number }>();
	for (const [rank, pattern] of DEFAULT_EXECUTOR_PREFERENCE_PATTERNS.entries()) {
		const model = bestPatternMatch(pattern, plannerProvider, available);
		if (!model) continue;
		const key = `${model.provider}/${model.id}`;
		if (!matches.has(key)) {
			matches.set(key, {
				config: { provider: model.provider, model: model.id, reasoning },
				rank,
			});
		}
	}
	return [...matches.values()]
		.sort((left, right) => {
			const leftHome = left.config.provider === plannerProvider ? 0 : 1;
			const rightHome = right.config.provider === plannerProvider ? 0 : 1;
			return leftHome - rightHome || left.rank - right.rank;
		})
		.map(({ config }) => config);
}

function bestPatternMatch(
	pattern: string,
	plannerProvider: string,
	available: readonly Model<Api>[],
): Model<Api> | undefined {
	const normalized = pattern.toLowerCase();
	const exact = available.filter((model) => {
		const reference = `${model.provider}/${model.id}`.toLowerCase();
		return reference === normalized || model.id.toLowerCase() === normalized;
	});
	const candidates = exact.length
		? exact
		: available.filter((model) => model.id.toLowerCase().includes(normalized));
	return [...candidates].sort((left, right) => {
		const leftHome = left.provider === plannerProvider ? 0 : 1;
		const rightHome = right.provider === plannerProvider ? 0 : 1;
		return (
			leftHome - rightHome ||
			`${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`)
		);
	})[0];
}
