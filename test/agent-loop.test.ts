import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type ToolCall,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import prewalkExtension from "../extensions/prewalk.js";
import { EXECUTOR_MODEL_ID, PLANNER_MODEL_ID } from "../src/core.js";

function model(id: string): Model<"openai-codex-responses"> {
	return {
		id,
		name: id,
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

function response(selected: Model<"openai-codex-responses">, content: AssistantMessage["content"]) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content,
		api: selected.api,
		provider: selected.provider,
		model: selected.id,
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

function toolCall(id: string, name: string, argumentsValue: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id, name, arguments: argumentsValue };
}

let root: string;
let agentDir: string;
let workDir: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "prewalk-agent-loop-"));
	agentDir = path.join(root, "agent");
	workDir = path.join(root, "work");
	await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(workDir, { recursive: true })]);
	await writeFile(path.join(agentDir, "prewalk.json"), '{"enabled":true}\n');
	await writeFile(path.join(workDir, "target.txt"), "before\n");
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
	delete process.env.PI_CODING_AGENT_DIR;
	await rm(root, { recursive: true, force: true });
});

describe("stock Pi Agent-loop integration", () => {
	it("runs Sol planning through one mutation and continues as Luna without selecting Luna", async () => {
		const planner = model(PLANNER_MODEL_ID);
		const executor = model(EXECUTOR_MODEL_ID);
		const calls: string[] = [];
		let lunaContext: Context | undefined;
		const conversion: ExtensionFactory = (pi) => {
			pi.registerProvider("openai-codex", {
				api: "openai-codex-responses",
				baseUrl: "https://example.test",
				apiKey: "integration-token",
				oauth: {
					name: "OpenAI Codex",
					login: async () => ({
						access: "token",
						refresh: "refresh",
						expires: 1,
					}),
					refreshToken: async (credentials) => credentials,
					getApiKey: (credentials) => credentials.access,
				},
				models: [planner, executor],
				streamSimple: (selected, context) => {
					calls.push(selected.id);
					if (selected.id === EXECUTOR_MODEL_ID) {
						lunaContext = context;
						return response(executor, [{ type: "text", text: "Luna completed." }]);
					}
					const solCall = calls.filter((id) => id === PLANNER_MODEL_ID).length;
					if (solCall === 1) {
						return response(planner, [{ type: "text", text: "I will inspect first." }]);
					}
					if (solCall === 2) {
						return response(planner, [
							toolCall("todo-1", "todo", {
								op: "init",
								list: [
									{
										phase: "Implement",
										items: ["Make the first mutation"],
									},
								],
							}),
						]);
					}
					return response(planner, [
						toolCall("edit-1", "edit", {
							path: path.join(workDir, "target.txt"),
							oldText: "before",
							newText: "after",
						}),
					]);
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
				{ name: "conversion", factory: conversion },
				{ name: "prewalk", factory: prewalkExtension },
			],
		});
		await loader.reload();
		expect(
			loader.getExtensions().extensions,
			JSON.stringify(loader.getExtensions(), null, 2),
		).toHaveLength(2);
		const runtime = await ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"),
			modelsPath: null,
		});
		const sessionManager = SessionManager.inMemory(workDir);
		const { session } = await createAgentSession({
			cwd: workDir,
			agentDir,
			modelRuntime: runtime,
			model: planner,
			thinkingLevel: "high",
			resourceLoader: loader,
			settingsManager: settings,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
		await session.bindExtensions({});

		await session.prompt("Implement the requested change.");
		await session.waitForIdle();

		expect(calls, JSON.stringify(sessionManager.getEntries(), null, 2)).toEqual([
			PLANNER_MODEL_ID,
			PLANNER_MODEL_ID,
			PLANNER_MODEL_ID,
			EXECUTOR_MODEL_ID,
			EXECUTOR_MODEL_ID,
		]);
		expect(session.model?.id).toBe(PLANNER_MODEL_ID);
		expect(await readFile(path.join(workDir, "target.txt"), "utf8")).toBe("after\n");
		const assistantModels = sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "assistant"
					? [entry.message.model]
					: [],
			);
		expect(assistantModels.at(-1)).toBe(EXECUTOR_MODEL_ID);
		const [checklistPrompt, planPrompt, continuePrompt] = await Promise.all([
			readFile(new URL("../prompts/prewalk-checklist.md", import.meta.url), "utf8"),
			readFile(new URL("../prompts/prewalk-plan.md", import.meta.url), "utf8"),
			readFile(new URL("../prompts/prewalk-continue.md", import.meta.url), "utf8"),
		]);
		const lunaContextText = JSON.stringify(lunaContext);
		expect(lunaContextText).toContain(JSON.stringify(checklistPrompt).slice(1, -1));
		expect(lunaContextText).not.toContain(JSON.stringify(planPrompt).slice(1, -1));
		expect(lunaContextText).not.toContain(JSON.stringify(continuePrompt).slice(1, -1));
	});
});
