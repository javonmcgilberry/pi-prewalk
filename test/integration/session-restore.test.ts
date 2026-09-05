import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import prewalkExtension from "../../extensions/prewalk.js";
import {
	DEFAULT_EXECUTOR,
	PLANNER_MODEL_ID,
	PREWALK_PLAN_MESSAGE_TYPE,
} from "../../src/orchestration/coordinator.js";
import { latestAuditRecord } from "../../src/session/recovery.js";
import { PREWALK_TODO_TOOL_NAME } from "../../src/turn/todo.js";

let root: string;
let agentDir: string;
let workDir: string;

function fixtureModel(id: string): Model<"openai-codex-responses"> {
	return {
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 128_000,
	};
}

function usage(): AssistantMessage["usage"] {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function planningResponse(selected: Model<Api>) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "todo-restore",
				name: PREWALK_TODO_TOOL_NAME,
				arguments: {
					op: "init",
					list: [{ phase: "Implement", items: ["Restore this planning checkpoint"] }],
				},
			},
		],
		api: selected.api,
		provider: selected.provider,
		model: selected.id,
		usage: usage(),
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "toolUse", message });
		stream.end();
	});
	return stream;
}

function textResponse(selected: Model<Api>) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "Planning checkpoint restored." }],
		api: selected.api,
		provider: selected.provider,
		model: selected.id,
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end();
	});
	return stream;
}

function abortedResponse(selected: Model<Api>) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "thinking",
				thinking: "interrupted planning trace",
				thinkingSignature: '{"type":"reasoning","encrypted_content":"checkpoint"}',
			},
		],
		api: selected.api,
		provider: selected.provider,
		model: selected.id,
		usage: usage(),
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

function handoffResponse(selected: Model<Api>) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "write-route",
				name: "write",
				arguments: { path: "route-target.txt", content: "route\n" },
			},
			{
				type: "toolCall",
				id: "todo-route-done",
				name: PREWALK_TODO_TOOL_NAME,
				arguments: { op: "done", task: "Restore the active route" },
			},
		],
		api: selected.api,
		provider: selected.provider,
		model: selected.id,
		usage: usage(),
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "toolUse", message });
		stream.end();
	});
	return stream;
}

function heldResponse(
	selected: Model<Api>,
	onStarted: () => void,
	registerRelease: (release: () => void) => void,
) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "Executor route held for restoration." }],
		api: selected.api,
		provider: selected.provider,
		model: selected.id,
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
	registerRelease(() => {
		stream.push({ type: "done", reason: "stop", message });
		stream.end();
	});
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		onStarted();
	});
	return stream;
}

function createProvider(
	calls: string[],
	responseForCall: (
		selected: Model<Api>,
		callCount: number,
	) => ReturnType<typeof planningResponse> = (selected, callCount) =>
		callCount === 1 ? planningResponse(selected) : textResponse(selected),
): ExtensionFactory {
	return (pi) => {
		pi.registerProvider("openai-codex", {
			api: "openai-codex-responses",
			baseUrl: "https://example.test",
			apiKey: "fixture-token",
			oauth: {
				name: "OpenAI Codex",
				login: async () => ({ access: "token", refresh: "refresh", expires: 1 }),
				refreshToken: async (credentials) => credentials,
				getApiKey: (credentials) => credentials.access,
			},
			models: [fixtureModel(PLANNER_MODEL_ID), fixtureModel(DEFAULT_EXECUTOR.model)],
			streamSimple: (selected) => {
				calls.push(selected.id);
				return responseForCall(selected, calls.length);
			},
		});
	};
}

const compactionFixture: ExtensionFactory = (pi) => {
	pi.on("session_before_compact", (event) => ({
		compaction: {
			summary: "Deterministic restored-session compaction summary.",
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			usage: usage(),
		},
	}));
};

async function createLoader(provider: ExtensionFactory, withCompaction = false) {
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
			{ name: "fixture-provider", factory: provider },
			{ name: "prewalk", factory: prewalkExtension },
			...(withCompaction ? [{ name: "compaction-fixture", factory: compactionFixture }] : []),
		],
	});
	await loader.reload();
	return { loader, settings };
}

async function createRuntime() {
	return ModelRuntime.create({
		authPath: path.join(agentDir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
}

async function shutdownSession(session: AgentSession): Promise<void> {
	try {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	} finally {
		session.dispose();
	}
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "prewalk-session-restore-"));
	agentDir = path.join(root, "agent");
	workDir = path.join(root, "work");
	await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(workDir, { recursive: true })]);
	await writeFile(
		path.join(agentDir, "prewalk.json"),
		`${JSON.stringify({ executor: DEFAULT_EXECUTOR })}\n`,
	);
	await writeFile(
		path.join(agentDir, "auth.json"),
		`${JSON.stringify({ "openai-codex": { type: "api_key", key: "fixture-token" } })}\n`,
	);
	await writeFile(
		path.join(agentDir, "settings.json"),
		`${JSON.stringify({
			defaultProvider: "openai-codex",
			defaultModel: PLANNER_MODEL_ID,
			compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 0 },
		})}\n`,
	);
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
	delete process.env.PI_CODING_AGENT_DIR;
	await rm(root, { recursive: true, force: true });
});

describe("restored stock Pi sessions", () => {
	it("restores a ready planner from supplied in-memory entries without rerunning it", async () => {
		const calls: string[] = [];
		const planner = fixtureModel(PLANNER_MODEL_ID);
		const firstResources = await createLoader(createProvider(calls));
		const firstRuntime = await createRuntime();
		const firstManager = SessionManager.inMemory(workDir);
		const { session: firstSession } = await createAgentSession({
			cwd: workDir,
			agentDir,
			modelRuntime: firstRuntime,
			model: planner,
			thinkingLevel: "high",
			resourceLoader: firstResources.loader,
			settingsManager: firstResources.settings,
			sessionManager: firstManager,
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
		await firstSession.bindExtensions({});
		await firstSession.prompt("/prewalk run");
		await firstSession.waitForIdle();
		const armedEntries = firstManager.getEntries();
		const sessionId = firstSession.sessionId;
		expect(calls).toEqual([]);
		expect(firstSession.getActiveToolNames()).toContain(PREWALK_TODO_TOOL_NAME);

		const planningSnapshot = {
			entries: firstManager.getEntries(),
			captured: false,
		};
		const unsubscribe = firstSession.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "toolResult") return;
			setTimeout(() => {
				if (planningSnapshot.captured) return;
				planningSnapshot.entries = firstManager.getEntries();
				planningSnapshot.captured = true;
			}, 0);
		});
		await firstSession.prompt("Begin the requested work.");
		await firstSession.waitForIdle();
		unsubscribe();

		expect(planningSnapshot.captured).toBe(true);
		const readyEntries = planningSnapshot.entries;
		const terminalEntries = firstManager.getEntries();
		expect(calls.length, JSON.stringify(readyEntries, null, 2)).toBeGreaterThan(0);
		expect(JSON.stringify(readyEntries)).toContain('"event":"todo-ready"');
		const armedRecord = latestAuditRecord(armedEntries);
		const readyRecord = latestAuditRecord(readyEntries);
		expect(armedRecord).toEqual(
			expect.objectContaining({
				runId: expect.any(String),
				epoch: expect.any(String),
				phase: "planning",
			}),
		);
		expect(readyRecord?.runId).toBe(armedRecord?.runId);
		expect(readyRecord?.epoch).toBe(armedRecord?.epoch);
		const callCountBeforeRestore = calls.length;
		await shutdownSession(firstSession);

		const armedResources = await createLoader(createProvider(calls));
		const armedRuntime = await createRuntime();
		const armedManager = SessionManager.inMemory(workDir, { id: sessionId }, armedEntries);
		const { session: armedSession } = await createAgentSession({
			cwd: workDir,
			agentDir,
			modelRuntime: armedRuntime,
			model: planner,
			thinkingLevel: "high",
			resourceLoader: armedResources.loader,
			settingsManager: armedResources.settings,
			sessionManager: armedManager,
			sessionStartEvent: { type: "session_start", reason: "reload" },
		});
		await armedSession.bindExtensions({});
		expect(armedManager.getEntries()).toEqual(armedEntries);
		expect(armedSession.model?.id).toBe(PLANNER_MODEL_ID);
		expect(armedSession.thinkingLevel).toBe("high");
		expect(armedSession.getActiveToolNames()).toContain(PREWALK_TODO_TOOL_NAME);
		expect(calls).toHaveLength(callCountBeforeRestore);
		await shutdownSession(armedSession);

		const restoredResources = await createLoader(createProvider(calls));
		const restoredRuntime = await createRuntime();
		const restoredManager = SessionManager.inMemory(workDir, { id: sessionId }, readyEntries);
		const { session: restoredSession } = await createAgentSession({
			cwd: workDir,
			agentDir,
			modelRuntime: restoredRuntime,
			model: planner,
			thinkingLevel: "high",
			resourceLoader: restoredResources.loader,
			settingsManager: restoredResources.settings,
			sessionManager: restoredManager,
			sessionStartEvent: { type: "session_start", reason: "reload" },
		});
		await restoredSession.bindExtensions({});

		expect(restoredManager.getSessionId()).toBe(sessionId);
		expect(restoredManager.getEntries()).toEqual(readyEntries);
		expect(restoredSession.model?.id).toBe(PLANNER_MODEL_ID);
		expect(restoredSession.thinkingLevel).toBe("high");
		expect(restoredSession.getActiveToolNames()).toContain(PREWALK_TODO_TOOL_NAME);
		expect(calls).toHaveLength(callCountBeforeRestore);
		await shutdownSession(restoredSession);

		const terminalResources = await createLoader(createProvider(calls));
		const terminalRuntime = await createRuntime();
		const terminalManager = SessionManager.inMemory(workDir, { id: sessionId }, terminalEntries);
		const { session: terminalSession } = await createAgentSession({
			cwd: workDir,
			agentDir,
			modelRuntime: terminalRuntime,
			model: planner,
			thinkingLevel: "high",
			resourceLoader: terminalResources.loader,
			settingsManager: terminalResources.settings,
			sessionManager: terminalManager,
			sessionStartEvent: { type: "session_start", reason: "reload" },
		});
		await terminalSession.bindExtensions({});
		expect(terminalManager.getEntries()).toEqual(terminalEntries);
		expect(terminalSession.getActiveToolNames()).not.toContain(PREWALK_TODO_TOOL_NAME);
		expect(calls).toHaveLength(callCountBeforeRestore);
		await shutdownSession(terminalSession);

		const compactionResources = await createLoader(createProvider(calls), true);
		const compactionRuntime = await createRuntime();
		const compactionManager = SessionManager.inMemory(
			workDir,
			{ id: sessionId },
			terminalEntries,
		);
		const { session: compactionSession } = await createAgentSession({
			cwd: workDir,
			agentDir,
			modelRuntime: compactionRuntime,
			model: planner,
			thinkingLevel: "high",
			resourceLoader: compactionResources.loader,
			settingsManager: compactionResources.settings,
			sessionManager: compactionManager,
			sessionStartEvent: { type: "session_start", reason: "reload" },
		});
		await compactionSession.bindExtensions({});
		await compactionSession.compact();
		await compactionSession.waitForIdle();
		const compactedEntries = compactionManager.getEntries();
		expect(compactedEntries.some((entry) => entry.type === "compaction")).toBe(true);
		expect(
			compactionManager
				.buildContextEntries()
				.some(
					(entry) =>
						entry.type === "custom_message" && entry.customType === PREWALK_PLAN_MESSAGE_TYPE,
				),
		).toBe(false);
		expect(calls).toHaveLength(callCountBeforeRestore);
		await shutdownSession(compactionSession);

		const compactedResources = await createLoader(createProvider(calls));
		const compactedRuntime = await createRuntime();
		const compactedManager = SessionManager.inMemory(
			workDir,
			{ id: sessionId },
			compactedEntries,
		);
		const { session: compactedSession } = await createAgentSession({
			cwd: workDir,
			agentDir,
			modelRuntime: compactedRuntime,
			model: planner,
			thinkingLevel: "high",
			resourceLoader: compactedResources.loader,
			settingsManager: compactedResources.settings,
			sessionManager: compactedManager,
			sessionStartEvent: { type: "session_start", reason: "reload" },
		});
		await compactedSession.bindExtensions({});
		expect(compactedManager.getEntries()).toEqual(compactedEntries);
		expect(compactedSession.getActiveToolNames()).not.toContain(PREWALK_TODO_TOOL_NAME);
		expect(calls).toHaveLength(callCountBeforeRestore);
		await shutdownSession(compactedSession);
	}, 30_000);

	it("restores a paused interrupted planner without replaying its recovery turn", async () => {
		const calls: string[] = [];
		const planner = fixtureModel(PLANNER_MODEL_ID);
		await writeFile(
			path.join(agentDir, "prewalk.json"),
			`${JSON.stringify({ executor: DEFAULT_EXECUTOR, plannerRecovery: { maxRetries: 1 } })}\n`,
		);
		const resources = await createLoader(
			createProvider(calls, (selected) => abortedResponse(selected)),
		);
		const runtime = await createRuntime();
		const manager = SessionManager.inMemory(workDir);
		const { session } = await createAgentSession({
			cwd: workDir,
			agentDir,
			modelRuntime: runtime,
			model: planner,
			thinkingLevel: "high",
			resourceLoader: resources.loader,
			settingsManager: resources.settings,
			sessionManager: manager,
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
		await session.bindExtensions({});

		await session.prompt("/prewalk run");
		await session.waitForIdle();
		await session.prompt("Continue the interrupted plan.");
		await session.waitForIdle();
		await session.prompt("Allow the bounded recovery.");
		await session.waitForIdle();

		const entries = manager.getEntries();
		const sessionId = session.sessionId;
		const record = latestAuditRecord(entries);
		expect(calls.length).toBeGreaterThan(1);
		expect(record).toEqual(
			expect.objectContaining({ event: "planning-paused", phase: "planning", todoActive: true }),
		);
		expect(JSON.stringify(entries)).toContain('"stopReason":"aborted"');
		const callCountBeforeRestore = calls.length;
		await shutdownSession(session);

		const restoredResources = await createLoader(
			createProvider(calls, (selected) => abortedResponse(selected)),
		);
		const restoredRuntime = await createRuntime();
		const restoredManager = SessionManager.inMemory(workDir, { id: sessionId }, entries);
		const { session: restoredSession } = await createAgentSession({
			cwd: workDir,
			agentDir,
			modelRuntime: restoredRuntime,
			model: planner,
			thinkingLevel: "high",
			resourceLoader: restoredResources.loader,
			settingsManager: restoredResources.settings,
			sessionManager: restoredManager,
			sessionStartEvent: { type: "session_start", reason: "reload" },
		});
		await restoredSession.bindExtensions({});

		expect(restoredManager.getEntries()).toEqual(entries);
		expect(restoredSession.getActiveToolNames()).toContain(PREWALK_TODO_TOOL_NAME);
		expect(restoredSession.model?.id).toBe(PLANNER_MODEL_ID);
		expect(restoredSession.thinkingLevel).toBe("high");
		expect(calls).toHaveLength(callCountBeforeRestore);
		await shutdownSession(restoredSession);
	}, 30_000);

	it("restores an executor-active route without issuing a duplicate request", async () => {
		const calls: string[] = [];
		const planner = fixtureModel(PLANNER_MODEL_ID);
		let markExecutorStarted!: () => void;
		const executorStarted = new Promise<void>((resolve) => {
			markExecutorStarted = resolve;
		});
		let releaseExecutor!: () => void;
		const provider = createProvider(calls, (selected, callCount) => {
			if (selected.id === DEFAULT_EXECUTOR.model) {
				return heldResponse(selected, markExecutorStarted, (release) => {
					releaseExecutor = release;
				});
			}
			return callCount === 1 ? planningResponse(selected) : handoffResponse(selected);
		});
		const resources = await createLoader(provider);
		const runtime = await createRuntime();
		const manager = SessionManager.inMemory(workDir);
		const { session } = await createAgentSession({
			cwd: workDir,
			agentDir,
			modelRuntime: runtime,
			model: planner,
			thinkingLevel: "high",
			resourceLoader: resources.loader,
			settingsManager: resources.settings,
			sessionManager: manager,
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
		await session.bindExtensions({});

		await session.prompt("/prewalk run");
		await session.waitForIdle();
		const promptPromise = session.prompt("Make the route mutation.");
		await executorStarted;
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if (latestAuditRecord(manager.getEntries())?.event === "executor-active") break;
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		const routeEntries = manager.getEntries();
		const sessionId = session.sessionId;
		expect(latestAuditRecord(routeEntries)).toEqual(
			expect.objectContaining({
				event: "executor-active",
				phase: "active",
				effectiveRoute: "executor",
			}),
		);
		expect(session.model?.id).toBe(DEFAULT_EXECUTOR.model);
		const activeToolsBeforeRestore = session.getActiveToolNames();
		const callCountBeforeRestore = calls.length;
		releaseExecutor();
		await promptPromise;
		await shutdownSession(session);

		const restoredResources = await createLoader(createProvider(calls));
		const restoredRuntime = await createRuntime();
		const restoredManager = SessionManager.inMemory(workDir, { id: sessionId }, routeEntries);
		const { session: restoredSession } = await createAgentSession({
			cwd: workDir,
			agentDir,
			modelRuntime: restoredRuntime,
			model: planner,
			thinkingLevel: "high",
			resourceLoader: restoredResources.loader,
			settingsManager: restoredResources.settings,
			sessionManager: restoredManager,
			sessionStartEvent: { type: "session_start", reason: "reload" },
		});
		await restoredSession.bindExtensions({});

		expect(restoredManager.getSessionId()).toBe(sessionId);
		const restoredEntries = restoredManager.getEntries();
		expect(restoredEntries.slice(0, routeEntries.length)).toEqual(routeEntries);
		expect(restoredEntries.slice(routeEntries.length).map((entry) => entry.type)).toEqual([
			"model_change",
			"thinking_level_change",
		]);
		expect(restoredSession.model?.id).toBe(DEFAULT_EXECUTOR.model);
		expect(restoredSession.thinkingLevel).toBe(DEFAULT_EXECUTOR.reasoning);
		expect(restoredSession.getActiveToolNames()).toEqual(activeToolsBeforeRestore);
		expect(calls).toHaveLength(callCountBeforeRestore);
		await shutdownSession(restoredSession);
	}, 30_000);
});
