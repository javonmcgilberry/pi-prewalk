import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockedPaths = vi.hoisted(() => ({
	agentDir: `/tmp/pi-prewalk-extension-tests-${process.pid}`,
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => mockedPaths.agentDir,
}));

import prewalkExtension from "../extensions/prewalk.js";
import { CHECKPOINT_TOOL, type PrewalkConfig } from "../src/core.js";

interface CapturedTool {
	name: string;
	executionMode?: string;
	execute(toolCallId: string, params: { runId: string; items: string[] }): Promise<unknown>;
}

interface CapturedCommand {
	handler(args: string, ctx: TestContext): Promise<void> | void;
}

interface TestContext {
	model: Model<Api>;
	thinkingLevel: string;
	modelRegistry: {
		find(provider: string, id: string): Model<Api> | undefined;
		hasConfiguredAuth(model: Model<Api>): boolean;
		getProvider(provider: string): { id: string; name: string; baseUrl?: string } | undefined;
		getRecipientDescriptor(selected: Model<Api>): {
			provider: string;
			providerBaseUrl?: string;
			modelBaseUrl?: string;
			api: string;
			model: string;
			streamImplementationId?: string;
		};
	};
	isProjectTrusted(): boolean;
	ui: {
		notifications: Array<{ message: string; level: string }>;
		statuses: Array<string | undefined>;
		confirmResponses: boolean[];
		notify(message: string, level: string): void;
		setStatus(key: string, value: string | undefined): void;
		setWidget(): never;
		confirm(title: string, message: string): Promise<boolean>;
	};
}

type EventHandler = (event: Record<string, unknown>, ctx: TestContext) => unknown;

const CHECKPOINT_ITEMS = ["inspect", "test", "edit", "verify", "review"];
const CONFIG_PATH = path.join(mockedPaths.agentDir, "prewalk.json");

function model(
	provider: string,
	id: string,
	baseUrl = `https://${provider}.example.test/v1`,
): Model<Api> {
	return {
		provider,
		id,
		name: `${provider} ${id}`,
		api: "openai-responses",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
	} as Model<Api>;
}

async function writeConfig(config: Partial<PrewalkConfig> = {}): Promise<void> {
	await mkdir(mockedPaths.agentDir, { recursive: true });
	await writeFile(
		CONFIG_PATH,
		`${JSON.stringify({
			enabled: true,
			target: "planner/target",
			thinkingLevel: "low",
			crossProviderPairs: [],
			...config,
		})}\n`,
	);
}

async function readConfig(): Promise<PrewalkConfig> {
	return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as PrewalkConfig;
}

function createHarness(options: { target?: Model<Api>; planner?: Model<Api> } = {}) {
	const planner = options.planner ?? model("planner", "planner");
	let target = options.target ?? model("planner", "target");
	let authConfigured = true;
	let switchError: Error | undefined;
	const handlers = new Map<string, EventHandler[]>();
	let checkpointTool: CapturedTool | undefined;
	let command: CapturedCommand | undefined;
	const switchCalls: Array<{ target: Model<Api>; thinkingLevel: string }> = [];
	let forbiddenRequests = 0;
	const customToolNames = new Set<string>();
	const streamImplementationIds = new Map<string, string | undefined>();

	const ctx: TestContext = {
		model: planner,
		thinkingLevel: "medium",
		modelRegistry: {
			find(provider, id) {
				return target.provider === provider && target.id === id ? target : undefined;
			},
			hasConfiguredAuth() {
				return authConfigured;
			},
			getProvider(provider) {
				if (provider === planner.provider) {
					return { id: provider, name: provider, baseUrl: planner.baseUrl };
				}
				if (provider === target.provider) {
					return { id: provider, name: provider, baseUrl: target.baseUrl };
				}
				return undefined;
			},
			getRecipientDescriptor(selected) {
				return {
					provider: selected.provider,
					providerBaseUrl: selected.baseUrl,
					modelBaseUrl: selected.baseUrl,
					api: selected.api,
					model: selected.id,
					streamImplementationId: streamImplementationIds.has(selected.provider)
						? streamImplementationIds.get(selected.provider)
						: `test-stream:${selected.provider}`,
				};
			},
		},
		isProjectTrusted: () => true,
		ui: {
			notifications: [],
			statuses: [],
			confirmResponses: [],
			notify(message, level) {
				this.notifications.push({ message, level });
			},
			setStatus(_key, value) {
				this.statuses.push(value);
			},
			setWidget() {
				throw new Error("Prewalk must not install a handoff widget");
			},
			async confirm() {
				return this.confirmResponses.shift() ?? false;
			},
		},
	};

	const fakePi = {
		registerFlag() {
			throw new Error("Prewalk must not register custom process flags");
		},
		registerTool(tool: CapturedTool) {
			if (tool.name === CHECKPOINT_TOOL) checkpointTool = tool;
		},
		registerCommand(_name: string, registered: CapturedCommand) {
			command = registered;
		},
		on(event: string, handler: EventHandler) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		getActiveTools: () => [CHECKPOINT_TOOL, "read", "grep", "find", "ls", "edit", "write"],
		getAllTools: () => [
			...["read", "grep", "find", "ls", "edit", "write"].map((name) => ({
				name,
				description: name,
				parameters: {},
				sourceInfo: { source: customToolNames.has(name) ? "extension" : "builtin" },
			})),
		],
		getThinkingLevel: () => ctx.thinkingLevel,
		sendMessage() {
			forbiddenRequests += 1;
			throw new Error("Prewalk must not enqueue model requests");
		},
		async setSessionModelAndThinkingLevel(nextTarget: Model<Api>, thinkingLevel: string) {
			switchCalls.push({ target: nextTarget, thinkingLevel });
			if (switchError) throw switchError;
		},
		setModel() {
			throw new Error("persistent model setter must not be used");
		},
		setThinkingLevel() {
			throw new Error("persistent thinking setter must not be used");
		},
	} as unknown as ExtensionAPI;

	prewalkExtension(fakePi);

	async function emit(event: string, payload: Record<string, unknown> = {}): Promise<unknown> {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) {
			const next = await handler(payload, ctx);
			if (next !== undefined) result = next;
		}
		return result;
	}

	async function runCommand(args: string): Promise<void> {
		if (!command) throw new Error("Prewalk command was not registered");
		await command.handler(args, ctx);
	}

	function planningMessage(result: unknown): string | undefined {
		const messages = (result as { messages?: AgentMessage[] } | undefined)?.messages;
		const message = messages?.at(-1);
		const content = message && "content" in message ? message.content : undefined;
		return typeof content === "string" ? content : undefined;
	}

	async function activateAndCheckpoint(): Promise<void> {
		await emit("tool_result", {
			toolName: "read",
			toolCallId: "read-1",
			input: {},
			isError: false,
		});
		const projected = await emit("context", { messages: [] });
		const prompt = planningMessage(projected);
		const runId = prompt?.match(/runId\s+"([^"]+)"/)?.[1];
		if (!runId || !checkpointTool) throw new Error("Planning run was not projected");
		await checkpointTool.execute("checkpoint-1", {
			runId,
			items: CHECKPOINT_ITEMS,
		});
		await emit("tool_result", {
			toolName: CHECKPOINT_TOOL,
			toolCallId: "checkpoint-1",
			input: { runId, items: CHECKPOINT_ITEMS },
			isError: false,
		});
	}

	return {
		ctx,
		emit,
		runCommand,
		activateAndCheckpoint,
		get checkpointTool() {
			return checkpointTool;
		},
		setCustomTool(name: string, custom = true) {
			if (custom) customToolNames.add(name);
			else customToolNames.delete(name);
		},
		setStreamImplementationId(provider: string, value: string | undefined) {
			streamImplementationIds.set(provider, value);
		},
		get switchCalls() {
			return switchCalls;
		},
		get forbiddenRequests() {
			return forbiddenRequests;
		},
		setAuthConfigured(value: boolean) {
			authConfigured = value;
		},
		setTarget(value: Model<Api>) {
			target = value;
		},
		setSwitchError(error: Error | undefined) {
			switchError = error;
		},
	};
}

beforeEach(async () => {
	await rm(mockedPaths.agentDir, { recursive: true, force: true });
	await mkdir(mockedPaths.agentDir, { recursive: true });
});

describe("extension adapter", () => {
	it("throws for a rejected checkpoint so Pi records an error result", async () => {
		const harness = createHarness();
		const checkpointTool = harness.checkpointTool;
		expect(checkpointTool).toBeDefined();
		if (!checkpointTool) throw new Error("Checkpoint tool was not registered");
		await expect(
			checkpointTool.execute("checkpoint-1", {
				runId: "stale-run",
				items: CHECKPOINT_ITEMS,
			}),
		).rejects.toThrow("Prewalk checkpoint rejected");
	});

	it("ordinary automatic settlement adds no request and leaves no projection", async () => {
		await writeConfig();
		const harness = createHarness();
		await harness.emit("session_start", { reason: "new" });
		expect(await harness.emit("context", { messages: [] })).toBeUndefined();
		await harness.emit("agent_settled");
		expect(await harness.emit("context", { messages: [] })).toBeUndefined();
		expect(harness.forbiddenRequests).toBe(0);
	});

	it("manual run arms planning without queueing a model request", async () => {
		await writeConfig();
		const harness = createHarness();
		await harness.runCommand("run");
		const projected = await harness.emit("context", { messages: [] });
		expect(harness.forbiddenRequests).toBe(0);
		expect((projected as { messages: AgentMessage[] }).messages).toHaveLength(1);
	});

	it("activates context-only guidance on a successful exploration result", async () => {
		await writeConfig();
		const harness = createHarness();
		await harness.emit("session_start", { reason: "new" });
		const original: AgentMessage[] = [{ role: "user", content: "keep", timestamp: 1 }];
		expect(await harness.emit("context", { messages: original })).toBeUndefined();
		await harness.emit("tool_result", {
			toolName: "read",
			toolCallId: "read-1",
			input: {},
			isError: false,
		});
		const projected = (await harness.emit("context", {
			messages: original,
		})) as { messages: AgentMessage[] };
		expect(original).toHaveLength(1);
		expect(projected.messages).toHaveLength(2);
		expect(projected.messages[0]).toBe(original[0]);
		const guidance = projected.messages[1];
		expect(guidance).toBeDefined();
		const guidanceText = guidance && "content" in guidance ? String(guidance.content) : "";
		expect(guidanceText).toContain("Prewalk planning mode");
		expect(guidanceText).toContain("If the user's task is read-only or no mutation is needed");
		expect(guidanceText).not.toContain(
			"This is not a request to stop at the plan: proceed to that first mutation",
		);
	});

	it("ignores custom tools that collide with built-in planning and mutation names", async () => {
		await writeConfig();
		const harness = createHarness();
		await harness.emit("session_start", { reason: "new" });
		harness.setCustomTool("read");
		await harness.emit("tool_result", {
			toolName: "read",
			toolCallId: "custom-read",
			isError: false,
		});
		expect(await harness.emit("context", { messages: [] })).toBeUndefined();

		harness.setCustomTool("read", false);
		await harness.activateAndCheckpoint();
		harness.setCustomTool("edit");
		expect(
			await harness.emit("tool_call", {
				toolName: "edit",
				toolCallId: "custom-edit",
			}),
		).toBeUndefined();
		await harness.emit("tool_result", {
			toolName: "edit",
			toolCallId: "custom-edit",
			isError: false,
		});
		await harness.emit("turn_end");
		expect(harness.switchCalls).toHaveLength(0);
	});

	it("blocks a direct mutation before checkpoint and activates recovery guidance", async () => {
		await writeConfig();
		const harness = createHarness();
		await harness.emit("session_start", { reason: "new" });
		const result = await harness.emit("tool_call", {
			toolName: "edit",
			toolCallId: "edit-0",
			input: {},
		});
		expect(result).toMatchObject({ block: true });
		expect(await harness.emit("context", { messages: [] })).toMatchObject({
			messages: expect.any(Array),
		});
	});

	it("keeps checkpoint and edit sequential in the same assistant tool batch", async () => {
		await writeConfig();
		const harness = createHarness();
		await harness.emit("session_start", { reason: "new" });
		expect(harness.checkpointTool?.executionMode).toBe("sequential");
		await harness.activateAndCheckpoint();
		expect(
			await harness.emit("tool_call", {
				toolName: "edit",
				toolCallId: "edit-1",
				input: {},
			}),
		).toBeUndefined();
	});

	it("releases a failed mutation reservation and switches once after the later success", async () => {
		await writeConfig();
		const harness = createHarness();
		await harness.emit("session_start", { reason: "new" });
		await harness.activateAndCheckpoint();
		await harness.emit("tool_call", {
			toolName: "edit",
			toolCallId: "edit-1",
			input: {},
		});
		await harness.emit("tool_result", {
			toolName: "edit",
			toolCallId: "edit-1",
			input: {},
			isError: true,
		});
		expect(
			await harness.emit("tool_call", {
				toolName: "write",
				toolCallId: "write-1",
				input: {},
			}),
		).toBeUndefined();
		await harness.emit("tool_result", {
			toolName: "write",
			toolCallId: "write-1",
			input: {},
			isError: false,
		});
		expect(await harness.emit("context", { messages: [] })).toBeUndefined();
		expect(harness.switchCalls).toHaveLength(0);
		await harness.emit("turn_end");
		await harness.emit("turn_end");
		expect(harness.switchCalls).toHaveLength(1);
		expect(harness.switchCalls[0]).toMatchObject({
			thinkingLevel: "low",
			target: { id: "target" },
		});
	});

	it("removes hidden guidance before target context after a successful mutation", async () => {
		await writeConfig();
		const harness = createHarness();
		await harness.emit("session_start", { reason: "new" });
		await harness.activateAndCheckpoint();
		await harness.emit("tool_call", {
			toolName: "edit",
			toolCallId: "edit-1",
			input: {},
		});
		await harness.emit("tool_result", {
			toolName: "edit",
			toolCallId: "edit-1",
			input: {},
			isError: false,
		});
		const persisted: AgentMessage[] = [
			{
				role: "user",
				content: "checkpoint and mutation are persisted",
				timestamp: 1,
			},
		];
		expect(await harness.emit("context", { messages: persisted })).toBeUndefined();
		expect(persisted).toHaveLength(1);
	});

	it("revalidates configured auth before reserving mutation", async () => {
		await writeConfig();
		const harness = createHarness();
		await harness.emit("session_start", { reason: "new" });
		await harness.activateAndCheckpoint();
		harness.setAuthConfigured(false);
		const result = await harness.emit("tool_call", {
			toolName: "edit",
			toolCallId: "edit-1",
			input: {},
		});
		expect(result).toMatchObject({ block: true });
		expect(harness.switchCalls).toHaveLength(0);
	});

	it("binds cross-provider consent to the exact stable recipient fingerprints", async () => {
		const initialTarget = model("other", "target", "https://first.example.test/v1/");
		const harness = createHarness({ target: initialTarget });
		harness.ctx.ui.confirmResponses.push(true);
		await harness.runCommand("configure other/target low --allow-cross-provider");
		const configured = await readConfig();
		expect(configured.crossProviderPairs).toHaveLength(1);
		expect(configured.crossProviderPairs[0]).toMatch(/^[a-f0-9]+->[a-f0-9]+$/);
		await harness.runCommand("run");
		await harness.activateAndCheckpoint();
		harness.setStreamImplementationId("other", "test-stream:other@2");
		const result = await harness.emit("tool_call", {
			toolName: "edit",
			toolCallId: "edit-1",
			input: {},
		});
		expect(result).toMatchObject({ block: true });
	});

	it("fails closed when a custom cross-provider stream has no stable identity", async () => {
		const harness = createHarness({ target: model("other", "target") });
		harness.setStreamImplementationId("other", undefined);
		harness.ctx.ui.confirmResponses.push(true);
		await harness.runCommand("configure other/target low --allow-cross-provider");
		expect(harness.ctx.ui.notifications.at(-1)?.message).toContain("streamImplementationId");
		await expect(readFile(CONFIG_PATH, "utf8")).rejects.toThrow();
	});

	it("rejects unavailable targets, missing auth, and invalid thinking during configuration", async () => {
		const harness = createHarness();
		await harness.runCommand("configure missing/model low");
		expect(harness.ctx.ui.notifications.at(-1)?.message).toContain("unavailable");
		harness.setAuthConfigured(false);
		await harness.runCommand("configure planner/target low");
		expect(harness.ctx.ui.notifications.at(-1)?.message).toContain("authentication");
		await harness.runCommand("configure planner/target impossible");
		expect(harness.ctx.ui.notifications.at(-1)?.message).toContain("Usage");
	});

	it("disarms on lifecycle boundaries and does not rearm from later tool results", async () => {
		await writeConfig();
		const harness = createHarness();
		await harness.runCommand("run");
		await harness.emit("session_before_compact");
		expect(await harness.emit("context", { messages: [] })).toBeUndefined();
		await harness.emit("tool_result", {
			toolName: "read",
			toolCallId: "read-late",
			input: {},
			isError: false,
		});
		expect(await harness.emit("context", { messages: [] })).toBeUndefined();
		expect(harness.switchCalls).toHaveLength(0);
	});

	it("cleans up a failed handoff and never retries it on a later turn", async () => {
		await writeConfig();
		const harness = createHarness();
		await harness.emit("session_start", { reason: "new" });
		await harness.activateAndCheckpoint();
		await harness.emit("tool_call", {
			toolName: "edit",
			toolCallId: "edit-1",
			input: {},
		});
		await harness.emit("tool_result", {
			toolName: "edit",
			toolCallId: "edit-1",
			input: {},
			isError: false,
		});
		harness.setSwitchError(new Error("credential rejected"));
		await harness.emit("turn_end");
		await harness.emit("turn_end");
		expect(harness.switchCalls).toHaveLength(1);
		expect(harness.ctx.ui.notifications.at(-1)?.message).toContain("credential rejected");
		expect(await harness.emit("context", { messages: [] })).toBeUndefined();
	});
});
