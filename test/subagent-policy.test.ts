import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionProfilePolicy } from "../src/execution-profile-policy.js";
import {
	applyExecutionProfilePolicy,
	decodeExecutionProfilePolicy,
	encodeExecutionProfilePolicy,
	PREWALK_EXECUTION_PROFILE_POLICY_ENV,
} from "../src/subagent-policy.js";

const policy: ExecutionProfilePolicy = {
	version: 1,
	policyId: "epoch",
	epoch: "epoch",
	planner: {
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		reasoning: "high",
	},
	status: "available",
	defaultProfile: {
		provider: "openai-codex",
		model: "gpt-5.6-luna",
		reasoning: "low",
	},
	allowedProfiles: [
		{
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			reasoning: "minimal",
		},
	],
};

afterEach(() => {
	delete process.env[PREWALK_EXECUTION_PROFILE_POLICY_ENV];
});

describe("Prewalk-owned pi-subagents policy", () => {
	it("injects the executor profile into omitted single, parallel, and chain launches", () => {
		const single: Record<string, unknown> = { agent: "reviewer", task: "Review" };
		const parallel: Record<string, unknown> = {
			tasks: [
				{ agent: "reviewer", task: "Review" },
				{ agent: "tester", task: "Test", model: "openai-codex/gpt-5.6-luna:minimal" },
			],
		};
		const chain: Record<string, unknown> = {
			chain: [
				{ agent: "reviewer", task: "Review" },
				{
					parallel: [
						{ agent: "tester", task: "Test" },
						{ agent: "scout", task: "Inspect" },
					],
				},
			],
		};

		expect(applyExecutionProfilePolicy(single, policy)).toEqual({ ok: true });
		expect(applyExecutionProfilePolicy(parallel, policy)).toEqual({ ok: true });
		expect(applyExecutionProfilePolicy(chain, policy)).toEqual({ ok: true });

		expect(single).toMatchObject({
			model: "openai-codex/gpt-5.6-luna",
			thinking: "low",
		});
		expect(parallel).toEqual({
			tasks: [
				{
					agent: "reviewer",
					task: "Review",
					model: "openai-codex/gpt-5.6-luna:low",
				},
				{
					agent: "tester",
					task: "Test",
					model: "openai-codex/gpt-5.6-luna:minimal",
				},
			],
		});
		expect(chain).toEqual({
			chain: [
				{
					agent: "reviewer",
					task: "Review",
					model: "openai-codex/gpt-5.6-luna:low",
				},
				{
					parallel: [
						{
							agent: "tester",
							task: "Test",
							model: "openai-codex/gpt-5.6-luna:low",
						},
						{
							agent: "scout",
							task: "Inspect",
							model: "openai-codex/gpt-5.6-luna:low",
						},
					],
				},
			],
		});
	});

	it("rejects a forbidden planner override without partially mutating the launch", () => {
		const input: Record<string, unknown> = {
			tasks: [
				{ agent: "reviewer", task: "Review" },
				{
					agent: "tester",
					task: "Test",
					model: "openai-codex/gpt-5.6-sol:high",
				},
			],
		};
		const original = structuredClone(input);

		expect(applyExecutionProfilePolicy(input, policy)).toEqual({
			ok: false,
			reason:
				"Prewalk requires subagents to use openai-codex/gpt-5.6-luna at low reasoning or lower.",
		});
		expect(input).toEqual(original);
	});

	it("allows an explicit no-reasoning override below the executor default", () => {
		const input: Record<string, unknown> = {
			agent: "reviewer",
			task: "Review",
			thinking: false,
		};
		const offPolicy: ExecutionProfilePolicy = {
			...policy,
			allowedProfiles: [
				{
					provider: "openai-codex",
					model: "gpt-5.6-luna",
					reasoning: "off",
				},
				...policy.allowedProfiles,
			],
		};

		expect(applyExecutionProfilePolicy(input, offPolicy)).toEqual({ ok: true });
		expect(input).toMatchObject({
			model: "openai-codex/gpt-5.6-luna",
			thinking: "off",
		});
	});

	it("constrains appended chain steps and leaves read-only control actions unchanged", () => {
		const append: Record<string, unknown> = {
			action: "append-step",
			id: "run",
			chain: [{ agent: "reviewer", task: "Review the result" }],
		};
		const status: Record<string, unknown> = { action: "status", id: "run" };

		expect(applyExecutionProfilePolicy(append, policy)).toEqual({ ok: true });
		expect(append).toEqual({
			action: "append-step",
			id: "run",
			chain: [
				{
					agent: "reviewer",
					task: "Review the result",
					model: "openai-codex/gpt-5.6-luna:low",
				},
			],
		});
		expect(applyExecutionProfilePolicy(status, policy)).toEqual({ ok: true });
		expect(status).toEqual({ action: "status", id: "run" });
	});

	it("round-trips a strict inherited snapshot for nested child sessions", () => {
		const encoded = encodeExecutionProfilePolicy(policy);
		process.env[PREWALK_EXECUTION_PROFILE_POLICY_ENV] = encoded;

		expect(
			decodeExecutionProfilePolicy(process.env[PREWALK_EXECUTION_PROFILE_POLICY_ENV]),
		).toEqual(policy);
		expect(decodeExecutionProfilePolicy('{"version":2}')).toBeUndefined();
		expect(
			decodeExecutionProfilePolicy(
				JSON.stringify({
					...policy,
					unexpected: true,
				}),
			),
		).toBeUndefined();
		expect(
			decodeExecutionProfilePolicy(
				JSON.stringify({
					...policy,
					allowedProfiles: [
						{
							provider: "openai-codex",
							model: "gpt-5.6-sol",
							reasoning: "high",
						},
					],
				}),
			),
		).toBeUndefined();
		expect(
			decodeExecutionProfilePolicy(
				JSON.stringify({
					...policy,
					defaultProfile: {
						provider: "openai-codex",
						model: "gpt-5.6-luna",
						reasoning: "high",
					},
				}),
			),
		).toBeUndefined();
	});
});
