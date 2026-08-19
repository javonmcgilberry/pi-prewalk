import { describe, expect, it } from "vitest";
import { DEFAULT_ANALYTICS_CONFIG } from "../../src/analytics/index.js";
import { parseConfig } from "../../src/config/prewalk-config.js";
import {
	DEFAULT_EXECUTOR,
	DEFAULT_HANDOFF_CONFIG,
	DEFAULT_PLANNER,
	DEFAULT_PLANNER_RECOVERY_CONFIG,
	EXECUTOR_MODEL_ID,
	PLANNER_MODEL_ID,
} from "../../src/orchestration/coordinator.js";
import { PrewalkApplication } from "../../src/orchestration/prewalk-application.js";

const config = {
	executor: { ...DEFAULT_EXECUTOR },
};
const planner = { ...DEFAULT_PLANNER, reasoning: "high" as const };

describe("provider-neutral configuration", () => {
	it("stores the persistent automatic opt-in with a safe off default", () => {
		expect(parseConfig(config)).toEqual({
			...config,
			enabled: false,
			handoff: DEFAULT_HANDOFF_CONFIG,
			plannerRecovery: DEFAULT_PLANNER_RECOVERY_CONFIG,
			analytics: DEFAULT_ANALYTICS_CONFIG,
		});
		expect(parseConfig({ ...config, enabled: true })).toMatchObject({ enabled: true });
		expect(() => parseConfig({ ...config, planner: DEFAULT_PLANNER })).toThrow(
			"Unknown Prewalk config field: planner.",
		);
		expect(() => parseConfig({ ...config, enabled: "yes" })).toThrow(
			"Prewalk config enabled must be a boolean.",
		);
		expect(PLANNER_MODEL_ID).toBe("gpt-5.6-sol");
		expect(EXECUTOR_MODEL_ID).toBe("gpt-5.6-luna");
	});

	it("defaults planner recovery to five retries and validates overrides", () => {
		expect(parseConfig(config).plannerRecovery).toEqual({ maxRetries: 5 });
		expect(
			parseConfig({ ...config, plannerRecovery: { maxRetries: 2 } }).plannerRecovery,
		).toEqual({ maxRetries: 2 });
		for (const maxRetries of [0, -1, 1.5, "5"]) {
			expect(() => parseConfig({ ...config, plannerRecovery: { maxRetries } })).toThrow(
				"Prewalk config plannerRecovery.maxRetries must be a positive integer.",
			);
		}
		expect(() =>
			parseConfig({ ...config, plannerRecovery: { maxRetries: 5, delayMs: 1000 } }),
		).toThrow("Unknown Prewalk config plannerRecovery field: delayMs.");
	});

	it("normalizes handoff extension exclusions", () => {
		expect(
			parseConfig({
				...config,
				handoff: { ignoreExtensions: [".MD", ".txt", ".md"] },
			}),
		).toMatchObject({ handoff: { ignoreExtensions: [".md", ".txt"] } });
		expect(parseConfig({ ...config, handoff: { ignoreExtensions: [] } }).handoff).toEqual({
			ignoreExtensions: [],
		});
		expect(() => parseConfig({ ...config, handoff: { ignoreExtensions: ["md"] } })).toThrow(
			"entries must be file extensions such as .md",
		);
		expect(() =>
			parseConfig({ ...config, handoff: { ignoreExtensions: [".md"], paths: [] } }),
		).toThrow("Unknown Prewalk config handoff field: paths.");
	});

	it("keeps an ordered executor fallback chain", () => {
		const haiku = { provider: "anthropic", model: "claude-haiku-4-5", reasoning: "low" as const };
		const flash = { provider: "google", model: "gemini-3.5-flash", reasoning: "low" as const };
		expect(parseConfig({ ...config, executorFallbacks: [haiku, flash] })).toMatchObject({
			executor: DEFAULT_EXECUTOR,
			executorFallbacks: [haiku, flash],
		});
	});

	it("preserves an explicit empty fallback chain as an opt-out of inference", () => {
		expect(parseConfig({ ...config, executorFallbacks: [] })).toMatchObject({
			executor: DEFAULT_EXECUTOR,
			executorFallbacks: [],
		});
	});

	it("rejects a malformed executor fallback chain", () => {
		expect(() => parseConfig({ ...config, executorFallbacks: {} })).toThrow(
			"Prewalk config executorFallbacks must be an array.",
		);
		expect(() =>
			parseConfig({ ...config, executorFallbacks: [{ provider: "anthropic", model: "x" }] }),
		).toThrow("Prewalk config executorFallbacks[0].reasoning is invalid.");
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

	it("keeps child Prewalk off by default and parses per-agent opt-ins", () => {
		expect(parseConfig(config)).not.toHaveProperty("children");
		expect(
			parseConfig({
				...config,
				children: {
					agents: {
						worker: true,
						reviewer: false,
						"custom-implementer": {
							executor: {
								provider: "anthropic",
								model: "claude-haiku-4-5",
								reasoning: "low",
							},
						},
					},
				},
			}),
		).toMatchObject({
			children: {
				agents: {
					worker: true,
					reviewer: false,
					"custom-implementer": {
						executor: {
							provider: "anthropic",
							model: "claude-haiku-4-5",
							reasoning: "low",
						},
					},
				},
			},
		});
	});

	it("normalizes the legacy experimental child shape without inheriting disabled roles", () => {
		expect(
			parseConfig({
				...config,
				experimentalChild: {
					enabled: true,
					agents: {
						worker: { mode: "implementation", executor: DEFAULT_EXECUTOR },
						reviewer: { mode: "read-only", executor: DEFAULT_EXECUTOR },
					},
				},
			}),
		).toMatchObject({
			children: {
				agents: {
					worker: { executor: DEFAULT_EXECUTOR },
					reviewer: false,
				},
			},
		});
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
		).toMatchObject({ children: { agents: { worker: false } } });
	});

	it("rejects ambiguous or malformed child policy", () => {
		expect(() =>
			parseConfig({
				...config,
				children: { agents: { worker: true } },
				experimentalChild: { enabled: true, agents: {} },
			}),
		).toThrow("cannot define both children and experimentalChild");
		expect(() =>
			parseConfig({
				...config,
				children: { agents: { "": true } },
			}),
		).toThrow("child agent names must be non-empty");
		expect(() =>
			parseConfig({
				...config,
				children: { agents: { worker: "on" } },
			}),
		).toThrow("children.agents.worker must be true, false, or a custom executor object");
		expect(() =>
			parseConfig({
				...config,
				children: {
					agents: { worker: { executor: DEFAULT_EXECUTOR, mode: "implementation" } },
				},
			}),
		).toThrow("Unknown Prewalk config children.agents.worker field: mode");
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
		const coordinator = new PrewalkApplication();
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
		const coordinator = new PrewalkApplication();
		expect(coordinator.arm("run", "epoch", "manual", true, planner, config)).toEqual({
			type: "send-planning",
		});
	});

	it("waits for successful todo before accepting a mutation", () => {
		const coordinator = new PrewalkApplication();
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

	// OMP parity: "requires a fresh todo before a later explicit prewalk can hand
	// off". Todo ownership must not carry over from a finished run, or a second
	// arm would hand the executor work that never got planned.
	it("requires a fresh todo before a later arm can hand off", () => {
		const coordinator = new PrewalkApplication();
		coordinator.arm("first", "epoch", "automatic", true, planner, config);
		coordinator.onTurnEnd({ todoSucceeded: true });
		coordinator.onTurnEnd({
			todoSucceeded: false,
			mutation: { toolCallId: "first-edit", toolName: "edit" },
		});
		coordinator.activateExecutor();
		coordinator.completeHandoff();
		coordinator.reset();

		coordinator.arm("second", "epoch", "automatic", true, planner, config);
		expect(
			coordinator.onTurnEnd({
				todoSucceeded: false,
				mutation: { toolCallId: "stale", toolName: "edit" },
			}),
		).toEqual({ type: "send-planning" });
		expect(coordinator.run?.phase).toBe("planning");

		coordinator.onTurnEnd({ todoSucceeded: true });
		expect(
			coordinator.onTurnEnd({
				todoSucceeded: false,
				mutation: { toolCallId: "fresh", toolName: "edit" },
			}),
		).toEqual({
			type: "handoff",
			trigger: { toolCallId: "fresh", toolName: "edit" },
		});
	});

	it("bypasses todo when the tool is inactive", () => {
		const coordinator = new PrewalkApplication();
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
		const coordinator = new PrewalkApplication();
		coordinator.arm("run", "epoch", "automatic", true, planner, config);
		expect(coordinator.onTurnEnd({ todoSucceeded: false }).type).toBe("send-planning");
		expect(coordinator.requestContinuation(true)).toEqual({ type: "none" });
		coordinator.onTurnEnd({ todoSucceeded: true });
		expect(coordinator.requestContinuation(false)).toEqual({ type: "none" });
		expect(coordinator.requestContinuation(true)).toEqual({ type: "send-continuation" });
		expect(coordinator.requestContinuation(true)).toEqual({ type: "none" });
	});

	it("does not continue a handoff, failed run, or cancelled run", () => {
		const coordinator = new PrewalkApplication();
		coordinator.arm("run", "epoch", "automatic", true, planner, config);
		coordinator.onTurnEnd({ todoSucceeded: true });
		coordinator.onTurnEnd({
			todoSucceeded: false,
			mutation: { toolCallId: "edit", toolName: "edit" },
		});
		expect(coordinator.requestContinuation(true)).toEqual({ type: "none" });

		coordinator.fail("provider-stream-failed", false);
		expect(coordinator.requestContinuation(true)).toEqual({ type: "none" });
		coordinator.cancel(true);
		expect(coordinator.requestContinuation(true)).toEqual({ type: "none" });
	});

	it("tracks executor activation, completion, failure, and cancellation separately from selection", () => {
		const coordinator = new PrewalkApplication();
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
		const original = new PrewalkApplication();
		original.arm("run", "epoch", "automatic", true, planner, config);
		original.onTurnEnd({ todoSucceeded: false });
		const run = original.run;
		if (!run) throw new Error("Expected run");

		const restored = new PrewalkApplication();
		restored.restore(run);
		expect(restored.run).toEqual(run);
	});
});
