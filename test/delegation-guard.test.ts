import { describe, expect, it } from "vitest";
import { blocksPlannerDelegation } from "../src/turn/delegation-guard.js";

describe("planner delegation boundary", () => {
	it.each([
		{ agent: "worker", task: "implement" },
		{ workflowScript: "return runs.run('worker', {});" },
		{ workflow: "review" },
		{ action: "resume", id: "child" },
		{ action: "steer", id: "child", message: "implement" },
		{ action: "schedule.create" },
		{},
	])("blocks dispatch before parent handoff: %j", (input) => {
		expect(blocksPlannerDelegation("subagent", input)).toBe(true);
	});
	it.each(["list", "models", "guide", "status", "interrupt", "stop"])(
		"allows discovery and stopping: %s",
		(action) => expect(blocksPlannerDelegation("subagent", { action })).toBe(false),
	);
	it("leaves ordinary tools alone", () => {
		expect(blocksPlannerDelegation("edit", {})).toBe(false);
	});
});
