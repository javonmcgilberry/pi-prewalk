import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	configForPlanner,
	parseConfig,
	rememberPlannerExecutor,
} from "../../src/config/prewalk-config.js";
import {
	type ExecutorProbe,
	resolveConfiguredExecutor,
	resolveExecutorChain,
} from "../../src/executor/selection.js";
import type { ExecutorConfig } from "../../src/orchestration/coordinator.js";

function model(provider: string, id: string, contextWindow = 272_000): Model<Api> {
	// SAFETY: This test constructs the value with the asserted shape before exercising the boundary.
	return {
		id,
		name: id,
		api: provider === "anthropic" ? "anthropic-messages" : "openai-responses",
		provider,
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 64_000,
	} as Model<Api>;
}

function candidate(provider: string, id: string): ExecutorConfig {
	return { provider, model: id, reasoning: "low" };
}

/** Registry stub: only the listed models exist, and all of them are authorized. */
function probe(available: Model<Api>[], unauthorized: string[] = []): ExecutorProbe {
	return {
		find: (provider, id) =>
			available.find((entry) => entry.provider === provider && entry.id === id),
		hasAuth: async (target) => !unauthorized.includes(`${target.provider}/${target.id}`),
	};
}

const planner = model("openai-codex", "gpt-5.6-sol");

describe("executor chain resolution", () => {
	it("takes the first candidate that is registered", async () => {
		const haiku = model("anthropic", "claude-haiku-4-5");
		const result = await resolveExecutorChain(
			planner,
			"high",
			[candidate("cerebras", "zai-glm-4.7"), candidate("anthropic", "claude-haiku-4-5")],
			probe([haiku]),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.executor).toEqual(candidate("anthropic", "claude-haiku-4-5"));
		expect(result.skipped).toEqual([
			{ candidate: candidate("cerebras", "zai-glm-4.7"), reason: "not-registered" },
		]);
	});

	it("skips a registered candidate whose credentials are missing", async () => {
		const haiku = model("anthropic", "claude-haiku-4-5");
		const mini = model("openai", "gpt-5-mini", 400_000);
		const result = await resolveExecutorChain(
			planner,
			"high",
			[candidate("anthropic", "claude-haiku-4-5"), candidate("openai", "gpt-5-mini")],
			probe([haiku, mini], ["anthropic/claude-haiku-4-5"]),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.executor).toEqual(candidate("openai", "gpt-5-mini"));
		expect(result.skipped).toEqual([
			{
				candidate: candidate("anthropic", "claude-haiku-4-5"),
				reason: "authorization-unavailable",
			},
		]);
	});

	it("accepts an executor smaller than the planner it takes over from", async () => {
		// The native session route now checks the exact request against this smaller
		// window and triggers stock Pi compaction before transport.
		const glm = model("cerebras", "zai-glm-4.7", 131_072);
		const flash = model("google", "gemini-3.5-flash", 1_048_576);
		const result = await resolveExecutorChain(
			planner,
			"high",
			[candidate("cerebras", "zai-glm-4.7"), candidate("google", "gemini-3.5-flash")],
			probe([glm, flash]),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.executor).toEqual(candidate("cerebras", "zai-glm-4.7"));
		expect(result.skipped).toEqual([]);
	});

	it("skips the planner's own model at the planner's own effort", async () => {
		const result = await resolveExecutorChain(
			planner,
			"low",
			[{ provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "low" }],
			probe([planner]),
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.rejected[0]?.reason).toBe("same-as-planner");
	});

	it("allows the planner's own model at a lower effort, which is a real downgrade", async () => {
		const result = await resolveExecutorChain(
			planner,
			"high",
			[{ provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "low" }],
			probe([planner]),
		);

		expect(result.ok).toBe(true);
	});

	it("rejects a same-model target that clamps back to the planner effort", async () => {
		// Pi clamps xhigh to high for this model because it has no xhigh mapping.
		// Comparing the raw labels would arm a no-op handoff and inject both nudges.
		const result = await resolveExecutorChain(
			planner,
			"high",
			[{ provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "xhigh" }],
			probe([planner]),
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.rejected).toEqual([
			{
				candidate: { provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "xhigh" },
				reason: "same-as-planner",
			},
		]);
	});

	it("keeps going when a credential probe rejects outright", async () => {
		// A token refresh can make the probe throw rather than answer false. That is
		// one candidate's problem, not the chain's.
		const haiku = model("anthropic", "claude-haiku-4-5");
		const mini = model("openai", "gpt-5-mini", 400_000);
		const result = await resolveExecutorChain(
			planner,
			"high",
			[candidate("anthropic", "claude-haiku-4-5"), candidate("openai", "gpt-5-mini")],
			{
				find: (provider, id) =>
					[haiku, mini].find((entry) => entry.provider === provider && entry.id === id),
				hasAuth: async (target) => {
					if (target.id === "claude-haiku-4-5") throw new Error("token refresh failed");
					return true;
				},
			},
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.executor).toEqual(candidate("openai", "gpt-5-mini"));
		expect(result.skipped[0]?.reason).toBe("authorization-unavailable");
	});

	it("returns the model it actually validated, not a later registry lookup", async () => {
		// A registry change during the authorization await must not swap in an
		// unvalidated replacement.
		const original = model("anthropic", "claude-haiku-4-5");
		const shrunk = model("anthropic", "claude-haiku-4-5", 1_000);
		let lookups = 0;
		const result = await resolveExecutorChain(
			planner,
			"high",
			[candidate("anthropic", "claude-haiku-4-5")],
			{
				find: () => {
					lookups += 1;
					return lookups === 1 ? original : shrunk;
				},
				hasAuth: async () => true,
			},
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.model).toBe(original);
		expect(lookups).toBe(1);
	});

	it("skips a candidate with no usable output capacity", async () => {
		const noOutput = { ...model("anthropic", "claude-haiku-4-5"), maxTokens: 0 };
		const result = await resolveExecutorChain(
			planner,
			"high",
			[candidate("anthropic", "claude-haiku-4-5")],
			probe([noOutput]),
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.rejected[0]?.reason).toBe("output-capacity-unavailable");
	});

	it("reports every rejection when no candidate survives", async () => {
		const result = await resolveExecutorChain(
			planner,
			"high",
			[candidate("anthropic", "claude-haiku-4-5"), candidate("google", "gemini-3.5-flash")],
			probe([]),
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.rejected).toEqual([
			{ candidate: candidate("anthropic", "claude-haiku-4-5"), reason: "not-registered" },
			{ candidate: candidate("google", "gemini-3.5-flash"), reason: "not-registered" },
		]);
	});
});

describe("planner-specific executors", () => {
	const opus = model("anthropic", "claude-opus-5-5");
	const haiku = model("anthropic", "claude-haiku-4-5");
	const luna = model("openai-codex", "gpt-5.6-luna");
	const config = parseConfig({
		executor: candidate("openai-codex", "gpt-5.6-luna"),
		executorFallbacks: [],
		plannerExecutors: {
			"anthropic/claude-opus-5-5": candidate("anthropic", "claude-haiku-4-5"),
		},
	});
	const registry = (available: Model<Api>[]) => ({
		find: (provider: string, id: string) =>
			available.find((entry) => entry.provider === provider && entry.id === id),
		getAvailable: () => available,
		getApiKeyAndHeaders: async () => ({ ok: true }),
	});

	it("routes each planner to the executor remembered for it", async () => {
		const all = [opus, haiku, luna, planner];
		const fromOpus = await resolveConfiguredExecutor(
			{ provider: "anthropic", model: "claude-opus-5-5", reasoning: "high" },
			config,
			opus,
			registry(all),
		);
		const fromSol = await resolveConfiguredExecutor(
			{ provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "high" },
			config,
			planner,
			registry(all),
		);

		expect(fromOpus.ok && fromOpus.executor.model).toBe("claude-haiku-4-5");
		expect(fromSol.ok && fromSol.executor.model).toBe("gpt-5.6-luna");
	});

	it("falls back to the default executor when the remembered one is unavailable", async () => {
		const result = await resolveConfiguredExecutor(
			{ provider: "anthropic", model: "claude-opus-5-5", reasoning: "high" },
			config,
			opus,
			registry([opus, luna]),
		);

		expect(result.ok && result.executor.model).toBe("gpt-5.6-luna");
	});

	it("saves configuration edits for the selected planner only", () => {
		const view = configForPlanner(config, opus);
		expect(view.executor.model).toBe("claude-haiku-4-5");

		const saved = rememberPlannerExecutor(
			{ ...view, executor: candidate("anthropic", "claude-sonnet-5") },
			config,
			opus,
		);
		expect(saved.executor).toEqual(config.executor);
		expect(saved.plannerExecutors).toEqual({
			"anthropic/claude-opus-5-5": candidate("anthropic", "claude-sonnet-5"),
		});
	});

	it("rejects a planner key that is not provider/model", () => {
		expect(() =>
			parseConfig({ ...config, plannerExecutors: { opus: candidate("anthropic", "x") } }),
		).toThrow(/provider\/model/);
	});
});
