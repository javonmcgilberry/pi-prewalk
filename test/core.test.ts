import { describe, expect, it } from "vitest";
import {
	EXECUTOR_MODEL_ID,
	PLANNER_MODEL_ID,
	PrewalkCoordinator,
	parseConfig,
} from "../src/core.js";

describe("fixed phase-one config", () => {
	it("accepts enabled only", () => {
		expect(parseConfig({ enabled: true })).toEqual({ enabled: true });
		expect(PLANNER_MODEL_ID).toBe("gpt-5.6-sol");
		expect(EXECUTOR_MODEL_ID).toBe("gpt-5.6-luna");
	});

	it("rejects generic model configuration", () => {
		expect(() => parseConfig({ enabled: true, target: "other/model" })).toThrow(
			"Unknown Prewalk config field: target.",
		);
	});
});

describe("OMP coordinator behavior", () => {
	it("injects planning after the first automatic Sol turn", () => {
		const coordinator = new PrewalkCoordinator();
		expect(coordinator.arm("run", "epoch", "automatic", true)).toEqual({ type: "none" });
		expect(
			coordinator.onTurnEnd({
				hasToolResults: false,
				todoSucceeded: false,
			}),
		).toEqual({ type: "send-planning" });
		expect(coordinator.run?.phase).toBe("planning");
	});

	it("injects planning immediately for a manual arm", () => {
		const coordinator = new PrewalkCoordinator();
		expect(coordinator.arm("run", "epoch", "manual", true)).toEqual({
			type: "send-planning",
		});
	});

	it("waits for successful todo before accepting a mutation", () => {
		const coordinator = new PrewalkCoordinator();
		coordinator.arm("run", "epoch", "automatic", true);
		coordinator.onTurnEnd({ hasToolResults: false, todoSucceeded: false });

		expect(
			coordinator.onTurnEnd({
				hasToolResults: true,
				todoSucceeded: false,
				mutation: { toolCallId: "early", toolName: "write" },
			}),
		).toEqual({ type: "none" });

		coordinator.onTurnEnd({ hasToolResults: true, todoSucceeded: true });
		const action = coordinator.onTurnEnd({
			hasToolResults: true,
			todoSucceeded: false,
			mutation: { toolCallId: "ready", toolName: "edit" },
		});
		expect(action).toEqual({
			type: "handoff",
			trigger: { toolCallId: "ready", toolName: "edit" },
		});
	});

	it("bypasses todo when the tool is inactive", () => {
		const coordinator = new PrewalkCoordinator();
		coordinator.arm("run", "epoch", "automatic", false);
		expect(
			coordinator.onTurnEnd({
				hasToolResults: true,
				todoSucceeded: false,
				mutation: { toolCallId: "write", toolName: "write" },
			}),
		).toEqual({
			type: "handoff",
			trigger: { toolCallId: "write", toolName: "write" },
		});
	});

	it("bounds prose continuation and re-arms after tool progress", () => {
		const coordinator = new PrewalkCoordinator();
		coordinator.arm("run", "epoch", "automatic", true);
		expect(coordinator.onTurnEnd({ hasToolResults: false, todoSucceeded: false }).type).toBe(
			"send-planning",
		);
		expect(coordinator.onTurnEnd({ hasToolResults: false, todoSucceeded: false }).type).toBe(
			"send-continuation",
		);
		expect(coordinator.onTurnEnd({ hasToolResults: false, todoSucceeded: false }).type).toBe(
			"none",
		);
		coordinator.onTurnEnd({ hasToolResults: true, todoSucceeded: false });
		expect(coordinator.onTurnEnd({ hasToolResults: false, todoSucceeded: false }).type).toBe(
			"send-continuation",
		);
	});

	it("tracks Luna activation, completion, failure, and cancellation separately from selection", () => {
		const coordinator = new PrewalkCoordinator();
		coordinator.arm("run", "epoch", "automatic", false);
		coordinator.onTurnEnd({
			hasToolResults: true,
			todoSucceeded: false,
			mutation: { toolCallId: "write", toolName: "write" },
		});
		coordinator.activateLuna();
		expect(coordinator.run?.effectiveRoute).toBe("luna");
		coordinator.completeHandoff();
		expect(coordinator.run?.phase).toBe("completed");
		coordinator.fail("provider_stream_failed", true);
		expect(coordinator.run).toMatchObject({ phase: "failed", effectiveRoute: "luna" });
		coordinator.cancel(false);
		expect(coordinator.run).toMatchObject({ phase: "cancelled", effectiveRoute: "selected" });
	});

	it("restores an existing live epoch without re-arming", () => {
		const original = new PrewalkCoordinator();
		original.arm("run", "epoch", "automatic", true);
		original.onTurnEnd({ hasToolResults: false, todoSucceeded: false });
		const run = original.run;
		if (!run) throw new Error("Expected run");

		const restored = new PrewalkCoordinator();
		restored.restore(run);
		expect(restored.run).toEqual(run);
	});
});
