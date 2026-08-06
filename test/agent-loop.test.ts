import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type ToolCall,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import prewalkExtension from "../extensions/prewalk.js";
import { AnalyticsStore } from "../src/analytics-store.js";
import { DEFAULT_EXECUTOR, EXECUTOR_MODEL_ID, PLANNER_MODEL_ID } from "../src/core.js";
import { PREWALK_TODO_TOOL_NAME } from "../src/todo.js";

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

function usage(cost: number, input = 10, output = 5): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: {
			input: cost / 2,
			output: cost / 2,
			cacheRead: 0,
			cacheWrite: 0,
			total: cost,
		},
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
		usage: usage(2),
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
	await writeFile(
		path.join(agentDir, "prewalk.json"),
		`${JSON.stringify({
			executor: DEFAULT_EXECUTOR,
		})}\n`,
	);
	await writeFile(
		path.join(agentDir, "settings.json"),
		`${JSON.stringify({ compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 0 } })}\n`,
	);
	await writeFile(path.join(workDir, "target.txt"), "before\n");
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
	delete process.env.PI_CODING_AGENT_DIR;
	await rm(root, { recursive: true, force: true });
});

describe("stock Pi Agent-loop integration", () => {
	it("keeps one stock-Pi route and receipt active through manual compaction and shutdown", async () => {
		const planner = model(PLANNER_MODEL_ID);
		const executor = model(EXECUTOR_MODEL_ID);
		const calls: string[] = [];
		let lunaContext: Context | undefined;
		const compactionReasons: string[] = [];
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
						return response(planner, [
							toolCall("todo-1", PREWALK_TODO_TOOL_NAME, {
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
						toolCall("todo-done-1", PREWALK_TODO_TOOL_NAME, {
							op: "done",
							task: "Make the first mutation",
						}),
					]);
				},
			});
		};
		const compactionFixture: ExtensionFactory = (pi) => {
			pi.on("session_before_compact", (event) => ({
				compaction: {
					summary: "Deterministic stock-Pi compaction summary.",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: usage(0.2, 2, 1),
				},
			}));
			pi.on("session_compact", (event) => {
				compactionReasons.push(event.reason);
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
				{ name: "compaction-fixture", factory: compactionFixture },
			],
		});
		await loader.reload();
		expect(
			loader.getExtensions().extensions,
			JSON.stringify(loader.getExtensions(), null, 2),
		).toHaveLength(3);
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

		await session.prompt("/prewalk run");
		await session.waitForIdle();
		await session.prompt("Implement the requested change.");
		await session.waitForIdle();

		expect(calls, JSON.stringify(sessionManager.getEntries(), null, 2)).toEqual([
			PLANNER_MODEL_ID,
			PLANNER_MODEL_ID,
			EXECUTOR_MODEL_ID,
		]);
		expect(session.model?.id).toBe(PLANNER_MODEL_ID);
		expect(await readFile(path.join(workDir, "target.txt"), "utf8")).toBe("after\n");
		const analyticsStore = new AnalyticsStore(agentDir);

		await session.extensionRunner.emitToolResult({
			type: "tool_result",
			toolCallId: "auxiliary-usage",
			toolName: "subagent-helper",
			input: {},
			content: [{ type: "text", text: "done" }],
			isError: false,
			details: undefined,
			usage: usage(0.3, 3, 2),
		});
		await session.compact();
		expect(compactionReasons).toEqual(["manual"]);
		await session.prompt("Continue after compaction.");
		await session.waitForIdle();
		expect(calls.at(-1)).toBe(EXECUTOR_MODEL_ID);

		const rootSessionId = session.sessionId;
		await session.extensionRunner.emit({
			type: "tool_execution_start",
			toolCallId: "tool-direct",
			toolName: "subagent",
			args: { agent: "worker", task: "delegate" },
		});
		await session.extensionRunner.emitToolResult({
			type: "tool_result",
			toolCallId: "tool-direct",
			toolName: "subagent",
			input: { agent: "worker", task: "delegate" },
			content: [{ type: "text", text: "done" }],
			isError: false,
			details: {
				runId: "delegation-direct",
				results: [
					{
						agent: "worker",
						exitCode: 0,
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0.1,
							turns: 1,
						},
						children: [
							{
								id: "delegation-nested",
								state: "complete",
								totalTokens: { input: 2, output: 1, total: 3 },
								totalCost: { inputTokens: 2, outputTokens: 1, costUsd: 0.03 },
							},
						],
					},
				],
			},
		});
		await session.extensionRunner.emit({
			type: "tool_execution_start",
			toolCallId: "tool-pending",
			toolName: "subagent",
			args: { agent: "worker", task: "async", async: true },
		});
		await session.extensionRunner.emitToolResult({
			type: "tool_result",
			toolCallId: "tool-pending",
			toolName: "subagent",
			input: { agent: "worker", task: "async", async: true },
			content: [{ type: "text", text: "started" }],
			isError: false,
			details: { asyncId: "delegation-pending", results: [] },
		});
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		const projected = await analyticsStore.listDelegationEvidence();
		expect(projected).toHaveLength(3);
		expect(projected.every((item) => item.parentSessionId === rootSessionId)).toBe(true);
		const taskTree = await analyticsStore.taskTree(rootSessionId);
		expect(taskTree.unresolved).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ delegationRunId: "delegation-pending", reason: "pending" }),
				expect.objectContaining({
					delegationRunId: "delegation-nested",
					reason: "partial-token-breakdown",
				}),
			]),
		);
		expect(taskTree.fallbackEvidence).toHaveLength(2);
		expect(taskTree.fallbackEvidence[0]?.delegationRunId).toBe("delegation-direct");
		expect(taskTree.rootActualCost).toBe(8.5);
		expect(taskTree.directChildActualCost).toBe(0.1);
		expect(taskTree.nestedChildActualCost).toBe(0.03);
		expect(taskTree.knownTaskTreeActualCost).toBeCloseTo(8.63);
		expect(taskTree.reportedChildCount).toBe(2);
		expect(taskTree.expectedChildCount).toBe(3);
		expect(taskTree.costCoverage).toBe("pending");
		expect(taskTree.tokenCoverage).toBe("pending");
		const command = session.extensionRunner.getCommand("prewalk");
		if (!command) throw new Error("Prewalk command was not registered.");
		await command.handler("stats task", session.extensionRunner.createCommandContext());
		expect(await analyticsStore.listUnfinishedJournals()).toEqual([]);
		const receipts = await analyticsStore.listReceipts();
		expect(receipts).toHaveLength(1);
		const [rootReceipt] = receipts;
		expect(rootReceipt).toEqual(
			expect.objectContaining({
				sessionId: rootSessionId,
				outcome: "session-ended",
				actualCost: 8.5,
			}),
		);
		expect(rootReceipt?.usage).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "planner-primary" }),
				expect.objectContaining({ role: "executor-primary" }),
			]),
		);
		expect(rootReceipt?.usage).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "auxiliary" }),
				expect.objectContaining({ role: "compaction" }),
			]),
		);
		session.dispose();
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

	it("launches automatic assessment and its one continuation through Pi's public runtime", async () => {
		const planner = model(PLANNER_MODEL_ID);
		const executor = model(EXECUTOR_MODEL_ID);
		const calls: string[] = [];
		const conversion: ExtensionFactory = (pi) => {
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
				models: [planner, executor],
				streamSimple: (selected) => {
					calls.push(selected.id);
					const solCall = calls.filter((id) => id === PLANNER_MODEL_ID).length;
					if (solCall === 1) {
						return response(planner, [
							toolCall("assessment-1", "prewalk_assess", { decision: "continue" }),
						]);
					}
					if (solCall === 2) {
						return response(planner, [
							toolCall("todo-1", PREWALK_TODO_TOOL_NAME, {
								op: "init",
								list: [{ phase: "Implement", items: ["Finish the task"] }],
							}),
						]);
					}
					return response(planner, [{ type: "text", text: "Continuation complete." }]);
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
		const runtime = await ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"),
			modelsPath: null,
		});
		const { session } = await createAgentSession({
			cwd: workDir,
			agentDir,
			modelRuntime: runtime,
			model: planner,
			resourceLoader: loader,
			settingsManager: settings,
			sessionManager: SessionManager.inMemory(workDir),
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
		await session.bindExtensions({});
		await session.prompt("/prewalk auto");
		await session.waitForIdle();
		await session.prompt("Build an end-to-end feature across multiple concerns.");
		await session.waitForIdle();

		expect(calls).toEqual([PLANNER_MODEL_ID, PLANNER_MODEL_ID, PLANNER_MODEL_ID]);
		session.dispose();
	});

	it("preserves a real public subagent launch before its child provider boundary", async () => {
		const planner = model(PLANNER_MODEL_ID);
		const executor = model(EXECUTOR_MODEL_ID);
		const providerCalls: string[] = [];
		const executedInputs: Array<Record<string, unknown>> = [];
		const provider: ExtensionFactory = (pi) => {
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
				models: [planner, executor],
				streamSimple: (selected) => {
					providerCalls.push(selected.id);
					return providerCalls.length === 1
						? response(planner, [
								toolCall("subagent-1", "subagent", {
									agent: "reviewer",
									task: "Review without an explicit profile",
								}),
							])
						: response(planner, [{ type: "text", text: "Delegation complete." }]);
				},
			});
		};
		const subagentTool: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "subagent",
				label: "Subagent fixture",
				description: "Capture the effective public launch arguments.",
				parameters: Type.Object({
					agent: Type.String(),
					task: Type.String(),
					model: Type.Optional(Type.String()),
					thinking: Type.Optional(Type.String()),
				}),
				execute: async (_toolCallId, params) => {
					executedInputs.push(structuredClone(params));
					return {
						content: [{ type: "text", text: "captured" }],
						details: {
							runId: "fixture-run",
							results: [
								{
									agent: params.agent,
									exitCode: 0,
									usage: {
										input: 0,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										cost: 0,
										turns: 0,
									},
								},
							],
						},
					};
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
				{ name: "provider", factory: provider },
				{ name: "subagent-fixture", factory: subagentTool },
				{ name: "prewalk", factory: prewalkExtension },
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
			model: planner,
			thinkingLevel: "high",
			resourceLoader: loader,
			settingsManager: settings,
			sessionManager: SessionManager.inMemory(workDir),
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
		await session.bindExtensions({});

		await session.prompt("/prewalk run");
		await session.waitForIdle();
		await session.prompt("Delegate the review.");
		await session.waitForIdle();

		expect(executedInputs).toEqual([
			{
				agent: "reviewer",
				task: "Review without an explicit profile",
			},
		]);
		expect(providerCalls).toEqual([PLANNER_MODEL_ID, PLANNER_MODEL_ID]);
		session.dispose();
	});
});
