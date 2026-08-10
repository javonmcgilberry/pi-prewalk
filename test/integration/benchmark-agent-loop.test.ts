import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import benchmarkAttestation from "../../benchmark/extensions/benchmark-attestation.js";
import { createBenchmarkToolDefinitions } from "../../benchmark/extensions/benchmark-tools.js";
import prewalkExtension from "../../extensions/prewalk.js";
import { PLANNER_MODEL_ID } from "../../src/orchestration/coordinator.js";

function model(): Model<"openai-codex-responses"> {
	return {
		id: PLANNER_MODEL_ID,
		name: PLANNER_MODEL_ID,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 128_000,
	};
}

function response(content: AssistantMessage["content"]) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content,
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: PLANNER_MODEL_ID,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
		},
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({
			type: "done",
			reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
			message,
		});
		stream.end();
	});
	return stream;
}

let root: string;
let agentDir: string;
let workDir: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "prewalk-benchmark-loop-"));
	agentDir = path.join(root, "agent");
	workDir = path.join(root, "work");
	await Promise.all([mkdir(agentDir), mkdir(workDir)]);
	await writeFile(path.join(agentDir, "prewalk.json"), '{"enabled":false}\n');
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
	delete process.env.PI_CODING_AGENT_DIR;
	await rm(root, { recursive: true, force: true });
});

describe("benchmark real Pi Agent loop", () => {
	it("uses the first registered remote tool and never calls conversion's host duplicate", async () => {
		const remoteRequest = vi.fn(async () => ({
			ok: true,
			code: "ok",
			output: "remote worker\n",
			exitCode: 0,
			lookupAttempts: 0,
			sandboxViolations: 0,
		}));
		const hostCalled = vi.fn();
		let providerCall = 0;
		const remoteTools: ExtensionFactory = (pi) => {
			for (const tool of createBenchmarkToolDefinitions(remoteRequest)) pi.registerTool(tool);
		};
		const conversion: ExtensionFactory = (pi) => {
			for (const name of ["exec_command", "write_stdin", "apply_patch"]) {
				pi.registerTool(
					defineTool({
						name,
						label: name,
						description: "host duplicate",
						parameters: Type.Object({}),
						async execute() {
							hostCalled(name);
							return { content: [{ type: "text", text: "host" }], details: {} };
						},
					}),
				);
			}
			pi.registerProvider("openai-codex", {
				api: "openai-codex-responses",
				baseUrl: "https://example.test",
				apiKey: "integration-token",
				oauth: {
					name: "OpenAI Codex",
					login: async () => ({ access: "token", refresh: "refresh", expires: 1 }),
					refreshToken: async (credentials) => credentials,
					getApiKey: (credentials) => credentials.access,
				},
				models: [model()],
				streamSimple: () => {
					providerCall += 1;
					return providerCall === 1
						? response([
								{
									type: "toolCall",
									id: "remote-1",
									name: "exec_command",
									arguments: { cmd: "git status --short" },
								},
							])
						: response([{ type: "text", text: "done" }]);
				},
			});
		};
		const settings = SettingsManager.create(workDir, agentDir);
		const loader = new DefaultResourceLoader({
			cwd: workDir,
			agentDir,
			settingsManager: settings,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				{ name: "benchmark-tools", factory: remoteTools },
				{ name: "conversion", factory: conversion },
				{ name: "prewalk", factory: prewalkExtension },
				{ name: "benchmark-attestation", factory: benchmarkAttestation },
			],
		});
		await loader.reload();
		const runtime = await ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"),
			modelsPath: null,
		});
		const { session } = await createAgentSession({
			cwd: workDir,
			agentDir,
			modelRuntime: runtime,
			model: model(),
			thinkingLevel: "high",
			resourceLoader: loader,
			settingsManager: settings,
			sessionManager: SessionManager.inMemory(workDir),
			sessionStartEvent: { type: "session_start", reason: "startup" },
			noTools: "builtin",
		});
		await session.bindExtensions({});
		await session.prompt("Inspect the task.");
		await session.waitForIdle();

		expect(remoteRequest).toHaveBeenCalledWith(
			{
				method: "exec_command",
				cmd: "git status --short",
				timeoutMs: 600_000,
			},
			{ signal: expect.anything(), timeoutMs: 600_000 },
		);
		expect(hostCalled).not.toHaveBeenCalled();
		expect(session.getActiveToolNames()).toEqual([
			"exec_command",
			"write_stdin",
			"apply_patch",
			"prewalk_todo",
		]);
	});
});
