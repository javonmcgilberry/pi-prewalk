import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBenchmarkRuntime } from "../scripts/benchmark-runtime.mjs";

let root: string | undefined;

afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

const task = {
	id: "task-1",
	repository: "https://github.com/example/project",
	revision: "a".repeat(40),
	sourceDigest: "f".repeat(64),
	prompt: "Fix the task.",
	testCommand: "npm test",
	timeoutSeconds: 600,
	workerImage: `ghcr.io/example/worker@sha256:${"b".repeat(64)}`,
	evaluatorImage: `ghcr.io/example/evaluator@sha256:${"c".repeat(64)}`,
};

function assistant(model: string) {
	return {
		role: "assistant",
		provider: "openai-codex",
		model,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { total: 2 },
		},
	};
}

describe("trusted Pi benchmark runtime", () => {
	it("preflights the frozen Pi, conversion, worker, and evaluator versions", async () => {
		root = await mkdtemp(path.join(tmpdir(), "prewalk-runtime-preflight-"));
		const authFile = path.join(root, "auth.json");
		const piExecutable = path.join(root, "pi.mjs");
		await writeFile(authFile, "{}\n", { mode: 0o600 });
		await writeFile(piExecutable, 'console.log("0.82.1");\n', { mode: 0o700 });
		const sandbox = {
			assertImage: vi.fn(async () => {}),
			createWorker: vi.fn(),
			request: vi.fn(),
			destroy: vi.fn(),
			evaluate: vi.fn(),
			cleanup: vi.fn(async () => {}),
		};
		const runtime = createBenchmarkRuntime({
			authFile,
			piExecutable,
			sandbox,
			temporaryParent: root,
		});
		await runtime.preflight({ tasks: [task] });
		expect(sandbox.assertImage).toHaveBeenNthCalledWith(1, task.workerImage, {
			task,
			role: "worker",
		});
		expect(sandbox.assertImage).toHaveBeenNthCalledWith(2, task.evaluatorImage, {
			task,
			role: "evaluator",
		});
	});

	it.each([
		["sol", "openai-codex/gpt-5.6-sol", ["gpt-5.6-sol"]],
		["luna", "openai-codex/gpt-5.6-luna", ["gpt-5.6-luna"]],
		["prewalk", "openai-codex/gpt-5.6-sol", ["gpt-5.6-sol", "gpt-5.6-luna"]],
	])("runs %s with the frozen model and extension topology", async (arm, selected, models) => {
		root = await mkdtemp(path.join(tmpdir(), "prewalk-runtime-"));
		const authFile = path.join(root, "auth.json");
		await writeFile(
			authFile,
			`${JSON.stringify({
				"openai-codex": {
					type: "oauth",
					access: "access",
					refresh: "refresh",
					expires: Date.now() + 60_000,
				},
			})}\n`,
			{ mode: 0o600 },
		);
		const sandbox = {
			assertImage: vi.fn(async () => {}),
			createWorker: vi.fn(async () => ({ containerId: "container-1", role: "worker" })),
			request: vi.fn(async () => ({
				ok: true,
				patchBase64: Buffer.from("patch").toString("base64"),
				patchDigest: "d".repeat(64),
				workspaceDigest: "f".repeat(64),
			})),
			destroy: vi.fn(async () => {}),
			evaluate: vi.fn(async () => ({
				ok: true,
				outcome: "passed" as const,
				elapsedMs: 10,
				evaluatorDigest: "e".repeat(64),
			})),
			cleanup: vi.fn(async () => {}),
		};
		const launches: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
		const rpcFactory = vi.fn((options) => {
			launches.push(options);
			return {
				events: [],
				stderr: "",
				send: vi.fn(async (command) => {
					if (command.type === "get_messages") {
						return { data: { messages: models.map(assistant) } };
					}
					if (command.type === "get_state") {
						const [provider, id] = selected.split("/");
						return { data: { model: { provider, id } } };
					}
					return { data: {} };
				}),
				waitFor: vi.fn(async () => ({ type: "agent_settled" })),
				close: vi.fn(async () => {}),
			};
		});
		const runtime = createBenchmarkRuntime({
			authFile,
			piExecutable: "/usr/local/bin/pi",
			sandbox,
			rpcFactory,
			temporaryParent: root,
		});
		const result = await runtime.run({
			task,
			arm,
			run: { runId: `run-${arm}` },
		});

		expect(result).toMatchObject({
			outcome: "passed",
			cost: models.length * 2,
			lookupAttempts: 0,
			sandboxViolations: 0,
			patchDigest: "d".repeat(64),
			evaluatorDigest: "e".repeat(64),
		});
		expect(launches[0].args).toContain("--no-builtin-tools");
		expect(launches[0].args).toEqual(expect.arrayContaining(["--model", selected]));
		const extensionPaths = launches[0].args
			.map((value, index, values) => (values[index - 1] === "-e" ? value : undefined))
			.filter(Boolean);
		expect(extensionPaths.map((value) => path.basename(value ?? ""))).toEqual([
			"benchmark-tools.ts",
			"index.js",
			"prewalk.ts",
			"benchmark-attestation.ts",
		]);
		expect(Object.keys(launches[0].env).sort()).toEqual(
			[
				"HOME",
				"NO_COLOR",
				"PATH",
				"PI_CODING_AGENT_DIR",
				"PREWALK_BENCHMARK_SCENARIO",
				"TMPDIR",
			].sort(),
		);
		expect(sandbox.destroy).toHaveBeenCalledBefore(sandbox.evaluate);
	});

	it("destroys the worker and returns invalid evidence after a provider failure", async () => {
		root = await mkdtemp(path.join(tmpdir(), "prewalk-runtime-failure-"));
		const authFile = path.join(root, "auth.json");
		await writeFile(
			authFile,
			'{"openai-codex":{"type":"oauth","access":"a","refresh":"r","expires":1}}\n',
			{ mode: 0o600 },
		);
		const sandbox = {
			assertImage: vi.fn(async () => {}),
			createWorker: vi.fn(async () => ({ containerId: "container-1", role: "worker" })),
			request: vi.fn(async () => ({
				ok: true,
				patchBase64: "",
				patchDigest: "d".repeat(64),
				workspaceDigest: "f".repeat(64),
			})),
			destroy: vi.fn(async () => {}),
			evaluate: vi.fn(async () => ({
				ok: true,
				outcome: "failed" as const,
				elapsedMs: 1,
				evaluatorDigest: "e".repeat(64),
			})),
			cleanup: vi.fn(async () => {}),
		};
		const runtime = createBenchmarkRuntime({
			authFile,
			piExecutable: "/usr/local/bin/pi",
			sandbox,
			rpcFactory: () => ({
				events: [],
				stderr: "",
				send: vi.fn(async () => {
					throw new Error("provider secret");
				}),
				waitFor: vi.fn(async () => {
					throw new Error("provider secret");
				}),
				close: vi.fn(async () => {}),
			}),
			temporaryParent: root,
		});
		const result = await runtime.run({
			task,
			arm: "sol",
			run: { runId: "run-failure" },
		});
		expect(result.outcome).toBe("invalid");
		expect(JSON.stringify(result)).not.toContain("provider secret");
		expect(sandbox.destroy).toHaveBeenCalled();
	});
});
