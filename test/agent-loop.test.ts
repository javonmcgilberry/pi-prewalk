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
	type ExtensionAPI,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import prewalkExtension from "../extensions/prewalk.js";
import { AnalyticsStore } from "../src/analytics-store.js";
import {
	SUBAGENT_DELEGATION_ANALYTICS_START_EVENT,
	SUBAGENT_DELEGATION_ANALYTICS_TERMINAL_EVENT,
} from "../src/analytics-subagents.js";
import { DEFAULT_EXECUTOR, EXECUTOR_MODEL_ID, PLANNER_MODEL_ID } from "../src/core.js";

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
	await writeFile(path.join(workDir, "target.txt"), "before\n");
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
	delete process.env.PI_CODING_AGENT_DIR;
	await rm(root, { recursive: true, force: true });
});

describe("stock Pi Agent-loop integration", () => {
	it("promotes a task-scoped receipt without post-completion attribution", async () => {
		const planner = model(PLANNER_MODEL_ID);
		const executor = model(EXECUTOR_MODEL_ID);
		const calls: string[] = [];
		let lunaContext: Context | undefined;
		let prewalkEvents: ExtensionAPI["events"] | undefined;
		const prewalkWithEventCapture: ExtensionFactory = (pi) => {
			prewalkEvents = pi.events;
			prewalkExtension(pi);
		};
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
						toolCall("todo-done-1", "todo", {
							op: "done",
							task: "Make the first mutation",
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
				{ name: "prewalk", factory: prewalkWithEventCapture },
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
		await session.extensionRunner.emit({
			type: "session_compact",
			compactionEntry: {
				type: "compaction",
				id: "compact-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				summary: "content omitted",
				firstKeptEntryId: "entry-1",
				tokensBefore: 100,
				usage: usage(0.2, 2, 1),
			},
			fromExtension: false,
			reason: "manual",
			willRetry: false,
		});

		const rootSessionId = session.sessionId;
		if (!prewalkEvents) throw new Error("Prewalk event bus was not captured.");
		await session.extensionRunner.emit({
			type: "tool_execution_start",
			toolCallId: "delegation-analytics-test",
			toolName: "subagent",
			args: { tasks: [{ agent: "worker" }, { agent: "worker" }] },
		});
		const publishProjection = async (channel: string, value: unknown): Promise<void> => {
			prewalkEvents?.emit(channel, value);
			await analyticsStore.writeDelegationEvidence(value);
		};
		await publishProjection(SUBAGENT_DELEGATION_ANALYTICS_TERMINAL_EVENT, {
			version: 1,
			eventId: "child-terminal",
			phase: "terminal",
			rootSessionId,
			parentSessionId: rootSessionId,
			invocationId: "tool-direct",
			delegationRunId: "delegation-direct",
			childIndex: 0,
			childSessionId: "child-session",
			lifecycle: "completed",
			observedAt: 1,
			usage: [],
		});
		await publishProjection(SUBAGENT_DELEGATION_ANALYTICS_TERMINAL_EVENT, {
			version: 1,
			eventId: "nested-terminal",
			phase: "terminal",
			rootSessionId,
			parentSessionId: "child-session",
			invocationId: "tool-nested",
			delegationRunId: "delegation-nested",
			childIndex: 0,
			childSessionId: "nested-session",
			lifecycle: "completed",
			observedAt: 2,
			usage: [],
		});
		await publishProjection(SUBAGENT_DELEGATION_ANALYTICS_START_EVENT, {
			version: 1,
			eventId: "pending-child",
			phase: "start",
			rootSessionId,
			parentSessionId: rootSessionId,
			invocationId: "tool-pending",
			delegationRunId: "delegation-pending",
			childIndex: 1,
			lifecycle: "running",
			observedAt: 3,
			usage: [],
		});
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		const projected = await analyticsStore.listDelegationEvidence();
		expect(projected).toHaveLength(3);
		expect(projected.map((item) => item.parentSessionId)).toEqual(
			expect.arrayContaining([rootSessionId, "child-session"]),
		);
		const taskTree = await analyticsStore.taskTree(rootSessionId);
		expect(taskTree.unresolved).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ delegationRunId: "delegation-pending", reason: "pending" }),
			]),
		);
		expect(taskTree.fallbackEvidence).toHaveLength(0);
		expect(taskTree.unresolved).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					delegationRunId: "delegation-direct",
					reason: "missing-usage",
				}),
				expect.objectContaining({
					delegationRunId: "delegation-nested",
					reason: "missing-usage",
				}),
			]),
		);
		expect(taskTree.actualCoverage).toBe("pending");
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
				outcome: "succeeded",
				actualCost: 6,
			}),
		);
		expect(rootReceipt?.usage).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "planner-primary" }),
				expect.objectContaining({ role: "executor-primary" }),
			]),
		);
		expect(rootReceipt?.usage).not.toEqual(
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
});
