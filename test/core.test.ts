import { describe, expect, it } from "vitest";
import {
	CHECKPOINT_TOOL,
	EXPLORATION_TOOLS,
	MAX_CHECKPOINT_ITEM_LENGTH,
	MAX_CHECKPOINT_TOTAL_LENGTH,
	PrewalkCoordinator,
	parseConfig,
	type ToolResultStatus,
} from "../src/core.js";

function baseRun(mode: "automatic" | "manual" = "manual") {
	return {
		id: "run-123",
		mode,
		target: { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna" },
		thinkingLevel: "low" as const,
		plannerRecipientFingerprint: "planner-fingerprint",
		targetRecipientFingerprint: "target-fingerprint",
	};
}

function validCheckpoint(runId = "run-123") {
	return {
		runId,
		items: ["Inspect source", "Add state", "Wire events", "Run unit tests", "Run smoke test"],
	};
}

describe("parseConfig", () => {
	it("accepts the strict config", () => {
		expect(
			parseConfig({
				enabled: true,
				target: "openai-codex/gpt-5.6-luna",
				thinkingLevel: "low",
				crossProviderPairs: ["openai-codex->anthropic", "openai-codex->anthropic"],
			}),
		).toEqual({
			enabled: true,
			target: "openai-codex/gpt-5.6-luna",
			thinkingLevel: "low",
			crossProviderPairs: ["openai-codex->anthropic"],
		});
	});

	it.each([
		[
			"unknown field",
			{
				enabled: true,
				target: "a/b",
				thinkingLevel: "low",
				crossProviderPairs: [],
				extra: true,
			},
		],
		[
			"bad target",
			{
				enabled: true,
				target: "missing-slash",
				thinkingLevel: "low",
				crossProviderPairs: [],
			},
		],
		[
			"bad thinking",
			{
				enabled: true,
				target: "a/b",
				thinkingLevel: "extreme",
				crossProviderPairs: [],
			},
		],
		[
			"bad pair",
			{
				enabled: true,
				target: "a/b",
				thinkingLevel: "low",
				crossProviderPairs: ["a:b"],
			},
		],
	])("rejects %s", (_name, input) => {
		expect(() => parseConfig(input)).toThrow();
	});
});

describe("PrewalkCoordinator", () => {
	it("keeps automatic arming dormant and disarms at ordinary settlement without a continuation", () => {
		const coordinator = new PrewalkCoordinator();
		const run = coordinator.arm(baseRun("automatic"));

		expect(run).toMatchObject({ phase: "armed", projectionActive: false });
		expect(coordinator.onAgentSettled()).toEqual({
			type: "disarmed",
			reason: "Prewalk disarmed when the agent settled before handoff.",
		});
		expect(coordinator.run).toBeUndefined();
	});

	it("promotes a dormant automatic run for explicit manual planning", () => {
		const coordinator = new PrewalkCoordinator();
		const run = coordinator.arm(baseRun("automatic"));

		expect(coordinator.activateManual()).toBe(run);
		expect(run).toMatchObject({
			mode: "manual",
			phase: "planning",
			projectionActive: true,
		});
	});

	it.each([...EXPLORATION_TOOLS])(
		"activates automatic planning after successful %s",
		(toolName) => {
			const coordinator = new PrewalkCoordinator();
			const run = coordinator.arm(baseRun("automatic"));

			expect(coordinator.onToolResult(toolName, `${toolName}-1`, "success")).toEqual({
				type: "activated",
			});
			expect(run).toMatchObject({ phase: "planning", projectionActive: true });
		},
	);

	it.each([
		["read", "error"],
		["grep", "cancelled"],
		["bash", "success"],
		["apply_patch", "success"],
	] as const)("does not activate for %s with %s status", (toolName, status) => {
		const coordinator = new PrewalkCoordinator();
		const run = coordinator.arm(baseRun("automatic"));

		expect(coordinator.onToolResult(toolName, "tool-1", status)).toEqual({
			type: "none",
		});
		expect(run).toMatchObject({ phase: "armed", projectionActive: false });
	});

	it.each(["edit", "write"])("activates and blocks direct %s before checkpoint", (toolName) => {
		const coordinator = new PrewalkCoordinator();
		const run = coordinator.arm(baseRun("automatic"));

		expect(coordinator.onToolCall(toolName, "mutation-1", false)).toEqual({
			block: true,
			reason: `Call ${CHECKPOINT_TOOL} successfully before editing or writing.`,
		});
		expect(run).toMatchObject({ phase: "planning", projectionActive: true });
	});

	it("rejects invalid checkpoints without changing phase", () => {
		const coordinator = new PrewalkCoordinator();
		const run = coordinator.arm(baseRun());
		const invalid = [
			validCheckpoint("stale-run"),
			{ runId: run.id, items: ["1", "2", "3", "4"] },
			{
				runId: run.id,
				items: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
			},
			{ runId: run.id, items: ["1", "2", "3", "4", "   "] },
			{
				runId: run.id,
				items: ["1", "2", "3", "4", "x".repeat(MAX_CHECKPOINT_ITEM_LENGTH + 1)],
			},
			{
				runId: run.id,
				items: ["a", "b", "c", "d", "x".repeat(MAX_CHECKPOINT_TOTAL_LENGTH - 3)],
			},
		];

		for (const checkpoint of invalid) {
			expect(coordinator.onCheckpointResult(checkpoint, false)).toBe(false);
			expect(run).toMatchObject({ phase: "planning", projectionActive: true });
			expect(run.checkpointItems).toBeUndefined();
		}
		expect(coordinator.onCheckpointResult(validCheckpoint(), true)).toBe(false);
	});

	it("accepts one valid checkpoint for the current run", () => {
		const coordinator = new PrewalkCoordinator();
		const run = coordinator.arm(baseRun());

		expect(coordinator.onCheckpointResult(validCheckpoint(), false)).toBe(true);
		expect(run).toMatchObject({
			phase: "checkpointed",
			checkpointItems: validCheckpoint().items,
		});
		expect(coordinator.onCheckpointResult(validCheckpoint(), false)).toBe(false);
	});

	it("requires target readiness before reserving a mutation", () => {
		const coordinator = new PrewalkCoordinator();
		const run = coordinator.arm(baseRun());
		coordinator.onCheckpointResult(validCheckpoint(), false);

		expect(coordinator.onToolCall("edit", "edit-1", false)).toEqual({
			block: true,
			reason: "Prewalk target is not ready; configure and authenticate it before mutation.",
		});
		expect(run).toMatchObject({ phase: "checkpointed" });
		expect(run.mutationToolCallId).toBeUndefined();

		expect(coordinator.onToolCall("edit", "edit-1", true)).toEqual({
			block: false,
		});
		expect(run).toMatchObject({
			phase: "mutation-pending",
			mutationToolCallId: "edit-1",
		});
	});

	it.each(["error", "cancelled"] satisfies ToolResultStatus[])(
		"returns a failed or cancelled reservation to checkpointed (%s)",
		(status) => {
			const coordinator = new PrewalkCoordinator();
			const run = coordinator.arm(baseRun());
			coordinator.onCheckpointResult(validCheckpoint(), false);
			coordinator.onToolCall("write", "write-1", true);

			expect(coordinator.onToolResult("write", "write-1", status)).toEqual({
				type: "none",
			});
			expect(run).toMatchObject({ phase: "checkpointed" });
			expect(run.mutationToolCallId).toBeUndefined();
			expect(coordinator.onToolCall("edit", "edit-2", true)).toEqual({
				block: false,
			});
		},
	);

	it("ignores unrelated results and permits only one mutation reservation", () => {
		const coordinator = new PrewalkCoordinator();
		const run = coordinator.arm(baseRun());
		coordinator.onCheckpointResult(validCheckpoint(), false);
		coordinator.onToolCall("edit", "edit-1", true);

		expect(coordinator.onToolResult("write", "write-2", "success")).toEqual({
			type: "none",
		});
		expect(run).toMatchObject({
			phase: "mutation-pending",
			mutationToolCallId: "edit-1",
		});
		expect(coordinator.onToolCall("write", "write-2", true)).toEqual({
			block: true,
			reason: "Prewalk permits exactly one post-checkpoint mutation at a time.",
		});
	});

	it("marks the first successful reservation for one persisted-turn handoff", () => {
		const coordinator = new PrewalkCoordinator();
		const run = coordinator.arm(baseRun());
		coordinator.onCheckpointResult(validCheckpoint(), false);
		coordinator.onToolCall("write", "write-1", true);

		expect(coordinator.onToolResult("write", "write-1", "success")).toEqual({
			type: "handoff-pending",
			run,
		});
		expect(run).toMatchObject({
			phase: "handoff-pending",
			projectionActive: false,
		});
		expect(coordinator.onToolCall("edit", "edit-2", true)).toEqual({
			block: true,
			reason: "Prewalk handoff is already pending or complete.",
		});

		expect(coordinator.onTurnEnd()).toEqual({ type: "handoff", run });
		expect(run.phase).toBe("completed");
		expect(coordinator.onTurnEnd()).toEqual({ type: "none" });
	});

	it.each(["new", "resume", "fork", "reload", "cancel", "compact", "shutdown", "handoff-failed"])(
		"clears all state at the %s lifecycle boundary",
		(reason) => {
			const coordinator = new PrewalkCoordinator();
			const run = coordinator.arm(baseRun());
			coordinator.onCheckpointResult(validCheckpoint(), false);
			coordinator.onToolCall("edit", "edit-1", true);

			expect(coordinator.onLifecycleBoundary(reason)).toEqual({
				type: "disarmed",
				reason,
			});
			expect(coordinator.run).toBeUndefined();
			expect(run.checkpointItems).toBeUndefined();
			expect(run.mutationToolCallId).toBeUndefined();
			expect(run.projectionActive).toBe(false);
		},
	);

	it("clears a completed run at settlement without another action", () => {
		const coordinator = new PrewalkCoordinator();
		coordinator.arm(baseRun());
		coordinator.onCheckpointResult(validCheckpoint(), false);
		coordinator.onToolCall("edit", "edit-1", true);
		coordinator.onToolResult("edit", "edit-1", "success");
		coordinator.onTurnEnd();

		expect(coordinator.onAgentSettled()).toEqual({ type: "none" });
		expect(coordinator.run).toBeUndefined();
	});

	it("ignores mutation-like custom tool names", () => {
		const coordinator = new PrewalkCoordinator();
		coordinator.arm(baseRun());
		expect(coordinator.onToolCall("apply_patch", "patch-1", true)).toEqual({
			block: false,
		});
		expect(coordinator.onToolResult("apply_patch", "patch-1", "success")).toEqual({
			type: "none",
		});
	});
});
