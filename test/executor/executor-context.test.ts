import type { Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	CONTEXT_ESTIMATE_SAFETY_MARGIN,
	CONTEXT_RESERVE_TOKENS,
	contextThreshold,
	estimateRequestTokens,
	needsContextCompaction,
} from "../../src/executor/context.js";

function executor(contextWindow = 100_000): Pick<Model<any>, "contextWindow"> {
	return { contextWindow };
}

describe("executor context watchdog", () => {
	it("uses stock Pi's default reserve", () => {
		expect(CONTEXT_RESERVE_TOKENS).toBe(16_384);
		expect(contextThreshold(executor())).toBe(83_616);
	});

	it("keeps a small provider-serialization margin on estimates", () => {
		expect(CONTEXT_ESTIMATE_SAFETY_MARGIN).toBe(384);
	});

	it("uses the effective Pi reserve instead of always using the stock default", () => {
		expect(contextThreshold(executor(), 32_768)).toBe(67_232);
		expect(needsContextCompaction(67_233, executor(), 32_768)).toBe(true);
	});

	it("compacts only after the executor threshold is crossed", () => {
		expect(needsContextCompaction(83_616, executor())).toBe(false);
		expect(needsContextCompaction(83_617, executor())).toBe(true);
	});

	it("fails closed for an invalid executor window", () => {
		expect(needsContextCompaction(1, executor(0))).toBe(true);
	});

	it("prefers the last assistant usage and adds trailing messages", () => {
		const context = {
			systemPrompt: "ignored because assistant usage already covers it",
			messages: [
				{ role: "user", content: "x".repeat(20_000), timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-test",
					usage: {
						input: 5_000,
						output: 100,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 5_100,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 2,
				},
				{ role: "user", content: "y".repeat(400), timestamp: 3 },
			],
		} as Context;

		expect(estimateRequestTokens(context)).toBe(5_584);
	});

	it("falls back to a conservative whole-request estimate without valid usage", () => {
		const context = {
			systemPrompt: "s".repeat(400),
			messages: [{ role: "user", content: "u".repeat(400), timestamp: 1 }],
		} as Context;

		expect(estimateRequestTokens(context)).toBe(584);
	});

	it("does not trust stale usage when the current prompt or tools grew", () => {
		const context = {
			systemPrompt: "s".repeat(40_000),
			tools: [
				{
					name: "new-tool",
					description: "d".repeat(40_000),
					parameters: { type: "object", properties: { value: { type: "string" } } },
				},
			],
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-test",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
			],
		} as Context;

		expect(estimateRequestTokens(context)).toBeGreaterThan(20_000);
	});
});
