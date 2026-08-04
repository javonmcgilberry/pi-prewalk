import { describe, expect, it } from "vitest";
import { DEFAULT_ANALYTICS_CONFIG } from "../src/analytics.js";
import {
	DEFAULT_EXECUTOR,
	DEFAULT_PLANNER,
	EXECUTOR_MODEL_ID,
	PLANNER_MODEL_ID,
	PrewalkCoordinator,
	parseConfig,
} from "../src/core.js";

const config = {
	executor: { ...DEFAULT_EXECUTOR },
};
const planner = { ...DEFAULT_PLANNER, reasoning: "high" as const };

describe("provider-neutral configuration", () => {
	it("stores executor and analytics settings and rejects persisted activation", () => {
		expect(parseConfig(config)).toEqual({
			...config,
			analytics: DEFAULT_ANALYTICS_CONFIG,
		});
		expect(() => parseConfig({ ...config, planner: DEFAULT_PLANNER })).toThrow(
			"Unknown Prewalk config field: planner.",
		);
		expect(() => parseConfig({ ...config, enabled: true })).toThrow(
			"Unknown Prewalk config field: enabled.",
		);
		expect(PLANNER_MODEL_ID).toBe("gpt-5.6-sol");
		expect(EXECUTOR_MODEL_ID).toBe("gpt-5.6-luna");
	});

	it("accepts explicitly disabled analytics", () => {
		expect(
			parseConfig({
				...config,
				analytics: { ...DEFAULT_ANALYTICS_CONFIG, enabled: false },
			}),
		).toMatchObject({ analytics: { enabled: false, catalogFallbackEnabled: false } });
	});

	it("rejects invalid analytics with an actionable error", () => {
		expect(() =>
			parseConfig({
				...config,
				analytics: { ...DEFAULT_ANALYTICS_CONFIG, recentReceiptCount: 0 },
			}),
		).toThrow("recentReceiptCount must be greater than zero");
	});

	it("parses explicit disabled child targets and rejects ambiguous child configuration", () => {
		expect(
			parseConfig({
				...config,
				experimentalChild: {
					enabled: false,
					agents: {
						worker: { mode: "implementation", executor: DEFAULT_EXECUTOR },
					},
				},
			}),
		).toMatchObject({
			experimentalChild: {
				enabled: false,
				agents: { worker: { mode: "implementation", executor: DEFAULT_EXECUTOR } },
			},
		});
		expect(() =>
			parseConfig({
				...config,
				experimentalChild: {
					enabled: true,
					agents: { worker: { mode: "automatic", executor: DEFAULT_EXECUTOR } },
				},
			}),
		).toThrow("worker.mode is invalid");
	});

	it("rejects unknown configuration", () => {
		expect(() => parseConfig({ executor: DEFAULT_EXECUTOR, target: "other/model" })).toThrow(
			"Unknown Prewalk config field: target.",
		);
	});
});

describe("OMP coordinator behavior", () => {
	it("injects planning after the first automatic Sol turn", () => {
		const coordinator = new PrewalkCoordinator();
		expect(coordinator.arm("run", "epoch", "automatic", true, planner, config)).toEqual({
			type: "none",
		});
		expect(coordinator.run?.planner).toEqual(planner);
		expect(
			coordinator.onTurnEnd({
				todoSucceeded: false,
			}),
		).toEqual({ type: "send-planning" });
		expect(coordinator.run?.phase).toBe("planning");
	});

	it("injects planning immediately for a manual arm", () => {
		const coordinator = new PrewalkCoordinator();
		expect(coordinator.arm("run", "epoch", "manual", true, planner, config)).toEqual({
			type: "send-planning",
		});
	});

	it("waits for successful todo before accepting a mutation", () => {
		const coordinator = new PrewalkCoordinator();
		coordinator.arm("run", "epoch", "automatic", true, planner, config);
		coordinator.onTurnEnd({ todoSucceeded: false });

		expect(
			coordinator.onTurnEnd({
				todoSucceeded: false,
				mutation: { toolCallId: "early", toolName: "write" },
			}),
		).toEqual({ type: "none" });

		coordinator.onTurnEnd({ todoSucceeded: true });
		const action = coordinator.onTurnEnd({
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
		coordinator.arm("run", "epoch", "automatic", false, planner, config);
		expect(
			coordinator.onTurnEnd({
				todoSucceeded: false,
				mutation: { toolCallId: "write", toolName: "write" },
			}),
		).toEqual({
			type: "handoff",
			trigger: { toolCallId: "write", toolName: "write" },
		});
	});

	it("allows one continuation only after todo ownership and actionable work", () => {
		const coordinator = new PrewalkCoordinator();
		coordinator.arm("run", "epoch", "automatic", true, planner, config);
		expect(coordinator.onTurnEnd({ todoSucceeded: false }).type).toBe("send-planning");
		expect(coordinator.requestContinuation(true)).toEqual({ type: "none" });
		coordinator.onTurnEnd({ todoSucceeded: true });
		expect(coordinator.requestContinuation(false)).toEqual({ type: "none" });
		expect(coordinator.requestContinuation(true)).toEqual({ type: "send-continuation" });
		expect(coordinator.requestContinuation(true)).toEqual({ type: "none" });
	});

	it("tracks executor activation, completion, failure, and cancellation separately from selection", () => {
		const coordinator = new PrewalkCoordinator();
		coordinator.arm("run", "epoch", "automatic", false, planner, config);
		coordinator.onTurnEnd({
			todoSucceeded: false,
			mutation: { toolCallId: "write", toolName: "write" },
		});
		coordinator.activateExecutor();
		expect(coordinator.run?.effectiveRoute).toBe("executor");
		coordinator.completeHandoff();
		expect(coordinator.run?.phase).toBe("completed");
		coordinator.fail("provider_stream_failed", true);
		expect(coordinator.run).toMatchObject({ phase: "failed", effectiveRoute: "executor" });
		coordinator.cancel(false);
		expect(coordinator.run).toMatchObject({ phase: "cancelled", effectiveRoute: "selected" });
	});

	it("restores an existing live epoch without re-arming", () => {
		const original = new PrewalkCoordinator();
		original.arm("run", "epoch", "automatic", true, planner, config);
		original.onTurnEnd({ todoSucceeded: false });
		const run = original.run;
		if (!run) throw new Error("Expected run");

		const restored = new PrewalkCoordinator();
		restored.restore(run);
		expect(restored.run).toEqual(run);
	});
});
