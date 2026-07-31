import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EXECUTOR, DEFAULT_PLANNER, type PrewalkRun } from "../src/core.js";
import {
	EXECUTION_PROFILE_POLICY_REQUEST_EVENT,
	respondToExecutionProfilePolicyRequest,
} from "../src/execution-profile-policy.js";

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
		const respond = vi.fn();

		expect(
			respondToExecutionProfilePolicyRequest(
				{
					version: 1,
					requestId: "request",
					sessionId: "session",
					launchId: "launch",
					respond,
				},
				run(),
				"session",
			),
		).toBe(true);
		expect(EXECUTION_PROFILE_POLICY_REQUEST_EVENT).toBe(
			"pi-subagents:execution-profile-policy:request:v1",
		);
		expect(respond).toHaveBeenCalledWith("prewalk", {
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
				{
					provider: "openai-codex",
					model: "gpt-5.6-luna",
					reasoning: "low",
				},
			],
		});
	});

	it("fails closed when the configured executor is not below the planner", () => {
		const respond = vi.fn();

		respondToExecutionProfilePolicyRequest(
			{
				version: 1,
				requestId: "request",
				sessionId: "session",
				launchId: "launch",
				respond,
			},
			run("low", "low"),
			"session",
		);

		expect(respond).toHaveBeenCalledWith("prewalk", {
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

	it("does not answer after the epoch is cancelled", () => {
		const respond = vi.fn();
		const cancelled = run();
		cancelled.phase = "cancelled";

		expect(
			respondToExecutionProfilePolicyRequest(
				{
					version: 1,
					requestId: "request",
					sessionId: "session",
					launchId: "launch",
					respond,
				},
				cancelled,
				"session",
			),
		).toBe(false);
		expect(respond).not.toHaveBeenCalled();
	});
});
