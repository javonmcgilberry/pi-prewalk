import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_EXECUTOR_PREFERENCE_PATTERNS,
	inferDefaultExecutorChain,
} from "../src/default-executors.js";

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
	} as Model<Api>;
}

describe("inferred executor preferences", () => {
	it("tracks OMP's smol preference order", () => {
		expect(DEFAULT_EXECUTOR_PREFERENCE_PATTERNS[0]).toBe("cerebras/zai-glm-4.7");
		expect(DEFAULT_EXECUTOR_PREFERENCE_PATTERNS.at(-1)).toBe("mini");
	});

	it("selects available models by preference and ranks the planner provider first", () => {
		const result = inferDefaultExecutorChain(
			"anthropic",
			[
				model("openai", "gpt-5-mini"),
				model("anthropic", "claude-haiku-4-5"),
				model("cerebras", "zai-glm-4.7"),
			],
			"low",
		);

		expect(result).toEqual([
			{ provider: "anthropic", model: "claude-haiku-4-5", reasoning: "low" },
			{ provider: "cerebras", model: "zai-glm-4.7", reasoning: "low" },
			{ provider: "openai", model: "gpt-5-mini", reasoning: "low" },
		]);
	});

	it("uses fuzzy model patterns without treating the list as an allowlist", () => {
		expect(
			inferDefaultExecutorChain("custom", [model("custom", "my-flash-compatible")], "minimal"),
		).toEqual([{ provider: "custom", model: "my-flash-compatible", reasoning: "minimal" }]);
	});

	it("returns no inferred candidates when the registry has no matching models", () => {
		expect(inferDefaultExecutorChain("openai", [model("openai", "gpt-5.6-sol")], "low")).toEqual(
			[],
		);
	});
});
