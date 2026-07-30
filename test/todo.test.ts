import { describe, expect, it } from "vitest";
import { applyTodoOperation, latestTodoPhases, type TodoPhase, TodoReminder } from "../src/todo.js";

function initialized(): TodoPhase[] {
	return applyTodoOperation([], {
		op: "init",
		list: [
			{ phase: "Build", items: ["First", "Second"] },
			{ phase: "Verify", items: ["Tests"] },
		],
	}).details.phases;
}

describe("todo operations", () => {
	it("initializes phases and auto-starts one task", () => {
		const result = applyTodoOperation([], {
			op: "init",
			list: [{ phase: "Build", items: ["First", "Second"] }],
		});
		expect(result.isError).toBe(false);
		expect(result.details.phases[0]?.tasks.map((task) => task.status)).toEqual([
			"in_progress",
			"pending",
		]);
	});

	it("supports start, done, block, unblock, drop, append, remove, and view", () => {
		let phases = initialized();
		phases = applyTodoOperation(phases, { op: "start", task: "Second" }).details.phases;
		expect(phases[0]?.tasks.map((task) => task.status)).toEqual(["pending", "in_progress"]);

		const done = applyTodoOperation(phases, { op: "done", task: "Second" });
		expect(done.details.completedTasks).toEqual([{ phase: "Build", content: "Second" }]);
		phases = done.details.phases;

		phases = applyTodoOperation(phases, {
			op: "block",
			task: "Tests",
			reason: "waiting\nfor CI",
		}).details.phases;
		expect(phases[1]?.tasks[0]).toMatchObject({
			status: "blocked",
			blocker: "waiting for CI",
		});

		phases = applyTodoOperation(phases, { op: "unblock", phase: "Verify" }).details.phases;
		expect(phases[1]?.tasks[0]?.status).toBe("pending");

		phases = applyTodoOperation(phases, {
			op: "append",
			phase: "Verify",
			items: ["Smoke"],
		}).details.phases;
		expect(phases[1]?.tasks.map((task) => task.content)).toEqual(["Tests", "Smoke"]);

		phases = applyTodoOperation(phases, { op: "drop", task: "Smoke" }).details.phases;
		expect(phases[1]?.tasks[1]?.status).toBe("abandoned");

		const viewed = applyTodoOperation(phases, { op: "view" });
		expect(viewed.details.phases).toEqual(phases);

		phases = applyTodoOperation(phases, { op: "rm", task: "Smoke" }).details.phases;
		expect(phases[1]?.tasks.map((task) => task.content)).toEqual(["Tests"]);
	});

	it("rejects invalid operations without partially mutating state", () => {
		const phases = initialized();
		const duplicate = applyTodoOperation(phases, {
			op: "append",
			phase: "Build",
			items: ["First", "Third"],
		});
		expect(duplicate.isError).toBe(true);
		expect(duplicate.details.phases).toEqual(phases);
	});

	it("restores the latest successful transcript snapshot", () => {
		const phases = initialized();
		expect(
			latestTodoPhases([
				{ role: "toolResult", toolName: "todo", isError: false, details: { phases } },
			]),
		).toEqual(phases);
		expect(
			latestTodoPhases([
				{ role: "toolResult", toolName: "todo", isError: false, details: { phases } },
				{ role: "toolResult", toolName: "todo", isError: true, details: { phases: [] } },
			]),
		).toEqual(phases);
	});

	it("bounds incomplete-work reminders to one per cycle", () => {
		const reminder = new TodoReminder();
		const phases = initialized();
		expect(reminder.next(phases)).toContain("remaining 3");
		expect(reminder.next(phases)).toBeUndefined();
		reminder.reset();
		expect(reminder.next(phases)).toContain("remaining 3");
	});
});
