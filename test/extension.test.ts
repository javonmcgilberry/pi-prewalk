import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
	EXECUTOR_MODEL_ID,
	PLANNER_MODEL_ID,
	PREWALK_CHECKLIST_MESSAGE_TYPE,
	PREWALK_CONTINUE_MESSAGE_TYPE,
	PREWALK_PLAN_MESSAGE_TYPE,
} from "../src/core.js";

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

function createHarness(options: { foreignTodo?: ToolDefinition } = {}) {
	const handlers = new Map<string, Handler[]>();
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
	const delegatedContexts: Array<{ messages: unknown[] }> = [];
	const planner = model(PLANNER_MODEL_ID);
	const executor = model(EXECUTOR_MODEL_ID);
	let streamImpl: NonNullable<ProviderConfig["streamSimple"]> = (selected) =>
		doneStream(selected as Model<"openai-codex-responses">);
	const baseStream: NonNullable<ProviderConfig["streamSimple"]> = (
		selected,
		streamContext,
		options,
	) => {
		delegated.push(selected as Model<"openai-codex-responses">);
		delegatedContexts.push(streamContext);
		return streamImpl(selected, streamContext, options);
	};
	let providerConfig: ProviderConfig | undefined = oauthConfig(baseStream);
	let branch: unknown[] = [];

	const pi = {
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
		getAllTools: vi.fn(() => [
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
		]),
		getActiveTools: vi.fn(() => ["todo", "edit", "write", "bash"]),
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
		modelRegistry,
		ui: {
			setStatus: (_key: string, value: string | undefined) => {
				statuses.push(value);
			},
			notify: (message: string) => {
				notifications.push(message);
			},
		},
		sessionManager: {
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
		tools,
		messages,
		messageOptions,
		entries,
		statuses,
		notifications,
		delegated,
		delegatedContexts,
		emit,
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
	await writeFile(path.join(agentDir, "prewalk.json"), `${JSON.stringify({ enabled: true })}\n`);
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

		expect(harness.tools.get("todo")).toBe(foreignTodo);
		expect(harness.notifications.at(-1)).toBe("Prewalk failed: todo-conflict.");
		expect(harness.delegated).toEqual([]);
		expect(harness.entries.at(-1)?.data).toMatchObject({
			event: "failed",
			reasonCode: "todo-conflict",
		});
	});

	it("arms without a request, plans after Sol's first turn, then routes Luna", async () => {
		const harness = createHarness();
		prewalkExtension(harness.pi);

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		expect(harness.delegated).toEqual([]);
		expect(harness.statuses.at(-1)).toBe("prewalk: [5.6 Sol] / Luna");

		await harness.emit("turn_end", {
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", content: [] },
			toolResults: [],
		});
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
		expect(harness.statuses.at(-1)).toBe("prewalk: 5.6 Sol / [Luna]");
	});

	it("does not reactivate Luna when an in-flight stream finishes after cancellation", async () => {
		const harness = createHarness();
		const delayed = createAssistantMessageEventStream();
		harness.setStream(() => delayed);
		prewalkExtension(harness.pi);
		await reachHandoff(harness);

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

		expect(harness.statuses.at(-1)).toBe("prewalk: [5.6 Sol] / Luna (cancelled)");
		expect(harness.entries.at(-1)?.data).toMatchObject({
			event: "cancelled",
			phase: "cancelled",
			effectiveRoute: "sol",
		});
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

		await harness.emit("agent_start", { type: "agent_start" });
		const failed = await harness
			.providerConfig()
			?.streamSimple?.(harness.planner, { messages: [] })
			.result();

		expect(failed?.stopReason).toBe("error");
		expect(failed?.errorMessage).toBe("Prewalk Luna provider stream failed.");
		expect(harness.statuses.at(-1)).toBe("prewalk: 5.6 Sol / [Luna] (failed)");
		expect(harness.entries.at(-1)?.data).toMatchObject({
			event: "failed",
			effectiveRoute: "luna",
			reasonCode: "luna-stream-failed",
		});

		harness.setStream((selected) => doneStream(selected as Model<"openai-codex-responses">));
		await harness.emit("agent_start", { type: "agent_start" });
		await harness.providerConfig()?.streamSimple?.(harness.planner, { messages: [] }).result();
		expect(harness.delegated.at(-1)).toBe(harness.executor);
	});

	it("can install the overlay on a manual retry after startup failure", async () => {
		const harness = createHarness();
		harness.setProviderConfig(undefined);
		prewalkExtension(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		expect(harness.notifications.at(-1)).toBe("Prewalk failed: provider-unavailable.");

		harness.setProviderConfig(oauthConfig(harness.baseStream));
		await harness.commands.get("prewalk")?.("run", harness.context);

		expect(harness.messages.at(-1)?.customType).toBe(PREWALK_PLAN_MESSAGE_TYPE);
		expect(harness.entries.at(-1)?.data).toMatchObject({
			event: "plan-injected",
			phase: "planning",
		});
	});

	it("shows restored todo state and sends one bounded completion reminder", async () => {
		const harness = createHarness();
		prewalkExtension(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
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
		expect(firstReminderCount).toBe(1);
		expect(harness.messageOptions.at(-1)).toEqual({
			triggerTurn: true,
			deliverAs: "followUp",
		});

		await harness.emit("agent_settled", { type: "agent_settled" });
		expect(
			harness.messages.filter((message) => message.customType === "prewalk-todo-reminder"),
		).toHaveLength(1);
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
		expect(restored.statuses.at(-1)).toBe("prewalk: 5.6 Sol / [Luna]");
		await restored.emit("agent_start", { type: "agent_start" });
		await restored.providerConfig()?.streamSimple?.(restored.planner, { messages: [] }).result();
		expect(restored.delegated).toEqual([restored.executor]);
		expect(restored.entries).toEqual([]);
	});

	it("restores planning and failed Luna runs without adding an arm", async () => {
		const planning = createHarness();
		prewalkExtension(planning.pi);
		await planning.emit("session_start", { type: "session_start", reason: "startup" });
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
		expect(restoredPlanning.statuses.at(-1)).toBe("prewalk: [5.6 Sol] / Luna");
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
		expect(restoredFailure.statuses.at(-1)).toBe("prewalk: 5.6 Sol / [Luna] (failed)");
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
		await first.commands.get("prewalk")?.("cancel", first.context);

		const restored = createHarness();
		(restored.context as { model: Model<"openai-codex-responses"> }).model = restored.executor;
		restored.setBranch(auditBranch(first));
		prewalkExtension(restored.pi);
		await restored.emit("session_start", { type: "session_start", reason: "reload" });

		expect(restored.providerConfig()?.streamSimple).toBe(restored.baseStream);
		expect(restored.statuses.at(-1)).toBe(
			"prewalk: 5.6 Sol / Luna (cancelled; Pi: openai-codex/gpt-5.6-luna)",
		);
		expect(restored.entries).toEqual([]);
	});

	it("persists a re-armed continuation across reload", async () => {
		const first = createHarness();
		prewalkExtension(first.pi);
		await first.emit("session_start", { type: "session_start", reason: "startup" });
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
			event: "progress",
			continuePending: true,
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

		expect(restored.messages.at(-1)?.customType).toBe(PREWALK_CONTINUE_MESSAGE_TYPE);
	});

	it("restores the conversion provider when a live run is cancelled", async () => {
		const harness = createHarness();
		prewalkExtension(harness.pi);
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
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
		await restoredSelection.emit("model_select", {
			type: "model_select",
			source: "restore",
			model: restoredSelection.executor,
		});
		expect(restoredSelection.entries.at(-1)?.data).toMatchObject({ event: "armed" });

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
			"prewalk: 5.6 Sol / Luna (cancelled; Pi: openai-codex/gpt-5.6-luna)",
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
