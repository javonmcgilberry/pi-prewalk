import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import benchmarkAttestation from "../benchmark/extensions/benchmark-attestation.js";
import {
	createBenchmarkToolDefinitions,
	createDockerWorkerRequest,
	loadBenchmarkScenario,
} from "../benchmark/extensions/benchmark-tools.js";

let root: string | undefined;

afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

describe("benchmark-owned repository tools", () => {
	it("exposes only the fixed conversion-compatible repository tools", () => {
		const tools = createBenchmarkToolDefinitions(async () => ({
			ok: true,
			output: "",
			exitCode: 0,
			lookupAttempts: 0,
			sandboxViolations: 0,
		}));
		expect(tools.map((tool) => tool.name)).toEqual([
			"exec_command",
			"write_stdin",
			"apply_patch",
		]);
	});

	it("forwards exact bounded requests and records only numeric safety evidence", async () => {
		root = await mkdtemp(path.join(tmpdir(), "prewalk-tools-"));
		const evidencePath = path.join(root, "evidence.jsonl");
		await writeFile(evidencePath, "", { mode: 0o600 });
		const request = vi.fn(async (value) => ({
			ok: true,
			code: "ok",
			output: value.method === "exec_command" ? "done\n" : "Applied patch successfully.",
			exitCode: 0,
			lookupAttempts: 1,
			sandboxViolations: 0,
		}));
		const tools = createBenchmarkToolDefinitions(request, evidencePath);
		const exec = tools.find((tool) => tool.name === "exec_command");
		const result = await exec?.execute(
			"call-1",
			{ cmd: "git status --short" },
			new AbortController().signal,
			undefined,
			{} as never,
		);
		expect(request).toHaveBeenCalledWith(
			{
				method: "exec_command",
				cmd: "git status --short",
				timeoutMs: 600_000,
			},
			{ signal: expect.anything(), timeoutMs: 600_000 },
		);
		expect(result?.content).toEqual([{ type: "text", text: "done\n" }]);
		expect(JSON.parse((await readFile(evidencePath, "utf8")).trim())).toEqual({
			lookupAttempts: 1,
			sandboxViolations: 0,
		});
	});

	it.each(["timeout", "abort"])("kills the Docker bridge on %s", async (mode) => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stdin: new PassThrough(),
			kill: vi.fn(),
		});
		child.kill.mockImplementation(() => {
			queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
			return true;
		});
		const spawnDocker = vi.fn(() => child as never);
		const request = createDockerWorkerRequest("container-1", spawnDocker);
		const controller = new AbortController();
		const response = request(
			{ method: "exec_command", cmd: "sleep forever" },
			{ signal: controller.signal, timeoutMs: mode === "timeout" ? 1 : 60_000 },
		);
		if (mode === "abort") controller.abort();
		await expect(response).rejects.toThrow(mode === "timeout" ? /timed out/ : /aborted/);
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
	});

	it("loads only an owner-only scenario with an opaque container ID", async () => {
		root = await mkdtemp(path.join(tmpdir(), "prewalk-scenario-"));
		const scenarioPath = path.join(root, "scenario.json");
		const evidencePath = path.join(root, "evidence.jsonl");
		await writeFile(evidencePath, "", { mode: 0o600 });
		await writeFile(
			scenarioPath,
			`${JSON.stringify({ containerId: "container-1", evidencePath })}\n`,
			{ mode: 0o600 },
		);
		expect(loadBenchmarkScenario(scenarioPath)).toEqual({
			containerId: "container-1",
			evidencePath,
		});
		await writeFile(scenarioPath, "{}\n", { mode: 0o644 });
		await chmod(scenarioPath, 0o644);
		expect(() => loadBenchmarkScenario(scenarioPath)).toThrow(/owner-only/);
	});
});

describe("benchmark tool attestation", () => {
	it("freezes the active tool slate after conversion and proves ownership", async () => {
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		const setActiveTools = vi.fn();
		const allTools = [
			{
				name: "exec_command",
				sourceInfo: { path: "/package/benchmark/extensions/benchmark-tools.ts" },
			},
			{
				name: "write_stdin",
				sourceInfo: { path: "/package/benchmark/extensions/benchmark-tools.ts" },
			},
			{
				name: "apply_patch",
				sourceInfo: { path: "/package/benchmark/extensions/benchmark-tools.ts" },
			},
			{
				name: "prewalk_todo",
				sourceInfo: { path: "/package/extensions/prewalk.ts" },
			},
		];
		const pi = {
			on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
				handlers.set(name, handler);
			}),
			setActiveTools,
			getActiveTools: vi.fn(() => [
				"exec_command",
				"write_stdin",
				"apply_patch",
				"prewalk_todo",
			]),
			getAllTools: vi.fn(() => allTools),
		};
		await benchmarkAttestation(pi as never);
		await handlers.get("session_start")?.({}, {});
		expect(setActiveTools).toHaveBeenCalledWith([
			"exec_command",
			"write_stdin",
			"apply_patch",
			"prewalk_todo",
		]);
		expect(() => handlers.get("before_agent_start")?.({}, {})).not.toThrow();
	});
});
