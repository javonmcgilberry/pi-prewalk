import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderConfig,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import prewalkExtension from "../extensions/prewalk.js";
import {
	SUBAGENT_DELEGATION_ANALYTICS_START_EVENT,
	SUBAGENT_DELEGATION_ANALYTICS_TERMINAL_EVENT,
} from "../src/analytics-subagents.js";
import {
	DEFAULT_EXECUTOR,
	EXECUTOR_MODEL_ID,
	PLANNER_MODEL_ID,
	PREWALK_CHECKLIST_MESSAGE_TYPE,
	PREWALK_CONTINUE_MESSAGE_TYPE,
	PREWALK_PLAN_MESSAGE_TYPE,
} from "../src/core.js";
import { EXECUTION_PROFILE_POLICY_REQUEST_EVENT } from "../src/execution-profile-policy.js";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

function model(id: string): Model<"openai-codex-responses"> {
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

function assistant(selected: Model<"openai-codex-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: selected.api,
		provider: selected.provider,
		model: selected.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function doneStream(selected: Model<"openai-codex-responses">) {
	const stream = createAssistantMessageEventStream();
	const message = assistant(selected);
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end();
	});
	return stream;
}

function failedStream(selected: Model<"openai-codex-responses">) {
	const stream = createAssistantMessageEventStream();
	const message = {
		...assistant(selected),
		stopReason: "error" as const,
		errorMessage: "provider failure",
	};
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
		stream.end();
	});
	return stream;
}

function oauthConfig(streamSimple: NonNullable<ProviderConfig["streamSimple"]>): ProviderConfig {
	return {
		api: "openai-codex-responses",
		oauth: {
			name: "OpenAI Codex",
			login: async () => ({ access: "token", refresh: "refresh", expires: 1 }),
			refreshToken: async (credentials) => credentials,
			getApiKey: (credentials) => credentials.access,
		},
		streamSimple,
	};
}

function createHarness(
	options: {
		foreignTodo?: ToolDefinition;
		availableModels?: Model<"openai-codex-responses">[];
		selectedModel?: Model<"openai-codex-responses">;
		sessionId?: string;
		todoVisible?: boolean;
		activeTools?: string[];
	} = {},
) {
	const handlers = new Map<string, Handler[]>();
	const busHandlers = new Map<string, Array<(data: unknown) => void>>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const tools = new Map<string, ToolDefinition>();
	if (options.foreignTodo) tools.set("todo", options.foreignTodo);
	const messages: Array<{
		customType: string;
		content: unknown;
		display: boolean;
		details?: unknown;
	}> = [];
	const messageOptions: Array<{
		triggerTurn?: boolean;
		deliverAs?: "steer" | "followUp" | "nextTurn";
	}> = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	const statuses: Array<string | undefined> = [];
	const notifications: string[] = [];
	const delegated: Model<"openai-codex-responses">[] = [];
	const delegatedOptions: Array<{ reasoning?: string } | undefined> = [];
	const delegatedContexts: Array<{ messages: unknown[] }> = [];
	const activeToolUpdates: string[][] = [];
	let activeTools = options.activeTools ?? ["todo", "edit", "write", "bash"];
	let terminalInputHandler:
		| ((data: string) => { consume?: boolean; data?: string } | undefined)
		| undefined;
	const planner = options.selectedModel ?? model(PLANNER_MODEL_ID);
	const executor = model(EXECUTOR_MODEL_ID);
	let streamImpl: NonNullable<ProviderConfig["streamSimple"]> = (selected) =>
		doneStream(selected as Model<"openai-codex-responses">);
	const baseStream: NonNullable<ProviderConfig["streamSimple"]> = (
		selected,
		streamContext,
		options,
	) => {
		delegated.push(selected as Model<"openai-codex-responses">);
		delegatedOptions.push(options);
		delegatedContexts.push(streamContext);
		return streamImpl(selected, streamContext, options);
	};
	let providerConfig: ProviderConfig | undefined = oauthConfig(baseStream);
	let branch: unknown[] = [];

	const pi = {
		events: {
			on: vi.fn((channel: string, handler: (data: unknown) => void) => {
				const registered = busHandlers.get(channel) ?? [];
				registered.push(handler);
				busHandlers.set(channel, registered);
				return () => {
					busHandlers.set(
						channel,
						(busHandlers.get(channel) ?? []).filter((candidate) => candidate !== handler),
					);
				};
			}),
			emit: vi.fn((channel: string, data: unknown) => {
				for (const handler of busHandlers.get(channel) ?? []) handler(data);
			}),
		},
		on: vi.fn((name: string, handler: Handler) => {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		}),
		registerTool: vi.fn((tool: ToolDefinition) => {
			if (!tools.has(tool.name)) tools.set(tool.name, tool);
		}),
		registerCommand: vi.fn(
			(
				name: string,
				options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> },
			) => {
				commands.set(name, options.handler);
			},
		),
		getAllTools: vi.fn(() =>
			options.todoVisible === false
				? []
				: [
						{
							name: "todo",
							description: "todo",
							parameters: {},
							sourceInfo: {
								path: options.foreignTodo
									? "/package/extensions/foreign.ts"
									: "/package/extensions/prewalk.ts",
								source: "extension",
								scope: "user",
								origin: "top-level",
							},
						},
					],
		),
		getActiveTools: vi.fn(() => [...activeTools]),
		setActiveTools: vi.fn((toolNames: string[]) => {
			activeTools = [...toolNames];
			activeToolUpdates.push([...toolNames]);
		}),
		registerProvider: vi.fn((_name: string, config: ProviderConfig) => {
			providerConfig = config;
		}),
		unregisterProvider: vi.fn(() => {
			providerConfig = undefined;
		}),
		sendMessage: vi.fn((message, options) => {
			messages.push(message);
			messageOptions.push(options ?? {});
		}),
		appendEntry: vi.fn((customType: string, data: unknown) => {
			entries.push({ customType, data });
		}),
	} as unknown as ExtensionAPI;

	const modelRegistry = {
		getAvailable: () => options.availableModels ?? [planner, executor],
		find: (_provider: string, id: string) => {
			if (id === planner.id) return planner;
			if (id === executor.id) return executor;
			return undefined;
		},
		getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "token" })),
		getRegisteredProviderConfig: vi.fn(() => providerConfig),
	};
	const context = {
		model: planner,
		thinkingLevel: "low",
		modelRegistry,
		ui: {
			setStatus: (_key: string, value: string | undefined) => {
				statuses.push(value);
			},
			notify: (message: string) => {
				notifications.push(message);
			},
			onTerminalInput: vi.fn(
				(handler: (data: string) => { consume?: boolean; data?: string } | undefined) => {
					terminalInputHandler = handler;
					return () => {
						terminalInputHandler = undefined;
					};
				},
			),
			select: vi.fn(),
			confirm: vi.fn(),
		},
		hasUI: true,
		sessionManager: {
			getSessionId: () => options.sessionId ?? "session-extension-test",
			getBranch: () => branch,
			buildContextEntries: () => [],
		},
	} as unknown as ExtensionContext;

	const emit = async (name: string, event: unknown) => {
		const results = [];
		for (const handler of handlers.get(name) ?? []) {
			results.push(await handler(event, context));
		}
		return results;
	};

	return {
		pi,
		context,
		planner,
		executor,
		baseStream,
		handlers,
		commands,
		tools: tools as Map<string, any>,
		messages,
		messageOptions,
		entries,
		statuses,
		notifications,
		delegated,
		delegatedOptions,
		delegatedContexts,
		activeTools: () => [...activeTools],
		activeToolUpdates,
		terminalInput: (data: string) => terminalInputHandler?.(data),
		emit,
		emitBus: (channel: string, data: unknown) => {
			for (const handler of busHandlers.get(channel) ?? []) handler(data);
		},
		providerConfig: () => providerConfig,
		setProviderConfig: (value: ProviderConfig | undefined) => {
			providerConfig = value;
		},
		setStream: (value: NonNullable<ProviderConfig["streamSimple"]>) => {
			streamImpl = value;
		},
		setBranch: (value: unknown[]) => {
			branch = value;
		},
	};
}

async function reachHandoff(harness: ReturnType<typeof createHarness>) {
	await harness.emit("session_start", { type: "session_start", reason: "startup" });
	await harness.commands.get("prewalk")?.("run", harness.context);
	await harness.emit("turn_end", {
		type: "turn_end",
		turnIndex: 0,
		message: { role: "assistant", content: [] },
		toolResults: [],
	});
	await harness.emit("tool_result", {
		type: "tool_result",
		toolCallId: "todo-1",
		toolName: "todo",
		input: { op: "init" },
		content: [],
		isError: false,
		details: { phases: [] },
	});
	await harness.emit("tool_result", {
		type: "tool_result",
		toolCallId: "edit-1",
		toolName: "edit",
		input: {},
		content: [],
		isError: false,
		details: {},
	});
	await harness.emit("turn_end", {
		type: "turn_end",
		turnIndex: 1,
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "todo-1", name: "todo", arguments: {} },
				{ type: "toolCall", id: "edit-1", name: "edit", arguments: {} },
			],
		},
		toolResults: [],
	});
}

async function beginAutomaticAssessment(harness: ReturnType<typeof createHarness>, text: string) {
	await harness.emit("session_start", { type: "session_start", reason: "startup" });
	await harness.commands.get("prewalk")?.("auto", harness.context);
	await harness.emit("input", { type: "input", text, source: "interactive" });
	return harness.emit("before_agent_start", {
		type: "before_agent_start",
		prompt: text,
		systemPrompt: "system",
		systemPromptOptions: {},
	});
}

function auditBranch(harness: ReturnType<typeof createHarness>) {
	return harness.entries.map((entry, index) => ({
		type: "custom",
		id: `audit-${index}`,
		parentId: index === 0 ? null : `audit-${index - 1}`,
		timestamp: new Date().toISOString(),
		customType: entry.customType,
		data: entry.data,
	}));
}

let agentDir: string;

beforeEach(async () => {
	agentDir = await mkdtemp(path.join(tmpdir(), "prewalk-extension-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	await writeFile(
		path.join(agentDir, "prewalk.json"),
		`${JSON.stringify({
			executor: DEFAULT_EXECUTOR,
		})}\n`,
	);
});

afterEach(async () => {
	delete process.env.PI_CODING_AGENT_DIR;
	await rm(agentDir, { recursive: true, force: true });
});

describe("Prewalk extension harness", () => {
	it("registers the OMP-compatible todo tool and public lifecycle handlers", () => {
		const harness = createHarness();
		prewalkExtension(harness.pi);

		expect(harness.tools.has("todo")).toBe(true);
		expect(harness.commands.has("prewalk")).toBe(true);
		expect(harness.commands.has("todos")).toBe(true);
		expect(harness.tools.get("todo")?.promptSnippet).toContain("`init` replaces the list");
		expect(harness.handlers.has("session_start")).toBe(true);
		expect(harness.handlers.has("context")).toBe(true);
		expect(harness.handlers.has("session_before_compact")).toBe(true);
		expect("setModel" in harness.pi).toBe(false);
	});

	it("starts manual, then preserves automatic mode only across a same-session reload", async () => {
		const first = createHarness();
		prewalkExtension(first.pi);
		await first.emit("session_start", { type: "session_start", reason: "startup" });

		expect(first.providerConfig()?.streamSimple).toBe(first.baseStream);
		expect(first.entries).toEqual([]);
		expect(first.messages).toEqual([]);
		await first.commands.get("prewalk")?.("auto", first.context);
		expect(first.entries.at(-1)).toEqual({
			customType: "prewalk-auto-mode",
			data: { schemaVersion: 1, sessionId: "session-extension-test", enabled: true },
		});

		const restored = createHarness();
		restored.setBranch(auditBranch(first));
		prewalkExtension(restored.pi);
		await restored.emit("session_start", { type: "session_start", reason: "reload" });
		await restored.commands.get("prewalk")?.("auto", restored.context);
		expect(restored.notifications.at(-1)).toContain("already enabled");
		expect(restored.providerConfig()?.streamSimple).toBe(restored.baseStream);

		for (const reason of ["startup", "new", "resume", "fork"]) {
			const newSession = createHarness({ sessionId: `${reason}-session` });
			newSession.setBranch(auditBranch(first));
			prewalkExtension(newSession.pi);
			await newSession.emit("session_start", { type: "session_start", reason });
			await newSession.commands.get("prewalk")?.("auto", newSession.context);
			expect(newSession.notifications.at(-1)).toContain("enabled for this session");
		}
	});

	it("cancels automatic mode without starting a run", async () => {
		const harness = createHarness();
		prewalkExtension(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("prewalk")?.("auto", harness.context);
		await harness.commands.get("prewalk")?.("cancel", harness.context);

		expect(harness.entries.at(-1)).toEqual({
			customType: "prewalk-auto-mode",
			data: { schemaVersion: 1, sessionId: "session-extension-test", enabled: false },
		});
		expect(harness.providerConfig()?.streamSimple).toBe(harness.baseStream);
		expect(harness.messages).toEqual([]);
	});

	it("evaluates substantial work across turns before queuing the full plan", async () => {
		const harness = createHarness({ activeTools: ["read", "todo", "edit"] });
		prewalkExtension(harness.pi);
		const beforeStart = await beginAutomaticAssessment(
			harness,
			"Fix the cross-cutting production bug with reproduction and regression protection",
		);

		expect(beforeStart).toEqual([
			expect.objectContaining({
				message: expect.objectContaining({ customType: "prewalk-assess" }),
			}),
		]);
		expect(harness.activeTools()).toEqual(["read", "edit", "prewalk_assess"]);
		await harness.emit("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: {},
			toolResults: [],
		});
		expect(harness.messages).toEqual([]);
		await harness.tools.get("prewalk_assess")?.execute("assessment-1", { decision: "continue" });
		await harness.emit("agent_settled", { type: "agent_settled" });

		expect(harness.activeTools()).toEqual(["read", "edit", "todo"]);
		expect(harness.messages.at(-1)?.customType).toBe(PREWALK_PLAN_MESSAGE_TYPE);
		expect(harness.providerConfig()?.streamSimple).not.toBe(harness.baseStream);
	});

	it("quietly bypasses a completed approved plan and restores the exact tool slate", async () => {
		const harness = createHarness({ activeTools: ["read", "todo", "grep"] });
		prewalkExtension(harness.pi);
		await beginAutomaticAssessment(
			harness,
			"Implement the approved migration plan in docs/plans/cam-1.md",
		);
		await harness.tools.get("prewalk_assess")?.execute("assessment-1", { decision: "bypass" });
		await harness.emit("agent_settled", { type: "agent_settled" });

		expect(harness.activeTools()).toEqual(["read", "grep"]);
		expect(harness.messages).toEqual([]);
		expect(harness.entries.filter((entry) => entry.customType === "prewalk-audit")).toEqual([]);
		expect(harness.providerConfig()?.streamSimple).toBe(harness.baseStream);
	});

	it("fails closed for missing, duplicate, late, and mutation-invalid assessment decisions", async () => {
		const missing = createHarness();
		prewalkExtension(missing.pi);
		await beginAutomaticAssessment(
			missing,
			"Build an end-to-end feature across multiple concerns",
		);
		await missing.emit("agent_settled", { type: "agent_settled" });
		expect(missing.messages).toEqual([]);
		const malformed = createHarness();
		prewalkExtension(malformed.pi);
		await beginAutomaticAssessment(
			malformed,
			"Build an end-to-end feature across multiple concerns",
		);
		await expect(
			malformed.tools
				.get("prewalk_assess")
				?.execute("assessment-1", { decision: "invalid" } as never),
		).rejects.toThrow("invalid");
		await malformed.emit("agent_settled", { type: "agent_settled" });
		expect(malformed.messages).toEqual([]);

		const duplicate = createHarness();
		prewalkExtension(duplicate.pi);
		await beginAutomaticAssessment(
			duplicate,
			"Build an end-to-end feature across multiple concerns",
		);
		await duplicate.tools
			.get("prewalk_assess")
			?.execute("assessment-1", { decision: "continue" });
		await expect(
			duplicate.tools.get("prewalk_assess")?.execute("assessment-2", { decision: "bypass" }),
		).rejects.toThrow("inactive");
		await duplicate.emit("agent_settled", { type: "agent_settled" });
		await expect(
			duplicate.tools.get("prewalk_assess")?.execute("assessment-3", { decision: "continue" }),
		).rejects.toThrow("inactive");

		const mutated = createHarness();
		prewalkExtension(mutated.pi);
		await beginAutomaticAssessment(
			mutated,
			"Build an end-to-end feature across multiple concerns",
		);
		await mutated.emit("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "edit-1",
			toolName: "edit",
			args: {},
		});
		await mutated.emit("tool_result", {
			type: "tool_result",
			toolCallId: "edit-1",
			toolName: "edit",
			input: {},
			content: [],
			isError: false,
			details: {},
		});
		await mutated.emit("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: {} }],
			},
			toolResults: [],
		});
		await expect(
			mutated.tools.get("prewalk_assess")?.execute("assessment-1", { decision: "continue" }),
		).rejects.toThrow("inactive");
		await mutated.emit("agent_settled", { type: "agent_settled" });
		expect(mutated.messages).toEqual([]);
	});

	it("allows read-only exec inspection but ignores failed mutation attempts during assessment", async () => {
		const inspected = createHarness();
		prewalkExtension(inspected.pi);
		await beginAutomaticAssessment(
			inspected,
			"Build an end-to-end feature across multiple concerns",
		);
		await inspected.emit("tool_result", {
			type: "tool_result",
			toolCallId: "exec-1",
			toolName: "exec_command",
			input: { cmd: "rg -n prewalk src" },
			content: [],
			isError: false,
			details: { exit_code: 0 },
		});
		await inspected.emit("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", content: [] },
			toolResults: [],
		});
		await inspected.tools
			.get("prewalk_assess")
			?.execute("assessment-1", { decision: "continue" });
		await inspected.emit("agent_settled", { type: "agent_settled" });
		expect(inspected.messages.at(-1)?.customType).toBe(PREWALK_PLAN_MESSAGE_TYPE);

		const failed = createHarness();
		prewalkExtension(failed.pi);
		await beginAutomaticAssessment(
			failed,
			"Build an end-to-end feature across multiple concerns",
		);
		await failed.emit("tool_result", {
			type: "tool_result",
			toolCallId: "edit-1",
			toolName: "edit",
			input: {},
			content: [],
			isError: true,
			details: {},
		});
		await failed.emit("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", content: [] },
			toolResults: [],
		});
		await failed.tools.get("prewalk_assess")?.execute("assessment-1", { decision: "continue" });
		await failed.emit("agent_settled", { type: "agent_settled" });
		expect(failed.messages.at(-1)?.customType).toBe(PREWALK_PLAN_MESSAGE_TYPE);
	});

	it("cancels and reloads an evaluation without allowing a later decision to revive it", async () => {
		const cancelled = createHarness({ activeTools: ["read", "todo", "edit"] });
		prewalkExtension(cancelled.pi);
		await beginAutomaticAssessment(
			cancelled,
			"Build an end-to-end feature across multiple concerns",
		);
		await cancelled.commands.get("prewalk")?.("cancel", cancelled.context);
		expect(cancelled.activeTools()).toEqual(["read", "edit"]);
		await expect(
			cancelled.tools.get("prewalk_assess")?.execute("assessment-1", { decision: "continue" }),
		).rejects.toThrow("inactive");

		const first = createHarness({ activeTools: ["read", "todo", "edit"] });
		prewalkExtension(first.pi);
		await beginAutomaticAssessment(first, "Build an end-to-end feature across multiple concerns");
		const restored = createHarness({ activeTools: ["read", "edit", "prewalk_assess"] });
		restored.setBranch(auditBranch(first));
		prewalkExtension(restored.pi);
		await restored.emit("session_start", { type: "session_start", reason: "reload" });
		expect(restored.activeTools()).toEqual(["read", "edit"]);
		expect(restored.messages).toEqual([]);
	});

	it("ignores extension and streaming input while automatic mode is ready", async () => {
		const harness = createHarness();
		prewalkExtension(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("prewalk")?.("auto", harness.context);
		for (const event of [
			{ type: "input", text: "Build an end-to-end feature", source: "extension" },
			{
				type: "input",
				text: "Build an end-to-end feature",
				source: "interactive",
				streamingBehavior: "steer",
			},
			{
				type: "input",
				text: "Build an end-to-end feature",
				source: "rpc",
				streamingBehavior: "followUp",
			},
		]) {
			await harness.emit("input", event);
			await harness.emit("before_agent_start", {
				type: "before_agent_start",
				prompt: event.text,
				systemPrompt: "system",
				systemPromptOptions: {},
			});
		}
		expect(harness.activeTools()).toEqual(["edit", "write", "bash"]);
		expect(harness.messages).toEqual([]);
	});

	it("preserves a foreign todo owner and fails before arming", async () => {
		const foreignTodo = {
			name: "todo",
			label: "Foreign todo",
			description: "Foreign todo",
			parameters: {},
			execute: vi.fn(),
		} as unknown as ToolDefinition;
		const harness = createHarness({ foreignTodo });
		prewalkExtension(harness.pi);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("prewalk")?.("run", harness.context);
		await harness.emit("tool_result", {
			type: "tool_result",
			toolCallId: "todo-1",
			toolName: "todo",
			input: { op: "init" },
			content: [],
			isError: false,
			details: { phases: [] },
		});

		expect(harness.tools.get("todo")).toBe(foreignTodo);
		expect(harness.notifications.at(-1)).toBe("Prewalk failed: todo-conflict.");
		expect(harness.delegated).toEqual([]);
		expect(harness.entries.at(-1)?.data).toMatchObject({
			event: "failed",
			reasonCode: "todo-conflict",
		});
	});

	it("treats a restricted child slate without todo as an open gate", async () => {
		const harness = createHarness({
			todoVisible: false,
			activeTools: ["read", "edit", "write", "bash"],
		});
		prewalkExtension(harness.pi);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("prewalk")?.("run", harness.context);
		await harness.emit("tool_result", {
			type: "tool_result",
			toolCallId: "todo-1",
			toolName: "todo",
			input: { op: "init" },
			content: [],
			isError: false,
			details: { phases: [] },
		});
		await harness.emit("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", content: [] },
			toolResults: [],
		});
		await harness.emit("tool_result", {
			type: "tool_result",
			toolCallId: "edit-1",
			toolName: "edit",
			input: {},
			content: [],
			isError: false,
			details: {},
		});
		await harness.emit("turn_end", {
			type: "turn_end",
			turnIndex: 1,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: {} }],
			},
			toolResults: [],
		});

		expect(harness.notifications).not.toContain("Prewalk failed: todo-conflict.");
		expect(harness.entries.at(-1)?.data).toMatchObject({
			event: "handoff-triggered",
			phase: "handoff-pending",
			todoActive: true,
		});
		expect(harness.statuses.at(-1)).toContain("switching after this turn");
	});

	it("surfaces a delegated child Prewalk failure over the parent's waiting state", async () => {
		const child = createHarness({
			foreignTodo: {
				name: "todo",
				label: "Foreign todo",
				description: "Foreign todo",
				parameters: {},
				execute: vi.fn(),
			} as unknown as ToolDefinition,
		});
		prewalkExtension(child.pi);
		await child.emit("session_start", { type: "session_start", reason: "startup" });
		await child.commands.get("prewalk")?.("run", child.context);
		const childSession = path.join(agentDir, "child-session.jsonl");
		await writeFile(
			childSession,
			child.entries
				.map((entry) =>
					JSON.stringify({ type: "custom", customType: entry.customType, data: entry.data }),
				)
				.join("\n"),
		);

		const parent = createHarness();
		prewalkExtension(parent.pi);
		await parent.emit("session_start", { type: "session_start", reason: "startup" });
		await parent.commands.get("prewalk")?.("run", parent.context);
		await parent.emit("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", content: [] },
			toolResults: [],
		});
		await parent.emit("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "subagent-1",
			toolName: "subagent",
			args: { agent: "worker" },
		});
		expect(parent.statuses.at(-1)).toContain("worker running its own Prewalk");
		await parent.emit("tool_result", {
			type: "tool_result",
			toolCallId: "subagent-1",
			toolName: "subagent",
			input: { agent: "worker" },
			content: [],
			isError: false,
			details: {
				mode: "single",
				results: [{ agent: "worker", sessionFile: childSession }],
			},
		});

		expect(parent.statuses.at(-1)).toContain("worker Prewalk failed: todo conflict");
		await parent.commands.get("prewalk")?.("status", parent.context);
		expect(parent.notifications.at(-1)).toContain("delegation=worker failed");
		expect(parent.notifications.at(-1)).toContain("delegation reason=todo-conflict");
	});

	it("keeps evidence from serial delegation invocations in one task tree", async () => {
		const harness = createHarness();
		prewalkExtension(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });

		for (const [index, costUsd] of [0.1, 0.2].entries()) {
			await harness.emit("tool_execution_start", {
				type: "tool_execution_start",
				toolCallId: `tool-${index}`,
				toolName: "subagent",
				args: { agent: "reviewer", task: `task-${index}` },
			});
			const lineage = {
				version: 1,
				rootSessionId: "session-extension-test",
				parentSessionId: "session-extension-test",
				invocationId: `tool-${index}`,
				delegationRunId: `run-${index}`,
				childIndex: 0,
				childSessionId: `child-${index}`,
				observedAt: index + 1,
			};
			harness.emitBus(SUBAGENT_DELEGATION_ANALYTICS_START_EVENT, {
				...lineage,
				eventId: `start-${index}`,
				phase: "start",
				lifecycle: "running",
				usage: [],
			});
			harness.emitBus(SUBAGENT_DELEGATION_ANALYTICS_TERMINAL_EVENT, {
				...lineage,
				eventId: `terminal-${index}`,
				phase: "terminal",
				lifecycle: "completed",
				usage: [
					{
						evidenceKey: `usage-${index}`,
						category: "child",
						inputTokens: 1,
						outputTokens: 1,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						totalTokens: 2,
						turns: 1,
						costUsd,
					},
				],
			});
		}

		await harness.commands.get("prewalk")?.("stats task", harness.context);

		expect(harness.notifications.at(-1)).toContain("fallback records 2");
		expect(harness.notifications.at(-1)).toContain("Total task tree actual: $0.300000");
	});

	it.each(["help", "--help"])("shows the quick guide for %s", async (command) => {
		const harness = createHarness();
		prewalkExtension(harness.pi);

		await harness.commands.get("prewalk")?.(command, harness.context);

		expect(harness.notifications.at(-1)).toContain("Prewalk quick guide");
		expect(harness.notifications.at(-1)).toContain("/prewalk status");
		expect(harness.notifications.at(-1)).toContain("/prewalk stats");
		expect(harness.notifications.at(-1)).toContain("Actual means Pi-reported");
		expect(harness.notifications.at(-1)).toContain("Export refuses existing destinations");
		expect(harness.notifications.at(-1)).toContain("/prewalk cancel, then /prewalk run");
		expect(harness.notifications.at(-1)).toContain("/prewalk run");
		expect(harness.notifications.at(-1)).toContain("/prewalk configure");
		expect(harness.notifications.at(-1)).toContain("/reload");
		expect(harness.notifications.at(-1)).toContain("prewalk.json");
		expect(harness.notifications.at(-1)).toContain(
			"derives the planner from Pi's selected model and reasoning",
		);
	});

	it("collects planner and later executor turns until shutdown, then reports the receipt", async () => {
		const harness = createHarness();
		prewalkExtension(harness.pi);
		await reachHandoff(harness);
		await harness.emit("message_end", {
			type: "message_end",
			message: assistant(harness.planner),
		});
		await harness.emit("agent_start", { type: "agent_start" });
		await harness.providerConfig()?.streamSimple?.(harness.planner, { messages: [] }).result();
		await harness.emit("message_end", {
			type: "message_end",
			message: assistant(harness.executor),
		});
		await harness.emit("message_end", {
			type: "message_end",
			message: assistant(harness.executor),
		});
		const runId = (harness.entries[0]?.data as { runId: string }).runId;

		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		await harness.commands.get("prewalk")?.("stats", harness.context);
		expect(harness.notifications.at(-1)).toContain("Lifetime: 1 receipts");
		expect(harness.notifications.at(-1)).toContain("actual $4.000000");
		expect(harness.notifications.at(-1)).toContain(`${runId}: succeeded`);
		await harness.commands.get("prewalk")?.("stats --successful", harness.context);
		expect(harness.notifications.at(-1)).toContain("Lifetime: 1 receipts");

		await harness.commands.get("prewalk")?.(`stats receipt ${runId}`, harness.context);
		expect(harness.notifications.at(-1)).toContain("Actual detail: planner primary $2.000000");
		expect(harness.notifications.at(-1)).toContain("executor primary $2.000000");
		expect(harness.notifications.at(-1)).toContain("Savings unavailable");
	});

	it("refuses an existing export destination without changing its bytes", async () => {
		const harness = createHarness();
		prewalkExtension(harness.pi);
		const destination = path.join(agentDir, "existing.jsonl");
		await writeFile(destination, "keep-this\n");

		await harness.commands.get("prewalk")?.(`stats export ${destination}`, harness.context);

		expect(await readFile(destination, "utf8")).toBe("keep-this\n");
		expect(harness.notifications.at(-1)).toContain("choose a new filename");
	});

	it("requires reset confirmation and excludes an active run only after confirmation", async () => {
		const harness = createHarness();
		prewalkExtension(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("prewalk")?.("run", harness.context);
		vi.mocked(harness.context.ui.confirm)
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);

		await harness.commands.get("prewalk")?.("stats reset", harness.context);
		expect(harness.notifications.at(-1)).toContain("nothing changed");
		await harness.commands.get("prewalk")?.("stats reset", harness.context);
		expect(harness.notifications.at(-1)).toContain("active run was excluded");
	});

	it("keeps routing active and stats readable when future analytics collection is disabled", async () => {
		await writeFile(
			path.join(agentDir, "prewalk.json"),
			`${JSON.stringify({
				executor: DEFAULT_EXECUTOR,
				analytics: {
					enabled: false,
					catalogFallbackEnabled: false,
					recentReceiptCount: 10,
					schemaVersion: 1,
				},
			})}\n`,
		);
		const harness = createHarness();
		prewalkExtension(harness.pi);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("prewalk")?.("run", harness.context);
		expect(harness.statuses.at(-1)).toContain("[5.6 Sol");
		await harness.commands.get("prewalk")?.("stats", harness.context);
		expect(harness.notifications.at(-1)).toContain("Lifetime: 0 receipts");
	});

	it("configures an executor without starting Prewalk work", async () => {
		const harness = createHarness();
		prewalkExtension(harness.pi);
		vi.mocked(harness.context.ui.select)
			.mockResolvedValueOnce("openai-codex/gpt-5.6-luna")
			.mockResolvedValueOnce("medium")
			.mockResolvedValueOnce("enabled")
			.mockResolvedValueOnce("disabled");
		vi.mocked(harness.context.ui.confirm).mockResolvedValueOnce(true);

		await harness.commands.get("prewalk")?.("configure", harness.context);

		expect(JSON.parse(await readFile(path.join(agentDir, "prewalk.json"), "utf8"))).toEqual({
			executor: { ...DEFAULT_EXECUTOR, reasoning: "medium" },
			analytics: {
				enabled: true,
				catalogFallbackEnabled: false,
				recentReceiptCount: 10,
				schemaVersion: 1,
			},
		});
		expect(harness.messages).toEqual([]);
		expect(harness.entries).toEqual([]);
		expect(harness.providerConfig()?.streamSimple).toBe(harness.baseStream);
		expect(harness.notifications.at(-1)).toContain("configuration saved");
		expect("setModel" in harness.pi).toBe(false);
	});

	it("defaults a newly selected executor to low reasoning", async () => {
		const harness = createHarness();
		prewalkExtension(harness.pi);
		await writeFile(
			path.join(agentDir, "prewalk.json"),
			`${JSON.stringify({
				executor: {
					provider: DEFAULT_EXECUTOR.provider,
					model: "another-executor",
					reasoning: "medium",
				},
			})}\n`,
		);
		vi.mocked(harness.context.ui.select)
			.mockResolvedValueOnce("openai-codex/gpt-5.6-luna")
			.mockResolvedValueOnce("low")
			.mockResolvedValueOnce("enabled")
			.mockResolvedValueOnce("disabled");
		vi.mocked(harness.context.ui.confirm).mockResolvedValueOnce(true);

		await harness.commands.get("prewalk")?.("configure", harness.context);

		expect(vi.mocked(harness.context.ui.select).mock.calls[1]?.[1]?.[0]).toBe("low");
		expect(JSON.parse(await readFile(path.join(agentDir, "prewalk.json"), "utf8"))).toMatchObject(
			{
				executor: { model: "gpt-5.6-luna", reasoning: "low" },
			},
		);
	});

	it("paginates long model lists instead of filling the terminal", async () => {
		const extraModels = Array.from({ length: 10 }, (_, index) => model(`extra-${index}`));
		const harness = createHarness({
			availableModels: [model(PLANNER_MODEL_ID), model(EXECUTOR_MODEL_ID), ...extraModels],
		});
		prewalkExtension(harness.pi);
		vi.mocked(harness.context.ui.select).mockResolvedValueOnce(undefined);

		await harness.commands.get("prewalk")?.("configure", harness.context);

		const firstPage = vi.mocked(harness.context.ui.select).mock.calls[0];
		expect(firstPage?.[0]).toBe("Prewalk executor (1/2)");
		expect(firstPage?.[1]).toHaveLength(9);
		expect(firstPage?.[1].at(-1)).toBe("Next page →");
	});

	it("starts a manual run, then routes Luna after the first mutation", async () => {
		const harness = createHarness();
		prewalkExtension(harness.pi);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("prewalk")?.("run", harness.context);
		expect(harness.delegated).toEqual([]);
		expect(harness.statuses.at(-1)).toBe("prewalk: [5.6 Sol · low] / Luna · low");

		expect(harness.messages.at(-1)?.customType).toBe(PREWALK_PLAN_MESSAGE_TYPE);

		await harness.emit("tool_result", {
			type: "tool_result",
			toolCallId: "todo-1",
			toolName: "todo",
			input: { op: "init" },
			content: [],
			isError: false,
			details: { phases: [] },
		});
		await harness.emit("tool_result", {
			type: "tool_result",
			toolCallId: "edit-1",
			toolName: "edit",
			input: {},
			content: [],
			isError: false,
			details: {},
		});
		await harness.emit("turn_end", {
			type: "turn_end",
			turnIndex: 1,
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "todo-1", name: "todo", arguments: {} },
					{ type: "toolCall", id: "edit-1", name: "edit", arguments: {} },
				],
			},
			toolResults: [],
		});
		expect(harness.messages.at(-1)?.customType).toBe(PREWALK_CHECKLIST_MESSAGE_TYPE);
		expect(harness.statuses.at(-1)).toBe(
			"prewalk: [5.6 Sol · low] / Luna · low (switching after this turn)",
		);

		const runId = (harness.entries[0]?.data as { runId: string }).runId;
		const [filtered] = await harness.emit("context", {
			type: "context",
			messages: [
				{
					role: "custom",
					customType: PREWALK_PLAN_MESSAGE_TYPE,
					content: "plan",
					display: false,
					details: { runId },
					timestamp: 1,
				},
				{
					role: "custom",
					customType: PREWALK_CONTINUE_MESSAGE_TYPE,
					content: "continue",
					display: false,
					details: { runId },
					timestamp: 1,
				},
				{
					role: "custom",
					customType: PREWALK_CHECKLIST_MESSAGE_TYPE,
					content: "checklist",
					display: false,
					details: { runId },
					timestamp: 1,
				},
			],
		});
		expect(
			(filtered as { messages: Array<{ customType: string }> }).messages.map(
				(message) => message.customType,
			),
		).toEqual([PREWALK_CHECKLIST_MESSAGE_TYPE]);

		await harness.emit("agent_start", { type: "agent_start" });
		const result = await harness
			.providerConfig()
			?.streamSimple?.(harness.planner, filtered as { messages: [] })
			.result();

		expect(harness.delegated).toEqual([harness.executor]);
		expect(result?.model).toBe(EXECUTOR_MODEL_ID);
		expect(harness.context.model).toBe(harness.planner);
		expect(harness.statuses.at(-1)).toBe("prewalk: 5.6 Sol · low / [Luna · low]");
	});

	it("derives a new epoch planner from Pi's selected runtime profile", async () => {
		const selectedPlanner = model("gpt-5.4");
		const harness = createHarness({ selectedModel: selectedPlanner });
		harness.context.thinkingLevel = "high";
		prewalkExtension(harness.pi);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("prewalk")?.("run", harness.context);

		expect(harness.entries.at(-1)?.data).toMatchObject({
			event: "plan-injected",
			planner: {
				provider: "openai-codex",
				model: "gpt-5.4",
				reasoning: "high",
			},
		});
		expect(harness.statuses.at(-1)).toBe("prewalk: [gpt-5.4 · high] / Luna · low");
	});

	it("answers pi-subagents policy requests only for the active session and epoch", async () => {
		const harness = createHarness();
		harness.context.thinkingLevel = "high";
		prewalkExtension(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("prewalk")?.("run", harness.context);
		const respond = vi.fn();

		harness.emitBus(EXECUTION_PROFILE_POLICY_REQUEST_EVENT, {
			version: 1,
			requestId: "request",
			sessionId: "session-extension-test",
			launchId: "launch",
			respond,
		});

		expect(respond).toHaveBeenCalledWith(
			"prewalk",
			expect.objectContaining({
				epoch: expect.any(String),
				status: "available",
				defaultProfile: {
					provider: "openai-codex",
					model: "gpt-5.6-luna",
					reasoning: "low",
				},
			}),
		);

		await harness.commands.get("prewalk")?.("cancel", harness.context);
		respond.mockClear();
		harness.emitBus(EXECUTION_PROFILE_POLICY_REQUEST_EVENT, {
			version: 1,
			requestId: "request-2",
			sessionId: "session-extension-test",
			launchId: "launch-2",
			respond,
		});
		expect(respond).not.toHaveBeenCalled();
	});

	it("uses Shift+Tab for the active Luna route without changing the saved baseline", async () => {
		const harness = createHarness();
		prewalkExtension(harness.pi);
		await reachHandoff(harness);
		await harness.emit("agent_start", { type: "agent_start" });
		await harness.providerConfig()?.streamSimple?.(harness.planner, { messages: [] }).result();

		expect(harness.terminalInput("\u001b[Z")).toEqual({ consume: true });
		expect(harness.statuses.at(-1)).toBe("prewalk: 5.6 Sol · low / [Luna · medium]");
		expect(harness.notifications.at(-1)).toBe("Luna reasoning: medium");

		await harness.emit("agent_start", { type: "agent_start" });
		await harness.providerConfig()?.streamSimple?.(harness.planner, { messages: [] }).result();
		expect(harness.delegatedOptions.at(-1)?.reasoning).toBe("medium");
		expect(JSON.parse(await readFile(path.join(agentDir, "prewalk.json"), "utf8"))).toMatchObject(
			{
				executor: { reasoning: "low" },
			},
		);
	});

	it("leaves Shift+Tab to Pi while Sol is active and refreshes its status event", async () => {
		const harness = createHarness();
		prewalkExtension(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("prewalk")?.("run", harness.context);

		expect(harness.terminalInput("\u001b[Z")).toBeUndefined();
		harness.context.thinkingLevel = "medium";
		await harness.emit("thinking_level_select", {
			type: "thinking_level_select",
			level: "medium",
			previousLevel: "low",
		});
		expect(harness.statuses.at(-1)).toBe("prewalk: [5.6 Sol · medium] / Luna · low");
	});

	it("does not reactivate Luna when an in-flight stream finishes after cancellation", async () => {
		const harness = createHarness();
		const delayed = createAssistantMessageEventStream();
		harness.setStream(() => delayed);
		prewalkExtension(harness.pi);
		await reachHandoff(harness);
		const runId = (harness.entries[0]?.data as { runId: string }).runId;

		await harness.emit("agent_start", { type: "agent_start" });
		const pending = harness
			.providerConfig()
			?.streamSimple?.(harness.planner, { messages: [] })
			.result();
		await harness.commands.get("prewalk")?.("cancel", harness.context);
		const message = assistant(harness.executor);
		delayed.push({ type: "start", partial: message });
		delayed.push({ type: "done", reason: "stop", message });
		delayed.end();
		await pending;

		expect(harness.statuses.at(-1)).toBe("prewalk: [5.6 Sol · low] / Luna · low (cancelled)");
		expect(harness.entries.at(-1)?.data).toMatchObject({
			event: "cancelled",
			phase: "cancelled",
			effectiveRoute: "planner",
		});
		await harness.commands.get("prewalk")?.(`stats receipt ${runId}`, harness.context);
		expect(harness.notifications.at(-1)).toContain("outcome cancelled");
		expect(harness.notifications.at(-1)).toContain("Savings unavailable");
	});

	it("detects provider replacement before the next Agent-loop request", async () => {
		const harness = createHarness();
		prewalkExtension(harness.pi);
		await reachHandoff(harness);
		harness.setProviderConfig(oauthConfig(() => doneStream(harness.planner)));

		await harness.emit("agent_start", { type: "agent_start" });

		expect(harness.notifications.at(-1)).toBe("Prewalk failed: provider-drift.");
		expect(harness.entries.at(-1)?.data).toMatchObject({
			event: "failed",
			reasonCode: "provider-drift",
		});
	});

	it("holds Luna routing after a delegated Luna failure", async () => {
		const harness = createHarness();
		harness.setStream((selected) => failedStream(selected as Model<"openai-codex-responses">));
		prewalkExtension(harness.pi);
		await reachHandoff(harness);
		const runId = (harness.entries[0]?.data as { runId: string }).runId;

		await harness.emit("agent_start", { type: "agent_start" });
		const failed = await harness
			.providerConfig()
			?.streamSimple?.(harness.planner, { messages: [] })
			.result();

		expect(failed?.stopReason).toBe("error");
		expect(failed?.errorMessage).toBe("Prewalk executor provider stream failed.");
		expect(harness.statuses.at(-1)).toBe(
			"prewalk: 5.6 Sol · low / [Luna · low] (failed: executor stream failed)",
		);
		expect(harness.entries.at(-1)?.data).toMatchObject({
			event: "failed",
			effectiveRoute: "executor",
			reasonCode: "executor-stream-failed",
		});
		await harness.commands.get("prewalk")?.(`stats receipt ${runId}`, harness.context);
		expect(harness.notifications.at(-1)).toContain("outcome failed");
		expect(harness.notifications.at(-1)).toContain("Savings unavailable");

		harness.setStream((selected) => doneStream(selected as Model<"openai-codex-responses">));
		await harness.emit("agent_start", { type: "agent_start" });
		await harness.providerConfig()?.streamSimple?.(harness.planner, { messages: [] }).result();
		expect(harness.delegated.at(-1)).toBe(harness.executor);
	});

	it("installs from Pi's built-in provider stream without the conversion extension", async () => {
		const harness = createHarness();
		harness.setProviderConfig(undefined);
		prewalkExtension(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("prewalk")?.("run", harness.context);

		expect(harness.notifications).toEqual([]);
		expect(harness.entries.at(-1)?.data).toMatchObject({
			event: "plan-injected",
			phase: "planning",
		});
		expect(harness.providerConfig()?.streamSimple).toBeTypeOf("function");
	});

	it("shows restored todo state without turn-driven completion reminders", async () => {
		const harness = createHarness();
		prewalkExtension(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("prewalk")?.("run", harness.context);
		await harness.emit("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", content: [] },
			toolResults: [],
		});
		const todoResult = await harness.tools.get("todo")?.execute(
			"todo-1",
			{
				op: "init",
				list: [{ phase: "Implement", items: ["Finish verification"] }],
			},
			undefined,
			undefined,
			harness.context,
		);
		await harness.emit("tool_result", {
			type: "tool_result",
			toolCallId: "todo-1",
			toolName: "todo",
			input: { op: "init" },
			content: todoResult?.content ?? [],
			isError: false,
			details: todoResult?.details,
		});
		await harness.emit("tool_result", {
			type: "tool_result",
			toolCallId: "edit-1",
			toolName: "edit",
			input: {},
			content: [],
			isError: false,
			details: {},
		});
		await harness.emit("turn_end", {
			type: "turn_end",
			turnIndex: 1,
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "todo-1", name: "todo", arguments: {} },
					{ type: "toolCall", id: "edit-1", name: "edit", arguments: {} },
				],
			},
			toolResults: [],
		});
		await harness.emit("agent_start", { type: "agent_start" });
		await harness.providerConfig()?.streamSimple?.(harness.planner, { messages: [] }).result();
		await harness.commands.get("todos")?.("", harness.context);
		expect(harness.notifications.at(-1)).toContain("Finish verification");

		await harness.emit("agent_settled", { type: "agent_settled" });
		const firstReminderCount = harness.messages.filter(
			(message) => message.customType === "prewalk-todo-reminder",
		).length;
		expect(firstReminderCount).toBe(0);

		await harness.emit("agent_settled", { type: "agent_settled" });
		expect(
			harness.messages.filter((message) => message.customType === "prewalk-todo-reminder"),
		).toHaveLength(0);
	});

	it("restores a completed Luna run on reload without adding an arm or request", async () => {
		const first = createHarness();
		prewalkExtension(first.pi);
		await reachHandoff(first);
		await first.emit("agent_start", { type: "agent_start" });
		await first.providerConfig()?.streamSimple?.(first.planner, { messages: [] }).result();

		const restored = createHarness();
		restored.setBranch(auditBranch(first));
		prewalkExtension(restored.pi);
		await restored.emit("session_start", { type: "session_start", reason: "reload" });

		expect(restored.delegated).toEqual([]);
		expect(restored.statuses.at(-1)).toBe("prewalk: 5.6 Sol · low / [Luna · low]");
		await restored.emit("agent_start", { type: "agent_start" });
		await restored.providerConfig()?.streamSimple?.(restored.planner, { messages: [] }).result();
		expect(restored.delegated).toEqual([restored.executor]);
		expect(restored.entries).toEqual([]);
	});

	it("retries a repaired startup configuration on reload", async () => {
		await writeFile(path.join(agentDir, "prewalk.json"), "{}\n");
		const failed = createHarness();
		prewalkExtension(failed.pi);
		await failed.emit("session_start", { type: "session_start", reason: "startup" });
		await failed.commands.get("prewalk")?.("run", failed.context);
		expect(failed.statuses.at(-1)).toBe(
			"prewalk: [5.6 Sol · low] / Luna · low (failed: configuration invalid)",
		);

		await writeFile(
			path.join(agentDir, "prewalk.json"),
			`${JSON.stringify({
				executor: DEFAULT_EXECUTOR,
			})}\n`,
		);
		const restored = createHarness();
		restored.setBranch(auditBranch(failed));
		prewalkExtension(restored.pi);
		await restored.emit("session_start", { type: "session_start", reason: "reload" });

		expect(restored.statuses.at(-1)).toBe("prewalk: [5.6 Sol · low] / Luna · low");
		expect(restored.delegated).toEqual([]);
		expect(restored.entries.at(-1)?.data).toMatchObject({
			event: "armed",
			effectiveRoute: "planner",
		});
	});

	it("restores planning and failed Luna runs without adding an arm", async () => {
		const planning = createHarness();
		prewalkExtension(planning.pi);
		await planning.emit("session_start", { type: "session_start", reason: "startup" });
		await planning.commands.get("prewalk")?.("run", planning.context);
		await planning.emit("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", content: [] },
			toolResults: [],
		});

		const restoredPlanning = createHarness();
		restoredPlanning.setBranch(auditBranch(planning));
		prewalkExtension(restoredPlanning.pi);
		await restoredPlanning.emit("session_start", {
			type: "session_start",
			reason: "reload",
		});
		expect(restoredPlanning.statuses.at(-1)).toBe("prewalk: [5.6 Sol · low] / Luna · low");
		expect(restoredPlanning.entries).toEqual([]);
		expect(restoredPlanning.delegated).toEqual([]);

		const failed = createHarness();
		failed.setStream((selected) => failedStream(selected as Model<"openai-codex-responses">));
		prewalkExtension(failed.pi);
		await reachHandoff(failed);
		await failed.emit("agent_start", { type: "agent_start" });
		await failed.providerConfig()?.streamSimple?.(failed.planner, { messages: [] }).result();

		const restoredFailure = createHarness();
		restoredFailure.setBranch(auditBranch(failed));
		prewalkExtension(restoredFailure.pi);
		await restoredFailure.emit("session_start", {
			type: "session_start",
			reason: "reload",
		});
		expect(restoredFailure.statuses.at(-1)).toBe(
			"prewalk: 5.6 Sol · low / [Luna · low] (failed: executor stream failed)",
		);
		await restoredFailure.emit("agent_start", { type: "agent_start" });
		await restoredFailure
			.providerConfig()
			?.streamSimple?.(restoredFailure.planner, { messages: [] })
			.result();
		expect(restoredFailure.delegated).toEqual([restoredFailure.executor]);
		expect(restoredFailure.entries).toEqual([]);
	});

	it("restores a cancelled run without validating models or reinstalling the overlay", async () => {
		const first = createHarness();
		prewalkExtension(first.pi);
		await first.emit("session_start", { type: "session_start", reason: "startup" });
		await first.commands.get("prewalk")?.("run", first.context);
		await first.commands.get("prewalk")?.("cancel", first.context);

		const restored = createHarness();
		(restored.context as { model: Model<"openai-codex-responses"> }).model = restored.executor;
		restored.setBranch(auditBranch(first));
		prewalkExtension(restored.pi);
		await restored.emit("session_start", { type: "session_start", reason: "reload" });

		expect(restored.providerConfig()?.streamSimple).toBe(restored.baseStream);
		expect(restored.statuses.at(-1)).toBe(
			"prewalk: 5.6 Sol / Luna (cancelled; selected: openai-codex/gpt-5.6-luna)",
		);
		expect(restored.entries).toEqual([]);
	});

	it("does not re-arm continuation from arbitrary tool results across reload", async () => {
		const first = createHarness();
		prewalkExtension(first.pi);
		await first.emit("session_start", { type: "session_start", reason: "startup" });
		await first.commands.get("prewalk")?.("run", first.context);
		await first.emit("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", content: [] },
			toolResults: [],
		});
		await first.emit("turn_end", {
			type: "turn_end",
			turnIndex: 1,
			message: { role: "assistant", content: [] },
			toolResults: [],
		});
		await first.emit("tool_result", {
			type: "tool_result",
			toolCallId: "read-1",
			toolName: "read",
			input: {},
			content: [],
			isError: false,
			details: {},
		});
		await first.emit("turn_end", {
			type: "turn_end",
			turnIndex: 2,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }],
			},
			toolResults: [],
		});
		expect(first.entries.at(-1)?.data).toMatchObject({
			event: "plan-injected",
			continuePending: false,
		});

		const restored = createHarness();
		restored.setBranch(auditBranch(first));
		prewalkExtension(restored.pi);
		await restored.emit("session_start", { type: "session_start", reason: "reload" });
		await restored.emit("turn_end", {
			type: "turn_end",
			turnIndex: 3,
			message: { role: "assistant", content: [] },
			toolResults: [],
		});

		expect(restored.messages).toEqual([]);
	});

	it("restores the conversion provider when a live run is cancelled", async () => {
		const harness = createHarness();
		prewalkExtension(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("prewalk")?.("run", harness.context);
		expect(harness.providerConfig()?.streamSimple).not.toBe(harness.baseStream);

		await harness.commands.get("prewalk")?.("cancel", harness.context);

		expect(harness.providerConfig()?.streamSimple).toBe(harness.baseStream);
	});

	it("cancels on an explicit model selection but ignores restore selection", async () => {
		const restoredSelection = createHarness();
		prewalkExtension(restoredSelection.pi);
		await restoredSelection.emit("session_start", {
			type: "session_start",
			reason: "startup",
		});
		await restoredSelection.commands.get("prewalk")?.("run", restoredSelection.context);
		await restoredSelection.emit("model_select", {
			type: "model_select",
			source: "restore",
			model: restoredSelection.executor,
		});
		expect(restoredSelection.entries.at(-1)?.data).toMatchObject({ event: "plan-injected" });

		const explicitSelection = createHarness();
		prewalkExtension(explicitSelection.pi);
		await reachHandoff(explicitSelection);
		await explicitSelection.emit("agent_start", { type: "agent_start" });
		await explicitSelection
			.providerConfig()
			?.streamSimple?.(explicitSelection.planner, { messages: [] })
			.result();
		(explicitSelection.context as { model: Model<"openai-codex-responses"> }).model =
			explicitSelection.executor;
		await explicitSelection.emit("model_select", {
			type: "model_select",
			source: "user",
			model: explicitSelection.executor,
		});
		expect(explicitSelection.statuses.at(-1)).toBe(
			"prewalk: 5.6 Sol / Luna (cancelled; selected: openai-codex/gpt-5.6-luna)",
		);
		expect(explicitSelection.entries.at(-1)?.data).toMatchObject({
			event: "cancelled",
			effectiveRoute: "selected",
		});
	});

	it("scrubs hidden guidance after cancellation and from compaction", async () => {
		const harness = createHarness();
		prewalkExtension(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.emit("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", content: [] },
			toolResults: [],
		});
		const prompt = {
			role: "custom",
			customType: PREWALK_PLAN_MESSAGE_TYPE,
			content: "hidden",
			display: false,
			details: { runId: harness.entries[0]?.data && (harness.entries[0].data as any).runId },
			timestamp: 1,
		};

		await harness.commands.get("prewalk")?.("cancel", harness.context);
		const [contextResult] = await harness.emit("context", {
			type: "context",
			messages: [prompt, { role: "user", content: [], timestamp: 1 }],
		});
		expect((contextResult as { messages: unknown[] }).messages).toHaveLength(1);

		const preparation = {
			messagesToSummarize: [prompt, { role: "user", content: [], timestamp: 1 }],
			turnPrefixMessages: [prompt],
		};
		await harness.emit("session_before_compact", {
			type: "session_before_compact",
			preparation,
		});
		expect(preparation.messagesToSummarize).toHaveLength(1);
		expect(preparation.turnPrefixMessages).toEqual([]);
	});
});
