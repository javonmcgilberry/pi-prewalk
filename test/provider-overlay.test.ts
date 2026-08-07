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
	DEFAULT_EXECUTOR,
	DEFAULT_PLANNER,
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

function anthropicModel(id: string): Model<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://anthropic.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 2000,
		maxTokens: 200,
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
		shouldRouteToExecutor: () => route,
		isPrimaryAgentStream: () => primary,
		currentRunId: () => "run-1",
		onExecutorStreamStarted: vi.fn(),
		onExecutorStreamSucceeded: vi.fn(),
		onExecutorStreamFailed: vi.fn(),
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
	const overlay = createProviderOverlay(
		pi,
		registry,
		{ ...DEFAULT_PLANNER, reasoning: "high" },
		{
			executor: { ...DEFAULT_EXECUTOR },
		},
		state,
	);
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

/**
 * Planner and executor on different providers, each with its own registered
 * provider transport. Only the planner's provider carries the overlay.
 */
function setupCrossProvider() {
	const planner = model(PLANNER_MODEL_ID);
	const executor = anthropicModel("claude-haiku-4-5");
	const plannerDelegateModels: Model<Api>[] = [];
	const executorDelegateModels: Model<Api>[] = [];
	const executorDelegateOptions: Array<SimpleStreamOptions | undefined> = [];

	const plannerDelegate: NonNullable<ProviderConfig["streamSimple"]> = (selected) => {
		plannerDelegateModels.push(selected);
		return successfulStream(selected);
	};
	const executorDelegate: NonNullable<ProviderConfig["streamSimple"]> = (
		selected,
		_context,
		options,
	) => {
		executorDelegateModels.push(selected);
		executorDelegateOptions.push(options);
		return successfulStream(selected);
	};

	let plannerConfig: ProviderConfig | undefined = {
		api: "openai-codex-responses",
		streamSimple: plannerDelegate,
	};
	let executorConfig: ProviderConfig | undefined = {
		api: "anthropic-messages",
		streamSimple: executorDelegate,
	};
	let executorRegistered = true;

	const pi = {
		registerProvider: vi.fn((provider: string, next: ProviderConfig) => {
			if (provider === PLANNER_PROVIDER) plannerConfig = next;
		}),
		unregisterProvider: vi.fn((provider: string) => {
			if (provider === PLANNER_PROVIDER) plannerConfig = undefined;
		}),
	};
	let route = false;
	let primary = false;
	const state: ProviderOverlayState = {
		shouldRouteToExecutor: () => route,
		isPrimaryAgentStream: () => primary,
		currentRunId: () => "run-1",
		onExecutorStreamStarted: vi.fn(),
		onExecutorStreamSucceeded: vi.fn(),
		onExecutorStreamFailed: vi.fn(),
		onProviderDrift: vi.fn(),
	};
	const registry = {
		find: (provider: string, id: string): Model<Api> | undefined => {
			if (provider === PLANNER_PROVIDER && id === PLANNER_MODEL_ID) return planner;
			if (provider === "anthropic" && id === executor.id && executorRegistered) return executor;
			return undefined;
		},
		getRegisteredProviderConfig: (provider: string) => {
			if (provider === PLANNER_PROVIDER) return plannerConfig;
			if (provider === "anthropic") return executorConfig;
			return undefined;
		},
		getApiKeyAndHeaders: vi.fn(
			async (): Promise<{
				ok: true;
				apiKey: string;
				headers: Record<string, string>;
				env: Record<string, string>;
			}> => ({
				ok: true,
				apiKey: "anthropic-token",
				headers: { "x-anthropic": "true" },
				env: {},
			}),
		),
	};
	const overlay = createProviderOverlay(
		pi,
		registry,
		{ ...DEFAULT_PLANNER, reasoning: "high" },
		{ executor: { provider: "anthropic", model: executor.id, reasoning: "low" } },
		state,
	);
	const context: Context = { messages: [] };
	return {
		planner,
		executor,
		plannerDelegateModels,
		executorDelegateModels,
		executorDelegateOptions,
		state,
		overlay,
		context,
		plannerConfig: () => plannerConfig,
		setRoute: (value: boolean) => {
			route = value;
		},
		setPrimary: (value: boolean) => {
			primary = value;
		},
		/** Another extension swaps the executor provider's transport mid-run. */
		replaceExecutorProvider: (streamSimple: NonNullable<ProviderConfig["streamSimple"]>) => {
			executorConfig = { api: "anthropic-messages", streamSimple };
		},
		/** The executor provider is unregistered entirely mid-run. */
		unregisterExecutorProvider: () => {
			executorConfig = undefined;
		},
		/** The executor model disappears from the registry mid-run. */
		removeExecutorModel: () => {
			executorRegistered = false;
		},
	};
}

describe("provider overlay", () => {
	it("delegates Sol unchanged before handoff", async () => {
		const fixture = setup();
		fixture.overlay.install();

		await fixture.config()?.streamSimple?.(fixture.planner, fixture.context).result();

		expect(fixture.delegatedModels).toEqual([fixture.planner]);
		expect(fixture.state.onExecutorStreamStarted).not.toHaveBeenCalled();
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
		expect(fixture.state.onExecutorStreamStarted).toHaveBeenCalledOnce();
		expect(fixture.state.onExecutorStreamSucceeded).toHaveBeenCalledOnce();
	});

	it("leaves compaction and other auxiliary streams on Sol", async () => {
		const fixture = setup();
		fixture.overlay.install();
		fixture.setRoute(true);

		await fixture.config()?.streamSimple?.(fixture.planner, fixture.context).result();

		expect(fixture.delegatedModels).toEqual([fixture.planner]);
	});

	it("keeps an overlapping auxiliary stream on the planner while the primary stream uses the executor", async () => {
		const fixture = setup();
		fixture.overlay.install();
		fixture.setRoute(true);
		fixture.setPrimary(true);
		const primary = fixture.config()?.streamSimple?.(fixture.planner, fixture.context).result();

		fixture.setPrimary(false);
		const auxiliary = fixture.config()?.streamSimple?.(fixture.planner, fixture.context).result();
		await Promise.all([primary, auxiliary]);

		expect(fixture.delegatedModels.map((model) => model.id).sort()).toEqual(
			[fixture.executor.id, fixture.planner.id].sort(),
		);
		expect(fixture.state.onExecutorStreamStarted).toHaveBeenCalledOnce();
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
		expect(result?.errorMessage).toBe("Prewalk executor provider stream failed.");
		expect(result?.errorMessage).not.toContain("provider-secret");
		expect(fixture.state.onExecutorStreamFailed).toHaveBeenCalledWith("run-1");
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
		expect(fixture.state.onExecutorStreamStarted).not.toHaveBeenCalled();
		expect(fixture.state.onExecutorStreamFailed).toHaveBeenCalledWith("run-1");
	});

	it("sends a cross-provider executor through its own provider transport", async () => {
		const fixture = setupCrossProvider();
		fixture.overlay.install();
		fixture.setRoute(true);
		fixture.setPrimary(true);

		const result = await fixture
			.plannerConfig()
			?.streamSimple?.(fixture.planner, fixture.context, { reasoning: "high" })
			.result();

		// The planner's own transport must never receive the executor model: it
		// speaks a different wire format and carries the wrong credentials.
		expect(fixture.plannerDelegateModels).toEqual([]);
		expect(fixture.executorDelegateModels).toEqual([fixture.executor]);
		expect(fixture.executorDelegateOptions).toEqual([
			{
				reasoning: "low",
				apiKey: "anthropic-token",
				headers: { "x-anthropic": "true" },
				env: {},
			},
		]);
		expect(result?.provider).toBe("anthropic");
		expect(result?.model).toBe(fixture.executor.id);
		expect(fixture.state.onExecutorStreamSucceeded).toHaveBeenCalledOnce();
	});

	it("still routes a pre-handoff planner request through the planner transport when the executor is cross-provider", async () => {
		const fixture = setupCrossProvider();
		fixture.overlay.install();

		await fixture.plannerConfig()?.streamSimple?.(fixture.planner, fixture.context).result();

		expect(fixture.plannerDelegateModels).toEqual([fixture.planner]);
		expect(fixture.executorDelegateModels).toEqual([]);
		expect(fixture.state.onExecutorStreamStarted).not.toHaveBeenCalled();
	});

	it("resolves a same-provider executor against the pre-overlay delegate rather than its own live registration", async () => {
		// A same-provider pair must not resolve the executor delegate from the live
		// registration, because that registration is this overlay. Doing so would
		// re-enter the overlay for every executor request.
		const fixture = setup();
		fixture.overlay.install();
		fixture.setRoute(true);
		fixture.setPrimary(true);

		const result = await fixture
			.config()
			?.streamSimple?.(fixture.planner, fixture.context)
			.result();

		expect(fixture.delegatedModels).toEqual([fixture.executor]);
		expect(result?.stopReason).toBe("stop");
		expect(fixture.state.onExecutorStreamSucceeded).toHaveBeenCalledOnce();
	});

	it("picks up an executor transport replaced after install", async () => {
		const fixture = setupCrossProvider();
		fixture.overlay.install();
		fixture.setRoute(true);
		fixture.setPrimary(true);

		const replacementModels: Model<Api>[] = [];
		fixture.replaceExecutorProvider((selected) => {
			replacementModels.push(selected);
			return successfulStream(selected);
		});

		const result = await fixture
			.plannerConfig()
			?.streamSimple?.(fixture.planner, fixture.context)
			.result();

		// Pi applies provider registration immediately, so a transport captured at
		// install time would be one Pi has already discarded.
		expect(replacementModels).toEqual([fixture.executor]);
		expect(fixture.executorDelegateModels).toEqual([]);
		expect(result?.stopReason).toBe("stop");
	});

	it("falls back to the builtin transport when the executor provider is unregistered", async () => {
		const fixture = setupCrossProvider();
		fixture.overlay.install();
		fixture.setRoute(true);
		fixture.setPrimary(true);
		fixture.unregisterExecutorProvider();

		// No registered config remains, so the overlay must reach the builtin
		// dispatcher rather than the stale captured one. The builtin will fail on a
		// fake model, which is fine: the assertion is that the stale delegate was
		// not reused.
		const result = await fixture
			.plannerConfig()
			?.streamSimple?.(fixture.planner, fixture.context)
			.result();

		expect(fixture.executorDelegateModels).toEqual([]);
		expect(result?.stopReason).toBe("error");
		expect(fixture.state.onExecutorStreamFailed).toHaveBeenCalledWith("run-1");
	});

	it("reports drift when the executor model leaves the registry mid-run", async () => {
		const fixture = setupCrossProvider();
		fixture.overlay.install();
		fixture.setRoute(true);
		fixture.setPrimary(true);
		fixture.removeExecutorModel();

		expect(() =>
			fixture.plannerConfig()?.streamSimple?.(fixture.planner, fixture.context),
		).toThrow("Prewalk executor model is no longer registered.");
		expect(fixture.state.onProviderDrift).toHaveBeenCalledOnce();
		expect(fixture.executorDelegateModels).toEqual([]);
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
		expect(fixture.state.onExecutorStreamFailed).toHaveBeenCalledWith("run-1");
	});
});
