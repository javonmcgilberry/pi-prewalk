import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_EXECUTOR,
	DEFAULT_PLANNER,
	type PrewalkRun,
	type RunPhase,
} from "../../src/orchestration/coordinator.js";
import { compactStatus, detailedStatus } from "../../src/ui/status.js";

function selected(id = "gpt-5.6-sol"): Model<"openai-codex-responses"> {
	return {
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function run(phase: RunPhase): PrewalkRun {
	const executor = phase === "active" || phase === "completed";
	return {
		id: "run-1",
		epoch: "epoch-1",
		mode: "automatic",
		phase,
		effectiveRoute: executor ? "executor" : "planner",
		planner: { ...DEFAULT_PLANNER, reasoning: "low" },
		config: {
			executor: { ...DEFAULT_EXECUTOR },
		},
		planningPromptInjected: true,
		continuePending: false,
		todoActive: true,
		todoSeen: phase !== "armed" && phase !== "planning",
	};
}

describe("Prewalk status", () => {
	it("separates auto readiness from the last task outcome", () => {
		expect(
			compactStatus(undefined, selected(), "low", undefined, {
				mode: "auto-ready",
				lastOutcome: "bypassed",
			}),
		).toBe("prewalk: auto-ready; last bypassed");
		expect(
			compactStatus(undefined, selected(), "low", undefined, {
				mode: "manual",
				lastOutcome: "completed",
			}),
		).toBe("prewalk: manual; last completed");
	});
	it.each([
		["armed", "prewalk: [5.6 Sol · low] / Luna · low"],
		[
			"ready",
			"prewalk: [5.6 Sol · low] / Luna · low (waiting for this agent's first code change)",
		],
		["handoff-pending", "prewalk: [5.6 Sol · low] / Luna · low (switching after this turn)"],
		["active", "prewalk: 5.6 Sol · low / [Luna · low]"],
		["completed", "prewalk: 5.6 Sol · low / [Luna · low]"],
		["cancelled", "prewalk: [5.6 Sol · low] / Luna · low (cancelled)"],
		["failed", "prewalk: [5.6 Sol · low] / Luna · low (failed)"],
	] satisfies Array<[RunPhase, string]>)("renders %s", (phase, expected) => {
		expect(compactStatus(run(phase), selected(), "low")).toBe(expected);
	});

	it("shows the selected Pi model after cross-model cancellation", () => {
		expect(compactStatus(run("cancelled"), selected("gpt-5.4"))).toBe(
			"prewalk: 5.6 Sol / Luna (cancelled; selected: openai-codex/gpt-5.4)",
		);
	});

	it("keeps Luna marked on a delegated failure", () => {
		const failed = run("failed");
		failed.effectiveRoute = "executor";
		failed.reasonCode = "executor-stream-failed";
		expect(compactStatus(failed, selected(), "low")).toBe(
			"prewalk: 5.6 Sol · low / [Luna · low] (failed: executor stream failed)",
		);
		expect(detailedStatus(failed, selected(), "low")).toContain("reason=executor-stream-failed");
	});

	it("shows the pre-handoff failure reason in the compact status", () => {
		const failed = run("failed");
		failed.reasonCode = "configuration-invalid";
		expect(compactStatus(failed, selected(), "low")).toBe(
			"prewalk: [5.6 Sol · low] / Luna · low (failed: configuration invalid)",
		);
	});

	it("keeps delegation details out of the compact footer", () => {
		expect(
			compactStatus(run("ready"), selected(), "low", {
				agent: "worker",
				state: "running",
			}),
		).toBe("prewalk: [5.6 Sol · low] / Luna · low (waiting for this agent's first code change)");

		const failed = run("failed");
		failed.reasonCode = "configuration-invalid";
		expect(
			compactStatus(failed, selected(), "low", {
				agent: "worker",
				state: "running",
			}),
		).toContain("failed: configuration invalid");
	});
});
