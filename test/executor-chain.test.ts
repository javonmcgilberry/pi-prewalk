import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ExecutorConfig } from "../src/core.js";
import { type ExecutorProbe, resolveExecutorChain } from "../src/executor-chain.js";

function model(provider: string, id: string, contextWindow = 272_000): Model<Api> {
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
		// The provider overlay now preflights the exact request against this smaller
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
