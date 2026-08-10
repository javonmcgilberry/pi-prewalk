import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createTemporaryModelRuntime } from "../../src/executor/temporary-runtime.js";
import { DEFAULT_EXECUTOR, DEFAULT_PLANNER } from "../../src/orchestration/coordinator.js";

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
		maxTokens: 1_000,
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
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function doneStream(selected: Model<"openai-codex-responses">): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const message = assistant(selected);
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end();
	});
	return stream;
}

function setup(crossProvider = false) {
	const planner = model(DEFAULT_PLANNER.model);
	const executor = {
		...model(DEFAULT_EXECUTOR.model),
		...(crossProvider ? { provider: "anthropic" } : {}),
	};
	const executorConfig = { ...DEFAULT_EXECUTOR, provider: executor.provider };
	const executorDelegatedModels: Model<"openai-codex-responses">[] = [];
	const executorDelegatedOptions: Array<unknown> = [];
	let registered: ProviderConfig = {
		api: planner.api,
		apiKey: "planner-token",
		streamSimple: (selected) => doneStream(selected as Model<"openai-codex-responses">),
	};
	const pi = {
		setModel: vi.fn(),
		registerProvider: vi.fn((_provider: string, config: ProviderConfig) => {
			registered = config;
		}),
		unregisterProvider: vi.fn(() => {
			registered = {};
		}),
	};
	const executorProviderConfig: ProviderConfig = {
		api: executor.api,
		apiKey: "executor-token",
		streamSimple: (selected, _context, options) => {
			executorDelegatedModels.push(selected as Model<"openai-codex-responses">);
			executorDelegatedOptions.push(options);
			return doneStream(selected as Model<"openai-codex-responses">);
		},
	};
	const registry = {
		find: (_provider: string, id: string) =>
			id === planner.id ? planner : id === executor.id ? executor : undefined,
		getApiKeyAndHeaders: vi.fn(async () => ({ ok: true as const, apiKey: "executor-token" })),
		getRegisteredProviderConfig: (provider: string) =>
			provider === executor.provider && crossProvider ? executorProviderConfig : registered,
	};
	let current = true;
	let route = false;
	let primary = false;
	const callbacks = {
		isCurrent: () => current,
		shouldRouteToExecutor: () => route,
		isPrimaryAgentStream: () => primary,
		onExecutorStreamStarted: vi.fn(),
		onExecutorStreamSucceeded: vi.fn(),
		onExecutorStreamFailed: vi.fn(),
		onExecutorContextPressure: vi.fn(),
		onProviderDrift: vi.fn(),
	};
	const runtime = createTemporaryModelRuntime(pi, registry);
	const plan = {
		runId: "run-1",
		planner: { ...DEFAULT_PLANNER, reasoning: "high" as const },
		executor: executorConfig,
		hiddenPlanPrompt: "hidden plan",
	};
	return {
		planner,
		executor,
		pi,
		callbacks,
		runtime,
		plan,
		setCurrent: (value: boolean) => {
			current = value;
		},
		setRoute: (value: boolean) => {
			route = value;
		},
		setPrimary: (value: boolean) => {
			primary = value;
		},
		registered: () => registered,
		executorDelegatedModels,
		executorDelegatedOptions,
	};
}

describe("temporary model runtime", () => {
	it("mounts an ephemeral route and restores the exact provider registration", async () => {
		const fixture = setup();
		const original = fixture.registered();
		const lease = fixture.runtime.mount(fixture.plan, fixture.callbacks);
		fixture.setRoute(true);
		fixture.setPrimary(true);

		const result = await fixture
			.registered()
			.streamSimple?.(fixture.planner, { messages: [] })
			?.result();

		expect(result?.model).toBe(fixture.executor.id);
		expect(fixture.pi.setModel).not.toHaveBeenCalled();
		expect(fixture.callbacks.onExecutorStreamStarted).toHaveBeenCalledOnce();
		expect(fixture.callbacks.onExecutorStreamSucceeded).toHaveBeenCalledOnce();
		expect(lease.ownsRoute()).toBe(true);

		lease.restore();
		lease.restore();
		expect(fixture.registered()).toEqual(original);
		expect(lease.ownsRoute()).toBe(false);
	});

	it("ignores callbacks from a restored lease after a replacement is mounted", async () => {
		const fixture = setup();
		const first = fixture.runtime.mount(fixture.plan, fixture.callbacks);
		const staleStream = fixture.registered().streamSimple;
		first.restore();

		const second = fixture.runtime.mount({ ...fixture.plan, runId: "run-2" }, fixture.callbacks);
		fixture.setCurrent(false);

		expect(() => staleStream?.(fixture.planner, { messages: [] })).toThrow(
			"Prewalk provider overlay ownership changed during the session.",
		);
		expect(fixture.callbacks.onProviderDrift).not.toHaveBeenCalled();
		expect(second.ownsRoute()).toBe(true);
		second.restore();
	});

	it("keeps cross-provider routing on the executor transport", async () => {
		const fixture = setup(true);
		const lease = fixture.runtime.mount(fixture.plan, fixture.callbacks);
		fixture.setRoute(true);
		fixture.setPrimary(true);

		const result = await fixture
			.registered()
			.streamSimple?.(fixture.planner, { messages: [] })
			?.result();

		expect(result?.model).toBe(fixture.executor.id);
		expect(fixture.executorDelegatedModels.at(-1)?.provider).toBe("anthropic");
		expect(fixture.executorDelegatedOptions.at(-1)).toMatchObject({ apiKey: "executor-token" });
		lease.restore();
	});
});
