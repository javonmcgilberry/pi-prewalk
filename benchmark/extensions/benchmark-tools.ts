import { spawn } from "node:child_process";
import { appendFile, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
	defineTool,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CONTAINER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const MAX_RESPONSE_BYTES = 1_000_000;
const WORKER_BRIDGE = "/opt/prewalk-worker/bridge.mjs";

interface BenchmarkScenario {
	containerId: string;
	evidencePath: string;
}

interface WorkerResponse {
	ok: boolean;
	code?: string;
	output?: string;
	exitCode?: number;
	truncated?: boolean;
	lookupAttempts?: number;
	sandboxViolations?: number;
}

type WorkerRequest = (
	request: Record<string, unknown>,
	options?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<WorkerResponse>;

function ownerOnlyRegularFile(filePath: string, label: string): void {
	const info = lstatSync(filePath);
	if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
		throw new Error(`${label} must be an owner-only regular file.`);
	}
	if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
		throw new Error(`${label} must be owned by the current user.`);
	}
}

export function loadBenchmarkScenario(filePath: string): BenchmarkScenario {
	if (!path.isAbsolute(filePath)) {
		throw new Error("Benchmark scenario path must be absolute.");
	}
	ownerOnlyRegularFile(filePath, "Benchmark scenario");
	const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
	if (
		!value ||
		typeof value !== "object" ||
		!("containerId" in value) ||
		!("evidencePath" in value) ||
		typeof value.containerId !== "string" ||
		!CONTAINER_ID.test(value.containerId) ||
		typeof value.evidencePath !== "string" ||
		!path.isAbsolute(value.evidencePath) ||
		Object.keys(value).some((key) => key !== "containerId" && key !== "evidencePath")
	) {
		throw new Error("Benchmark scenario is invalid.");
	}
	ownerOnlyRegularFile(value.evidencePath, "Benchmark evidence");
	return { containerId: value.containerId, evidencePath: value.evidencePath };
}

export function createDockerWorkerRequest(
	containerId: string,
	spawnDocker: typeof spawn = spawn,
): WorkerRequest {
	return async (request, { signal, timeoutMs = 600_000 } = {}) =>
		await new Promise((resolve, reject) => {
			const child = spawnDocker(
				"docker",
				["exec", "--interactive", containerId, "node", WORKER_BRIDGE],
				{ stdio: ["pipe", "pipe", "ignore"] },
			);
			const chunks: Buffer[] = [];
			let bytes = 0;
			let terminalError: Error | undefined;
			const stop = (error: Error) => {
				if (terminalError) return;
				terminalError = error;
				child.kill("SIGKILL");
			};
			const abort = () => stop(new Error("Benchmark worker request aborted."));
			const timer = setTimeout(
				() => stop(new Error("Benchmark worker request timed out.")),
				timeoutMs,
			);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			child.stdout.on("data", (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > MAX_RESPONSE_BYTES) {
					stop(new Error("Benchmark worker response exceeded the limit."));
					return;
				}
				chunks.push(chunk);
			});
			child.once("error", (error) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				reject(error);
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				if (terminalError) {
					reject(terminalError);
					return;
				}
				if (code !== 0) {
					reject(new Error("Benchmark worker request failed."));
					return;
				}
				let value: unknown;
				try {
					value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				} catch {
					reject(new Error("Benchmark worker returned invalid JSON."));
					return;
				}
				if (
					!value ||
					typeof value !== "object" ||
					!("ok" in value) ||
					typeof value.ok !== "boolean"
				) {
					reject(new Error("Benchmark worker returned an invalid response."));
					return;
				}
				resolve({
					ok: value.ok,
					...("code" in value && typeof value.code === "string" ? { code: value.code } : {}),
					...("output" in value && typeof value.output === "string"
						? { output: value.output }
						: {}),
					...("exitCode" in value && typeof value.exitCode === "number"
						? { exitCode: value.exitCode }
						: {}),
					...("truncated" in value && typeof value.truncated === "boolean"
						? { truncated: value.truncated }
						: {}),
					...("lookupAttempts" in value && typeof value.lookupAttempts === "number"
						? { lookupAttempts: value.lookupAttempts }
						: {}),
					...("sandboxViolations" in value && typeof value.sandboxViolations === "number"
						? { sandboxViolations: value.sandboxViolations }
						: {}),
				});
			});
			child.stdin.end(JSON.stringify(request));
		});
}

async function recordSafety(
	evidencePath: string | undefined,
	lookupAttempts: number,
	sandboxViolations: number,
): Promise<void> {
	if (!evidencePath) return;
	if (
		!Number.isInteger(lookupAttempts) ||
		lookupAttempts < 0 ||
		!Number.isInteger(sandboxViolations) ||
		sandboxViolations < 0
	) {
		throw new Error("Benchmark worker returned invalid safety counters.");
	}
	await new Promise<void>((resolve, reject) => {
		appendFile(
			evidencePath,
			`${JSON.stringify({ lookupAttempts, sandboxViolations })}\n`,
			{ encoding: "utf8", mode: 0o600 },
			(error) => {
				if (error) reject(error);
				else resolve();
			},
		);
	});
}

async function checkedRequest(
	request: WorkerRequest,
	evidencePath: string | undefined,
	value: Record<string, unknown>,
	options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<WorkerResponse> {
	const response = await request(value, options);
	const lookupAttempts = response.lookupAttempts ?? 0;
	const sandboxViolations = response.sandboxViolations ?? 0;
	await recordSafety(evidencePath, lookupAttempts, sandboxViolations);
	if (!response.ok) {
		throw new Error(
			`Benchmark worker rejected the tool call: ${response.code ?? "worker-failed"}.`,
		);
	}
	return response;
}

const ExecCommandParameters = Type.Object(
	{
		cmd: Type.String({ description: "Raw shell command to run inside the task worker." }),
		workdir: Type.Optional(Type.String({ description: "Must be /workspace when provided." })),
		shell: Type.Optional(Type.String()),
		tty: Type.Optional(Type.Boolean()),
		yield_time_ms: Type.Optional(Type.Number()),
		max_output_tokens: Type.Optional(Type.Number()),
		login: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

const WriteStdinParameters = Type.Object(
	{
		session_id: Type.Number(),
		chars: Type.Optional(Type.String()),
		yield_time_ms: Type.Optional(Type.Number()),
		max_output_tokens: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

const ApplyPatchParameters = Type.Object(
	{
		input: Type.String({
			description:
				"Full patch text using *** Begin Patch / *** End Patch and Add, Update, or Delete File sections.",
		}),
	},
	{ additionalProperties: false },
);

export function createBenchmarkToolDefinitions(
	request: WorkerRequest,
	evidencePath?: string,
): ToolDefinition[] {
	const execCommand = defineTool({
		name: "exec_command",
		label: "exec_command",
		description: "Run a shell command in the isolated benchmark task worker.",
		promptSnippet: "Run command",
		parameters: ExecCommandParameters,
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("exec_command aborted.");
			if (
				params.workdir !== undefined &&
				params.workdir !== "." &&
				params.workdir !== "/workspace"
			) {
				await recordSafety(evidencePath, 0, 1);
				throw new Error("Benchmark commands must run in /workspace.");
			}
			const started = Date.now();
			const response = await checkedRequest(
				request,
				evidencePath,
				{
					method: "exec_command",
					cmd: params.cmd,
					timeoutMs: 600_000,
				},
				{ signal, timeoutMs: 600_000 },
			);
			const details = {
				output: response.output ?? "",
				exit_code: response.exitCode ?? 0,
				wall_time_seconds: (Date.now() - started) / 1000,
				truncated: response.truncated ?? false,
			};
			return {
				content: [{ type: "text", text: details.output }],
				details,
			};
		},
	});

	const writeStdin = defineTool({
		name: "write_stdin",
		label: "write_stdin",
		description: "Poll a benchmark command session. Commands normally run to completion.",
		promptSnippet: "Poll command",
		parameters: WriteStdinParameters,
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("write_stdin aborted.");
			const response = await checkedRequest(
				request,
				evidencePath,
				{
					method: "write_stdin",
					sessionId: params.session_id,
					chars: params.chars ?? "",
				},
				{ signal, timeoutMs: 60_000 },
			);
			const details = {
				output: response.output ?? "",
				exit_code: response.exitCode ?? 1,
			};
			return { content: [{ type: "text", text: details.output }], details };
		},
	});

	const applyPatch = defineTool({
		name: "apply_patch",
		label: "apply_patch",
		description: "Patch files in the isolated benchmark task worker.",
		promptSnippet: "Edit files with patch",
		executionMode: "sequential",
		parameters: ApplyPatchParameters,
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("apply_patch aborted.");
			const response = await checkedRequest(
				request,
				evidencePath,
				{
					method: "apply_patch",
					input: params.input,
				},
				{ signal, timeoutMs: 60_000 },
			);
			return {
				content: [{ type: "text", text: response.output ?? "Applied patch successfully." }],
				details: {
					status: "success",
					result: {
						changedFiles: [],
						createdFiles: [],
						deletedFiles: [],
						movedFiles: [],
						fuzz: 0,
					},
				},
			};
		},
	});

	return [execCommand, writeStdin, applyPatch];
}

export default function benchmarkTools(pi: ExtensionAPI): void {
	const scenarioPath = process.env.PREWALK_BENCHMARK_SCENARIO;
	if (!scenarioPath) throw new Error("PREWALK_BENCHMARK_SCENARIO is required.");
	const scenario = loadBenchmarkScenario(scenarioPath);
	for (const tool of createBenchmarkToolDefinitions(
		createDockerWorkerRequest(scenario.containerId),
		scenario.evidencePath,
	)) {
		pi.registerTool(tool);
	}
}
