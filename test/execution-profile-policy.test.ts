import { describe, expect, it } from "vitest";
import { DEFAULT_EXECUTOR, DEFAULT_PLANNER, type PrewalkRun } from "../src/core.js";
import { executionProfilePolicy } from "../src/execution-profile-policy.js";

function run(
	plannerReasoning: PrewalkRun["planner"]["reasoning"] = "high",
	executorReasoning: PrewalkRun["config"]["executor"]["reasoning"] = "low",
): PrewalkRun {
	return {
		id: "run",
		epoch: "epoch",
		mode: "automatic",
		phase: "active",
		effectiveRoute: "executor",
		planner: { ...DEFAULT_PLANNER, reasoning: plannerReasoning },
		config: {
			executor: { ...DEFAULT_EXECUTOR, reasoning: executorReasoning },
		},
		planningPromptInjected: true,
		continuePending: false,
		todoActive: true,
		todoSeen: true,
	};
}

describe("Prewalk execution-profile policy", () => {
	it("publishes a versioned executor default and exact cheaper allowlist", () => {
		expect(executionProfilePolicy(run())).toEqual({
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
					reasoning: "off",
				},
				{
					provider: "openai-codex",
					model: "gpt-5.6-luna",
					reasoning: "minimal",
				},
			],
		});
	});

	it("fails closed when the configured executor is not below the planner", () => {
		expect(executionProfilePolicy(run("low", "low"))).toEqual({
			version: 1,
			policyId: "epoch",
			epoch: "epoch",
			planner: {
				provider: "openai-codex",
				model: "gpt-5.6-sol",
				reasoning: "low",
			},
			status: "unavailable",
			reason: "executor-reasoning-not-lower-than-planner",
		});
	});

	it("does not expose policy after the epoch is cancelled", () => {
		const cancelled = run();
		cancelled.phase = "cancelled";

		expect(executionProfilePolicy(cancelled)).toBeUndefined();
	});
});
