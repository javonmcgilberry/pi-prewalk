import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { PrewalkRun, RunPhase } from "../src/core.js";
import { compactStatus, detailedStatus } from "../src/status.js";

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
	const luna = phase === "active" || phase === "completed";
	return {
		id: "run-1",
		epoch: "epoch-1",
		mode: "automatic",
		phase,
		effectiveRoute: luna ? "luna" : "sol",
		planningPromptInjected: true,
		continuePending: false,
		todoActive: true,
		todoSeen: phase !== "armed" && phase !== "planning",
	};
}

describe("Prewalk status", () => {
	it.each([
		["armed", "prewalk: [5.6 Sol] / Luna"],
		["ready", "prewalk: [5.6 Sol] / Luna (ready)"],
		["active", "prewalk: 5.6 Sol / [Luna]"],
		["completed", "prewalk: 5.6 Sol / [Luna]"],
		["cancelled", "prewalk: [5.6 Sol] / Luna (cancelled)"],
		["failed", "prewalk: [5.6 Sol] / Luna (failed)"],
	] satisfies Array<[RunPhase, string]>)("renders %s", (phase, expected) => {
		expect(compactStatus(run(phase), selected())).toBe(expected);
	});

	it("shows the selected Pi model after cross-model cancellation", () => {
		expect(compactStatus(run("cancelled"), selected("gpt-5.4"))).toBe(
			"prewalk: 5.6 Sol / Luna (cancelled; Pi: openai-codex/gpt-5.4)",
		);
	});

	it("keeps Luna marked on a delegated failure", () => {
		const failed = run("failed");
		failed.effectiveRoute = "luna";
		failed.reasonCode = "luna-stream-failed";
		expect(compactStatus(failed, selected())).toBe("prewalk: 5.6 Sol / [Luna] (failed)");
		expect(detailedStatus(failed, selected())).toContain("reason=luna-stream-failed");
	});
});
