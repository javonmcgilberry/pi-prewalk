import { describe, expect, it, vi } from "vitest";
import {
	type MutationEvidenceAdapter,
	type MutationToolResult,
	MutationTurnBuffer,
} from "../src/mutation.js";
import { PREWALK_TODO_TOOL_NAME } from "../src/todo.js";

function assistant(...calls: Array<{ id: string; name: string }>) {
	return {
		role: "assistant",
		content: calls.map((call) => ({
			type: "toolCall",
			id: call.id,
			name: call.name,
			arguments: {},
		})),
	};
}

function result(
	toolCallId: string,
	toolName: string,
	options: Partial<MutationToolResult> = {},
): MutationToolResult {
	return {
		toolCallId,
		toolName,
		input: {},
		isError: false,
		...options,
	};
}

function finish(
	buffer: MutationTurnBuffer,
	calls: Array<{ id: string; name: string }>,
	todoSeen = true,
) {
	return buffer.finishTurn(assistant(...calls), {
		todoActive: true,
		todoSeen,
	});
}

describe("direct mutation results", () => {
	it("accepts only positive evidence from an optional adapter with canonical identity", () => {
		const adapter: MutationEvidenceAdapter = {
			toolName: "integration_patch",
			kindFor: (candidate) => (candidate.details === "committed" ? "apply_patch" : undefined),
		};
		const accepted = new MutationTurnBuffer([adapter]);
		accepted.recordResult(result("committed", "integration_patch", { details: "committed" }));
		expect(finish(accepted, [{ id: "committed", name: "integration_patch" }]).mutation).toEqual({
			toolCallId: "committed",
			toolName: "integration_patch",
			kind: "apply_patch",
			source: "adapter",
		});

		const rejected = new MutationTurnBuffer([adapter]);
		rejected.recordResult(result("unknown", "integration_patch", { details: "unknown" }));
		expect(
			finish(rejected, [{ id: "unknown", name: "integration_patch" }]).mutation,
		).toBeUndefined();
	});

	it("keeps known tool decisions authoritative over optional adapters", () => {
		const kindFor = vi.fn<MutationEvidenceAdapter["kindFor"]>(() => "write");
		const buffer = new MutationTurnBuffer([{ toolName: "apply_patch", kindFor }]);
		buffer.recordResult(
			result("patch", "apply_patch", {
				details: { status: "partial_failure", result: { changedFiles: ["src/a.ts"] } },
			}),
		);

		expect(finish(buffer, [{ id: "patch", name: "apply_patch" }]).mutation).toBeUndefined();
		expect(kindFor).not.toHaveBeenCalled();
	});

	it("uses the first positive optional adapter deterministically", () => {
		const skipped = vi.fn<MutationEvidenceAdapter["kindFor"]>(() => undefined);
		const accepted = vi.fn<MutationEvidenceAdapter["kindFor"]>(() => "edit");
		const later = vi.fn<MutationEvidenceAdapter["kindFor"]>(() => "write");
		const buffer = new MutationTurnBuffer([
			{ toolName: "custom_editor", kindFor: skipped },
			{ toolName: "custom_editor", kindFor: accepted },
			{ toolName: "custom_editor", kindFor: later },
		]);
		buffer.recordResult(result("custom", "custom_editor", { details: { changed: true } }));

		expect(finish(buffer, [{ id: "custom", name: "custom_editor" }]).mutation).toEqual({
			toolCallId: "custom",
			toolName: "custom_editor",
			kind: "edit",
			source: "adapter",
		});
		expect(skipped).toHaveBeenCalledOnce();
		expect(accepted).toHaveBeenCalledOnce();
		expect(later).not.toHaveBeenCalled();
	});

	it("does not offer unrelated todo or read results to an adapter", () => {
		const kindFor = vi.fn<MutationEvidenceAdapter["kindFor"]>(() => "edit");
		const buffer = new MutationTurnBuffer([{ toolName: "external_editor", kindFor }]);
		buffer.recordResult(result("todo", PREWALK_TODO_TOOL_NAME));
		buffer.recordResult(result("read", "read", { details: { changed: true } }));

		expect(
			finish(buffer, [
				{ id: "todo", name: PREWALK_TODO_TOOL_NAME },
				{ id: "read", name: "read" },
			]).mutation,
		).toBeUndefined();
		expect(kindFor).not.toHaveBeenCalled();
	});

	it.each(["edit", "write"])("accepts a successful %s result", (toolName) => {
		const buffer = new MutationTurnBuffer();
		buffer.recordResult(result("mutation", toolName));

		expect(finish(buffer, [{ id: "mutation", name: toolName }]).mutation).toEqual({
			toolCallId: "mutation",
			toolName,
			kind: toolName,
			source: "builtin",
		});
	});

	it("requires terminal direct apply_patch success", () => {
		const successful = new MutationTurnBuffer();
		successful.recordResult(
			result("patch", "apply_patch", {
				details: { status: "success", result: { changedFiles: ["src/a.ts"] } },
			}),
		);
		expect(finish(successful, [{ id: "patch", name: "apply_patch" }]).mutation).toEqual({
			toolCallId: "patch",
			toolName: "apply_patch",
			kind: "apply_patch",
			source: "direct",
		});

		for (const rejected of [
			result("patch", "apply_patch", {
				details: { status: "partial_failure", result: { changedFiles: ["src/a.ts"] } },
			}),
			result("patch", "apply_patch", {
				isError: true,
				details: { status: "success" },
			}),
			result("patch", "apply_patch"),
		]) {
			const buffer = new MutationTurnBuffer();
			buffer.recordResult(rejected);
			expect(finish(buffer, [{ id: "patch", name: "apply_patch" }]).mutation).toBeUndefined();
		}
	});

	it("rejects failed and cancelled built-in results", () => {
		const buffer = new MutationTurnBuffer();
		buffer.recordResult(result("failed", "edit", { isError: true }));
		buffer.recordResult(result("cancelled", "write", { isError: true }));

		expect(
			finish(buffer, [
				{ id: "failed", name: "edit" },
				{ id: "cancelled", name: "write" },
			]).mutation,
		).toBeUndefined();
	});
});

describe("shell apply_patch proof", () => {
	it.each([
		"apply_patch <<'PATCH'\n*** Begin Patch\n*** End Patch\nPATCH",
		"cd src && apply_patch <<PATCH\n*** Begin Patch\n*** End Patch\nPATCH",
		"printf '%s' \"$PATCH_TEXT\" | apply_patch",
		"echo ready; apply_patch",
		"apply_patch && echo applied",
		"apply_patch <<'PATCH'\n*** Begin Patch\n*** End Patch\nPATCH\n",
	])("accepts a successful command with apply_patch in a provable position", (command) => {
		const buffer = new MutationTurnBuffer();
		buffer.recordResult(result("bash", "bash", { input: { command } }));

		expect(finish(buffer, [{ id: "bash", name: "bash" }]).mutation).toEqual({
			toolCallId: "bash",
			toolName: "bash",
			kind: "apply_patch",
			source: "shell",
		});
	});

	it.each([
		"# apply_patch <<'PATCH'",
		"echo apply_patch",
		"printf '%s' 'apply_patch'",
		"\"apply_patch\" <<'PATCH'\ntext\nPATCH",
		"bash -c 'apply_patch'",
		'tool=apply_patch; "$tool"',
		"$(printf apply_patch) <<'PATCH'\ntext\nPATCH",
		"apply_patch | cat",
		"apply_patch || true",
		"apply_patch; echo ignored",
		"alias patch=apply_patch; patch",
	])("rejects an unproven shell mention: %s", (command) => {
		const buffer = new MutationTurnBuffer();
		buffer.recordResult(result("bash", "bash", { input: { command } }));

		expect(finish(buffer, [{ id: "bash", name: "bash" }]).mutation).toBeUndefined();
	});

	it("requires a successful shell result", () => {
		const buffer = new MutationTurnBuffer();
		buffer.recordResult(
			result("bash", "bash", {
				input: { command: "apply_patch <<'PATCH'\ntext\nPATCH" },
				isError: true,
			}),
		);

		expect(finish(buffer, [{ id: "bash", name: "bash" }]).mutation).toBeUndefined();
	});
});

describe("direct exec_command sessions", () => {
	it("accepts exit zero and rejects nonzero or still-running results", () => {
		const buffer = new MutationTurnBuffer();
		buffer.recordResult(
			result("success", "exec_command", {
				input: { cmd: "apply_patch <<'PATCH'\ntext\nPATCH" },
				details: { output: "Done", exit_code: 0 },
			}),
		);
		buffer.recordResult(
			result("failed", "exec_command", {
				input: { cmd: "apply_patch" },
				details: { output: "Failed", exit_code: 1 },
			}),
		);
		buffer.recordResult(
			result("running", "exec_command", {
				input: { cmd: "apply_patch" },
				details: { output: "", session_id: 12 },
			}),
		);

		expect(
			finish(buffer, [
				{ id: "failed", name: "exec_command" },
				{ id: "running", name: "exec_command" },
				{ id: "success", name: "exec_command" },
			]).mutation,
		).toMatchObject({ toolCallId: "success", source: "exec_command" });
	});

	it("correlates a persistent session through a later write_stdin result", () => {
		const buffer = new MutationTurnBuffer();
		buffer.recordResult(
			result("start", "exec_command", {
				input: { cmd: "apply_patch" },
				details: { output: "", session_id: 31 },
			}),
		);
		expect(finish(buffer, [{ id: "start", name: "exec_command" }]).mutation).toBeUndefined();

		buffer.recordResult(
			result("poll", "write_stdin", {
				input: { session_id: 31 },
				details: { output: "Done", exit_code: 0 },
			}),
		);
		expect(finish(buffer, [{ id: "poll", name: "write_stdin" }]).mutation).toEqual({
			toolCallId: "poll",
			toolName: "write_stdin",
			kind: "apply_patch",
			source: "exec_command",
			sessionId: 31,
		});
	});
});

describe("Code Mode traces", () => {
	it("retains more than 50 update traces and recognizes a terminal apply_patch", () => {
		const buffer = new MutationTurnBuffer();
		for (let index = 0; index < 55; index += 1) {
			buffer.recordExecutionUpdate({
				toolCallId: "exec",
				toolName: "exec",
				args: { code: "many tools" },
				partialResult: {
					details: {
						codeMode: true,
						cellId: "cell-many",
						status: "running",
						traces: [
							{
								id: `trace-${index}`,
								name: index === 0 ? "apply_patch" : "view_image",
								input: {},
								status: "done",
								result: {
									content: [],
									details: { status: "success" },
								},
							},
						],
					},
				},
			});
		}
		buffer.recordResult(
			result("exec", "exec", {
				details: {
					codeMode: true,
					cellId: "cell-many",
					status: "result",
					traces: [],
					droppedTraceCount: 5,
				},
			}),
		);

		expect(finish(buffer, [{ id: "exec", name: "exec" }]).mutation).toEqual({
			toolCallId: "exec",
			toolName: "exec",
			kind: "apply_patch",
			source: "code_mode",
			cellId: "cell-many",
			traceId: "trace-0",
		});
	});

	it("waits for the terminal wait result of a yielded cell", () => {
		const buffer = new MutationTurnBuffer();
		const trace = {
			id: "patch-trace",
			name: "apply_patch",
			input: {},
			status: "done",
			result: { content: [], details: { status: "success" } },
		};
		buffer.recordResult(
			result("exec", "exec", {
				details: {
					codeMode: true,
					cellId: "cell-yielded",
					status: "yielded",
					traces: [trace],
				},
			}),
		);
		expect(finish(buffer, [{ id: "exec", name: "exec" }]).mutation).toBeUndefined();

		buffer.recordResult(
			result("wait", "wait", {
				input: { cell_id: "cell-yielded" },
				details: {
					codeMode: true,
					cellId: "cell-yielded",
					status: "result",
					traces: [trace],
				},
			}),
		);
		expect(finish(buffer, [{ id: "wait", name: "wait" }]).mutation).toMatchObject({
			toolCallId: "wait",
			source: "code_mode",
			cellId: "cell-yielded",
			traceId: "patch-trace",
		});
	});

	it("correlates nested persistent exec_command and write_stdin traces", () => {
		const buffer = new MutationTurnBuffer();
		buffer.recordResult(
			result("exec-one", "exec", {
				details: {
					codeMode: true,
					cellId: "cell-one",
					status: "result",
					traces: [
						{
							id: "command",
							name: "exec_command",
							input: { cmd: "apply_patch" },
							status: "done",
							result: { content: [], details: { output: "", session_id: 91 } },
						},
					],
				},
			}),
		);
		expect(finish(buffer, [{ id: "exec-one", name: "exec" }]).mutation).toBeUndefined();

		buffer.recordResult(
			result("exec-two", "exec", {
				details: {
					codeMode: true,
					cellId: "cell-two",
					status: "result",
					traces: [
						{
							id: "poll",
							name: "write_stdin",
							input: { session_id: 91 },
							status: "done",
							result: { content: [], details: { output: "Done", exit_code: 0 } },
						},
					],
				},
			}),
		);
		expect(finish(buffer, [{ id: "exec-two", name: "exec" }]).mutation).toMatchObject({
			source: "code_mode",
			traceId: "poll",
			sessionId: 91,
		});
	});

	it.each([
		{ status: "yielded" },
		{ status: "terminated" },
		{ status: "result", scriptError: "boom" },
	])("rejects non-successful outer status $status", (outer) => {
		const buffer = new MutationTurnBuffer();
		buffer.recordResult(
			result("exec", "exec", {
				details: {
					codeMode: true,
					cellId: "cell",
					...outer,
					traces: [
						{
							id: "patch",
							name: "apply_patch",
							input: {},
							status: "done",
							result: { content: [], details: { status: "success" } },
						},
					],
				},
			}),
		);

		expect(finish(buffer, [{ id: "exec", name: "exec" }]).mutation).toBeUndefined();
	});

	it("rejects partial and failed nested traces", () => {
		const buffer = new MutationTurnBuffer();
		buffer.recordResult(
			result("exec", "exec", {
				details: {
					codeMode: true,
					cellId: "cell",
					status: "result",
					traces: [
						{
							id: "partial",
							name: "apply_patch",
							input: {},
							status: "done",
							result: { content: [], details: { status: "partial_failure" } },
						},
						{
							id: "failed",
							name: "apply_patch",
							input: {},
							status: "error",
							error: "failed",
						},
					],
				},
			}),
		);

		expect(finish(buffer, [{ id: "exec", name: "exec" }]).mutation).toBeUndefined();
	});
});

describe("turn selection", () => {
	it("uses assistant-authored order instead of result arrival order", () => {
		const first = new MutationTurnBuffer();
		first.recordResult(result("second", "write"));
		first.recordResult(result("first", "edit"));
		const second = new MutationTurnBuffer();
		second.recordResult(result("first", "edit"));
		second.recordResult(result("second", "write"));
		const calls = [
			{ id: "first", name: "edit" },
			{ id: "second", name: "write" },
		];

		expect(finish(first, calls).mutation?.toolCallId).toBe("first");
		expect(finish(second, calls).mutation?.toolCallId).toBe("first");
	});

	it("opens the todo gate for a successful todo in the same turn", () => {
		const buffer = new MutationTurnBuffer();
		buffer.recordResult(result("edit", "edit"));
		buffer.recordResult(result("todo", PREWALK_TODO_TOOL_NAME));

		const evidence = finish(
			buffer,
			[
				{ id: "edit", name: "edit" },
				{ id: "todo", name: PREWALK_TODO_TOOL_NAME },
			],
			false,
		);
		expect(evidence.todoSucceeded).toBe(true);
		expect(evidence.mutation?.toolCallId).toBe("edit");
	});

	it("does not choose a second trigger after handoff selection", () => {
		const buffer = new MutationTurnBuffer();
		buffer.recordResult(result("first", "edit"));
		expect(finish(buffer, [{ id: "first", name: "edit" }]).mutation).toBeDefined();

		buffer.recordResult(result("second", "write"));
		expect(finish(buffer, [{ id: "second", name: "write" }]).mutation).toBeUndefined();
	});

	it("allows a new trigger after a fresh-run reset", () => {
		const buffer = new MutationTurnBuffer();
		buffer.recordResult(result("first", "edit"));
		expect(finish(buffer, [{ id: "first", name: "edit" }]).mutation).toBeDefined();

		buffer.resetForRun();
		buffer.recordResult(result("second", "write"));
		expect(finish(buffer, [{ id: "second", name: "write" }]).mutation).toBeDefined();
	});
});
