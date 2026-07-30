import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	EXECUTOR_MODEL_ID,
	EXECUTOR_PROVIDER,
	PLANNER_MODEL_ID,
	PLANNER_PROVIDER,
} from "../src/core.js";
import { createProviderOverlay, type ProviderOverlayState } from "../src/provider-overlay.js";

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
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function assistant(selected: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: selected.api,
		provider: selected.provider,
		model: selected.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function successfulStream(selected: Model<Api>) {
	const stream = createAssistantMessageEventStream();
	const message = assistant(selected);
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end();
	});
	return stream;
}

function setup() {
	const planner = model(PLANNER_MODEL_ID);
	const executor = model(EXECUTOR_MODEL_ID);
	let config: ProviderConfig | undefined;
	const delegatedModels: Model<Api>[] = [];
	const delegatedOptions: Array<SimpleStreamOptions | undefined> = [];
	let delegateImpl: NonNullable<ProviderConfig["streamSimple"]> = (selected) =>
		successfulStream(selected);
	const delegate: NonNullable<ProviderConfig["streamSimple"]> = (selected, context, options) => {
		delegatedModels.push(selected);
		delegatedOptions.push(options);
		return delegateImpl(selected, context, options);
	};
	config = {
		api: "openai-codex-responses",
		oauth: {
			name: "OpenAI Codex",
			login: async () => ({ access: "token", refresh: "refresh", expires: 1 }),
			refreshToken: async (credentials) => credentials,
			getApiKey: (credentials) => credentials.access,
		},
		streamSimple: delegate,
	};
	const pi = {
		registerProvider: vi.fn((_provider: string, next: ProviderConfig) => {
			config = next;
		}),
		unregisterProvider: vi.fn(() => {
			config = undefined;
		}),
	};
	let route = false;
	let primary = false;
	const state: ProviderOverlayState = {
		shouldRouteToLuna: () => route,
		isPrimaryAgentStream: () => primary,
		currentRunId: () => "run-1",
		onLunaStreamStarted: vi.fn(),
		onLunaStreamSucceeded: vi.fn(),
		onLunaStreamFailed: vi.fn(),
		onProviderDrift: vi.fn(),
	};
	const registry = {
		find: (provider: string, id: string) => {
			if (provider !== PLANNER_PROVIDER) return undefined;
			if (id === PLANNER_MODEL_ID) return planner;
			if (id === EXECUTOR_MODEL_ID) return executor;
			return undefined;
		},
		getRegisteredProviderConfig: (provider: string) =>
			provider === PLANNER_PROVIDER ? config : undefined,
		getApiKeyAndHeaders: vi.fn(
			async (): Promise<{
				ok: true;
				apiKey: string;
				headers: Record<string, string>;
				env: Record<string, string>;
			}> => ({
				ok: true,
				apiKey: "executor-token",
				headers: { "x-executor": "true" },
				env: { PREWALK_EXECUTOR: "true" },
			}),
		),
	};
	const overlay = createProviderOverlay(pi, registry, state);
	const context: Context = { messages: [] };
	return {
		planner,
		executor,
		delegate,
		delegatedModels,
		delegatedOptions,
		pi,
		state,
		overlay,
		context,
		config: () => config,
		setRoute: (value: boolean) => {
			route = value;
		},
		setPrimary: (value: boolean) => {
			primary = value;
		},
		setConfig: (value: ProviderConfig | undefined) => {
			config = value;
		},
		setDelegate: (value: NonNullable<ProviderConfig["streamSimple"]>) => {
			delegateImpl = value;
		},
		failAuthorization: () => {
			registry.getApiKeyAndHeaders.mockRejectedValueOnce(new Error("authorization revoked"));
		},
	};
}

describe("provider overlay", () => {
	it("delegates Sol unchanged before handoff", async () => {
		const fixture = setup();
		fixture.overlay.install();

		await fixture.config()?.streamSimple?.(fixture.planner, fixture.context).result();

		expect(fixture.delegatedModels).toEqual([fixture.planner]);
		expect(fixture.state.onLunaStreamStarted).not.toHaveBeenCalled();
	});

	it("routes only a primary Agent-loop Sol request to Luna at low reasoning", async () => {
		const fixture = setup();
		fixture.overlay.install();
		fixture.setRoute(true);
		fixture.setPrimary(true);

		const result = await fixture
			.config()
			?.streamSimple?.(fixture.planner, fixture.context, { reasoning: "high" })
			.result();

		expect(fixture.delegatedModels).toEqual([fixture.executor]);
		expect(fixture.delegatedOptions).toEqual([
			{
				reasoning: "low",
				apiKey: "executor-token",
				headers: { "x-executor": "true" },
				env: { PREWALK_EXECUTOR: "true" },
			},
		]);
		expect(result?.provider).toBe(EXECUTOR_PROVIDER);
		expect(result?.model).toBe(EXECUTOR_MODEL_ID);
		expect(fixture.state.onLunaStreamStarted).toHaveBeenCalledOnce();
		expect(fixture.state.onLunaStreamSucceeded).toHaveBeenCalledOnce();
	});

	it("leaves compaction and other auxiliary streams on Sol", async () => {
		const fixture = setup();
		fixture.overlay.install();
		fixture.setRoute(true);

		await fixture.config()?.streamSimple?.(fixture.planner, fixture.context).result();

		expect(fixture.delegatedModels).toEqual([fixture.planner]);
	});

	it("restores only while it still owns the provider registration", () => {
		const fixture = setup();
		fixture.overlay.install();
		fixture.overlay.restore();

		expect(fixture.config()?.streamSimple).toBe(fixture.delegate);

		fixture.overlay.install();
		const replacement: ProviderConfig = {
			streamSimple: () => successfulStream(fixture.planner),
		};
		fixture.setConfig(replacement);
		fixture.overlay.restore();

		expect(fixture.config()).toBe(replacement);
	});

	it("terminalizes a synchronous delegated Luna failure", async () => {
		const fixture = setup();
		fixture.setDelegate(() => {
			throw new Error("provider-secret");
		});
		fixture.overlay.install();
		fixture.setRoute(true);
		fixture.setPrimary(true);

		const result = await fixture
			.config()
			?.streamSimple?.(fixture.planner, fixture.context, { apiKey: "planner-token" })
			.result();

		expect(result?.model).toBe(EXECUTOR_MODEL_ID);
		expect(result?.stopReason).toBe("error");
		expect(result?.errorMessage).toBe("Prewalk Luna provider stream failed.");
		expect(result?.errorMessage).not.toContain("provider-secret");
		expect(fixture.state.onLunaStreamFailed).toHaveBeenCalledWith("run-1");
	});

	it("does not activate Luna when executor authorization fails before delegation", async () => {
		const fixture = setup();
		fixture.overlay.install();
		fixture.setRoute(true);
		fixture.setPrimary(true);
		fixture.failAuthorization();

		const result = await fixture
			.config()
			?.streamSimple?.(fixture.planner, fixture.context)
			.result();

		expect(result?.stopReason).toBe("error");
		expect(fixture.delegatedModels).toEqual([]);
		expect(fixture.state.onLunaStreamStarted).not.toHaveBeenCalled();
		expect(fixture.state.onLunaStreamFailed).toHaveBeenCalledWith("run-1");
	});

	it("terminalizes a delegated Luna iterator failure", async () => {
		const fixture = setup();
		fixture.setDelegate((selected) => {
			const stream = successfulStream(selected);
			return {
				[Symbol.asyncIterator]: async function* () {
					for await (const event of stream) {
						if (event.type === "done") throw new Error("provider-secret");
						yield event;
					}
				},
				result: () => new Promise<AssistantMessage>(() => {}),
			} as unknown as AssistantMessageEventStream;
		});
		fixture.overlay.install();
		fixture.setRoute(true);
		fixture.setPrimary(true);

		const result = await fixture
			.config()
			?.streamSimple?.(fixture.planner, fixture.context)
			.result();

		expect(result?.stopReason).toBe("error");
		expect(fixture.state.onLunaStreamFailed).toHaveBeenCalledWith("run-1");
	});
});
