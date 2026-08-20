import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
	type Api,
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
import prewalkExtension from "../../extensions/prewalk.js";
import { AnalyticsStore } from "../../src/analytics/store.js";
import {
	DEFAULT_EXECUTOR,
	EXECUTOR_MODEL_ID,
	PLANNER_MODEL_ID,
	PREWALK_RECOVER_MESSAGE_TYPE,
} from "../../src/orchestration/coordinator.js";
import { PREWALK_TODO_TOOL_NAME } from "../../src/turn/todo.js";

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

function fixtureModel(id: string): Model<"openai-codex-responses"> {
	return { ...model(id), provider: "fixture", baseUrl: "https://fixture.invalid" };
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

function abortedResponse(selected: Model<"openai-codex-responses">) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "thinking",
				thinking: "preserved planning trace",
				thinkingSignature: '{"type":"reasoning","encrypted_content":"checkpoint"}',
			},
		],
		api: selected.api,
		provider: selected.provider,
		model: selected.id,
		usage: usage(0),
		stopReason: "aborted",
		errorMessage: "Operation aborted",
		timestamp: Date.now(),
	};
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "aborted", error: message });
		stream.end();
	});
	return stream;
}

function toolCall(id: string, name: string, argumentsValue: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id, name, arguments: argumentsValue };
}

function foreignModel<TApi extends "anthropic-messages" | "google-generative-ai">(
	api: TApi,
	provider: string,
	id: string,
	contextWindow: number,
): Model<TApi> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 64_000,
	};
}

/** Same shape as {@link response}, for a model on any API. */
function foreignResponse(selected: Model<Api>, content: AssistantMessage["content"]) {
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
	delete process.env.PI_PREWALK_CHILD_TRACE;
	delete process.env.PI_PREWALK_CHILD_WORKDIR;
	delete process.env.PI_SUBAGENT_PI_BINARY;
	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENT_CHILD_AGENT;
	delete process.env.PI_SUBAGENT_RUN_ID;
	restoreInheritedSubagentEnvironment?.();
	restoreInheritedSubagentEnvironment = undefined;
	await rm(root, { recursive: true, force: true });
});

const installedSubagentEntryCandidates = [
	process.env.PI_SUBAGENTS_ENTRY,
	path.join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents", "index.ts"),
].filter((entry): entry is string => Boolean(entry));
const installedSubagentEntry = installedSubagentEntryCandidates.find(existsSync);
const stockPiCli = path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
let restoreInheritedSubagentEnvironment: (() => void) | undefined;

function isolateTopLevelSubagentEnvironment(): () => void {
	const inherited = Object.entries(process.env).filter(([key]) => key.startsWith("PI_SUBAGENT_"));
	for (const [key] of inherited) delete process.env[key];
	return () => {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
		}
		for (const [key, value] of inherited) {
			if (value !== undefined) process.env[key] = value;
		}
	};
}

describe("stock Pi Agent-loop integration", () => {
	it("self-recovers an aborted planner and keeps one stock-Pi route through shutdown", async () => {
		const planner = model(PLANNER_MODEL_ID);
		const executor = model(EXECUTOR_MODEL_ID);
		const calls: string[] = [];
		let lunaContext: Context | undefined;
		let recoveryContext: Context | undefined;
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
						return abortedResponse(planner);
					}
					if (solCall === 2) {
						recoveryContext = context;
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
			PLANNER_MODEL_ID,
			EXECUTOR_MODEL_ID,
		]);
		const entries = JSON.stringify(sessionManager.getEntries());
		expect(entries).toContain("preserved planning trace");
		expect(entries).toContain(PREWALK_RECOVER_MESSAGE_TYPE);
		const recoveryMessages = JSON.stringify(recoveryContext?.messages);
		expect(recoveryMessages).toContain("preserved planning trace");
		expect(recoveryMessages).toContain("encrypted_content");
		expect(recoveryMessages).toContain("This is autonomous recovery");
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
			readFile(new URL("../../prompts/prewalk-checklist.md", import.meta.url), "utf8"),
			readFile(new URL("../../prompts/prewalk-plan.md", import.meta.url), "utf8"),
			readFile(new URL("../../prompts/prewalk-continue.md", import.meta.url), "utf8"),
		]);
		const lunaContextText = JSON.stringify(lunaContext);
		expect(lunaContextText).toContain(JSON.stringify(checklistPrompt).slice(1, -1));
		expect(lunaContextText).not.toContain(JSON.stringify(planPrompt).slice(1, -1));
		expect(lunaContextText).not.toContain(JSON.stringify(continuePrompt).slice(1, -1));
	});

	it("streams a cross-provider handoff through the executor's own provider", async () => {
		// anthropic-messages plans, google-generative-ai executes. Each provider
		// gets its own transport, so the executor turn appearing in googleCalls is
		// proof the request left through Google rather than through the planner's
		// Anthropic stream.
		const planner = foreignModel("anthropic-messages", "anthropic", "claude-opus-4-6", 1_000_000);
		const executor = foreignModel(
			"google-generative-ai",
			"google",
			"gemini-3.5-flash",
			1_048_576,
		);
		await writeFile(
			path.join(agentDir, "prewalk.json"),
			`${JSON.stringify({
				executor: { provider: "google", model: "gemini-3.5-flash", reasoning: "low" },
			})}\n`,
		);
		const anthropicCalls: string[] = [];
		const googleCalls: string[] = [];
		let executorContext: Context | undefined;

		const providers: ExtensionFactory = (pi) => {
			pi.registerProvider("anthropic", {
				api: "anthropic-messages",
				baseUrl: "https://example.test",
				apiKey: "planner-token",
				models: [planner],
				streamSimple: (selected) => {
					anthropicCalls.push(selected.id);
					const turn = anthropicCalls.length;
					if (turn === 1) {
						return foreignResponse(planner, [
							toolCall("todo-1", PREWALK_TODO_TOOL_NAME, {
								op: "init",
								list: [{ phase: "Implement", items: ["Make the first mutation"] }],
							}),
						]);
					}
					return foreignResponse(planner, [
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
			pi.registerProvider("google", {
				api: "google-generative-ai",
				baseUrl: "https://example.test",
				apiKey: "executor-token",
				models: [executor],
				streamSimple: (selected, context) => {
					googleCalls.push(selected.id);
					executorContext = context;
					return foreignResponse(executor, [{ type: "text", text: "Executor completed." }]);
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
				{ name: "providers", factory: providers },
				{ name: "prewalk", factory: prewalkExtension },
			],
		});
		await loader.reload();
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

		const trace = JSON.stringify(sessionManager.getEntries(), null, 2);
		expect(anthropicCalls, trace).toEqual(["claude-opus-4-6", "claude-opus-4-6"]);
		expect(googleCalls, trace).toEqual(["gemini-3.5-flash"]);
		// The overlay substitutes the executor without changing what Pi has selected.
		expect(session.model?.id).toBe("claude-opus-4-6");
		expect(await readFile(path.join(workDir, "target.txt"), "utf8")).toBe("after\n");
		// The executor received the planner's conversation, not a fresh one.
		expect((executorContext?.messages.length ?? 0) > 1).toBe(true);
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
		const sessionManager = SessionManager.inMemory(workDir);
		const { session } = await createAgentSession({
			cwd: workDir,
			agentDir,
			modelRuntime: runtime,
			model: planner,
			resourceLoader: loader,
			settingsManager: settings,
			sessionManager,
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

	it("settles an Autoresearch agent-end continuation around one manual Prewalk handoff", async () => {
		const planner = model(PLANNER_MODEL_ID);
		const executor = model(EXECUTOR_MODEL_ID);
		const autoresearchContinuation =
			"Continue the bounded Autoresearch experiment after recording the completed result.";
		const calls: Array<{ model: string; owner: "prewalk" | "autoresearch" }> = [];
		let prewalkPlannerCalls = 0;
		let autoresearchResumes = 0;
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
				streamSimple: (selected, context) => {
					const trailingMessage = JSON.stringify(context.messages.at(-1) ?? "");
					if (trailingMessage.includes(autoresearchContinuation)) {
						calls.push({ model: selected.id, owner: "autoresearch" });
						return response(selected as Model<"openai-codex-responses">, [
							{ type: "text", text: "Autoresearch continuation recorded." },
						]);
					}

					calls.push({ model: selected.id, owner: "prewalk" });
					if (selected.id === EXECUTOR_MODEL_ID) {
						return response(executor, [{ type: "text", text: "Executor completed." }]);
					}

					prewalkPlannerCalls += 1;
					if (prewalkPlannerCalls === 1) {
						return response(planner, [
							toolCall("todo-1", PREWALK_TODO_TOOL_NAME, {
								op: "init",
								list: [{ phase: "Implement", items: ["Make the integration mutation"] }],
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
							task: "Make the integration mutation",
						}),
					]);
				},
			});
		};
		const autoresearchFixture: ExtensionFactory = (pi) => {
			let resumePending = true;
			pi.on("agent_end", () => {
				if (!resumePending) return;
				resumePending = false;
				autoresearchResumes += 1;
				pi.sendUserMessage(autoresearchContinuation, { deliverAs: "followUp" });
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
				{ name: "prewalk", factory: prewalkExtension },
				{ name: "autoresearch-fixture", factory: autoresearchFixture },
			],
		});
		await loader.reload();
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
			resourceLoader: loader,
			settingsManager: settings,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
		await session.bindExtensions({});

		await session.prompt("/prewalk run");
		await session.waitForIdle();
		await session.prompt("Build an end-to-end feature across multiple concerns.");
		await session.waitForIdle();

		expect(autoresearchResumes).toBe(1);
		expect(calls.filter((call) => call.owner === "autoresearch")).toHaveLength(1);
		expect(calls.filter((call) => call.owner === "prewalk").map((call) => call.model)).toEqual([
			PLANNER_MODEL_ID,
			PLANNER_MODEL_ID,
			EXECUTOR_MODEL_ID,
		]);
		expect(await readFile(path.join(workDir, "target.txt"), "utf8")).toBe("after\n");

		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		const analyticsStore = new AnalyticsStore(agentDir);
		expect(await analyticsStore.listUnfinishedJournals()).toEqual([]);
		expect(await analyticsStore.listReceipts()).toHaveLength(1);
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
								toolCall("todo-1", PREWALK_TODO_TOOL_NAME, {
									op: "init",
									list: [{ phase: "Review", items: ["Complete delegated review"] }],
								}),
								toolCall("todo-done-1", PREWALK_TODO_TOOL_NAME, {
									op: "done",
									task: "Complete delegated review",
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

	it.skipIf(!installedSubagentEntry || !existsSync(stockPiCli))(
		"runs an opted-in child through stock Pi and unmodified pi-subagents",
		async () => {
			const subagentEntry = installedSubagentEntry;
			if (!subagentEntry) return;
			restoreInheritedSubagentEnvironment = isolateTopLevelSubagentEnvironment();
			const planner = fixtureModel("planner");
			const tracePath = path.join(root, "child-trace.jsonl");
			const providerFixture = path.resolve("test/fixtures/stock-pi-child-provider.mjs");
			const prewalkFixture = path.resolve("extensions/prewalk.ts");
			process.env.PI_PREWALK_CHILD_TRACE = tracePath;
			process.env.PI_PREWALK_CHILD_WORKDIR = workDir;
			process.env.PI_SUBAGENT_PI_BINARY = stockPiCli;

			await mkdir(path.join(workDir, ".pi", "agents"), { recursive: true });
			await writeFile(
				path.join(agentDir, "prewalk.json"),
				`${JSON.stringify({
					executor: { provider: "fixture", model: "executor", reasoning: "low" },
					children: { agents: { worker: true, reviewer: false } },
				})}\n`,
			);
			const childExtensions = `${providerFixture},${prewalkFixture}`;
			await writeFile(
				path.join(workDir, ".pi", "agents", "worker.md"),
				[
					"---",
					"name: worker",
					"description: Deterministic integration worker",
					"model: fixture/planner",
					"thinking: low",
					"defaultContext: fresh",
					"inheritProjectContext: false",
					"inheritSkills: false",
					"tools: read, edit, subagent",
					`subagentOnlyExtensions: ${childExtensions}`,
					"---",
					"",
					"Use the supplied tools and finish the task.",
					"",
				].join("\n"),
			);
			await writeFile(
				path.join(workDir, ".pi", "agents", "reviewer.md"),
				[
					"---",
					"name: reviewer",
					"description: Deterministic integration reviewer",
					"model: fixture/planner",
					"thinking: low",
					"defaultContext: fresh",
					"inheritProjectContext: false",
					"inheritSkills: false",
					"tools: read, edit",
					`subagentOnlyExtensions: ${childExtensions}`,
					"---",
					"",
					"Use the supplied tools and finish the task.",
					"",
				].join("\n"),
			);
			await writeFile(path.join(workDir, "worker.txt"), "before\n");
			await writeFile(path.join(workDir, "nested.txt"), "before\n");

			const settings = SettingsManager.create(workDir, agentDir);
			const loader = new DefaultResourceLoader({
				cwd: workDir,
				agentDir,
				settingsManager: settings,
				additionalExtensionPaths: [subagentEntry, providerFixture],
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [{ name: "prewalk", factory: prewalkExtension }],
			});
			await loader.reload();
			expect(loader.getExtensions().errors).toEqual([]);
			expect(loader.getExtensions().extensions).toHaveLength(3);

			const runtime = await ModelRuntime.create({
				authPath: path.join(agentDir, "auth.json"),
				modelsPath: null,
			});
			const parentSessionManager = SessionManager.inMemory(workDir);
			const { session } = await createAgentSession({
				cwd: workDir,
				agentDir,
				modelRuntime: runtime,
				model: planner,
				thinkingLevel: "low",
				resourceLoader: loader,
				settingsManager: settings,
				sessionManager: parentSessionManager,
				sessionStartEvent: { type: "session_start", reason: "startup" },
			});
			await session.bindExtensions({});

			try {
				await session.prompt("Delegate the worker change.");
				await session.waitForIdle();
			} finally {
				session.dispose();
			}

			const trace = (await readFile(tracePath, "utf8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const providerRecords = trace.filter((record) => record.type === "provider");
			const childRecords = trace.filter(
				(record) => record.type === "before-agent-start" && record.agent !== "parent",
			);
			const workerProviders = providerRecords.filter((record) => record.agent === "worker");
			const reviewerProviders = providerRecords.filter((record) => record.agent === "reviewer");
			const workerTools = childRecords.find((record) => record.agent === "worker")?.tools;
			const reviewerTools = childRecords.find((record) => record.agent === "reviewer")?.tools;

			expect(
				await readFile(path.join(workDir, "worker.txt"), "utf8"),
				JSON.stringify({ trace, entries: parentSessionManager.getEntries() }, null, 2),
			).toBe("worker\n");
			expect(
				await readFile(path.join(workDir, "nested.txt"), "utf8"),
				JSON.stringify(trace, null, 2),
			).toBe("nested\n");
			expect(workerProviders.map((record) => record.model)).toContain("executor");
			expect(workerProviders[0]?.model).toBe("planner");
			expect(reviewerProviders.every((record) => record.model === "planner")).toBe(true);
			expect(workerTools).toEqual(expect.arrayContaining(["read", "edit", "subagent"]));
			expect(workerTools).not.toContain("prewalk_todo");
			expect(reviewerTools).toEqual(expect.arrayContaining(["read", "edit"]));
			expect(reviewerTools).not.toContain("prewalk_todo");
			expect(
				new Set(
					providerRecords
						.filter((record) => record.agent === "worker" || record.agent === "reviewer")
						.map((record) => record.runId),
				).size,
			).toBe(2);
			expect(
				trace.filter(
					(record) => record.type === "session-shutdown" && record.agent !== "parent",
				),
			).toHaveLength(2);
		},
		30_000,
	);
});
