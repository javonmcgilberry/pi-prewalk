import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	createTemporaryModelRuntime,
	TemporaryModelController,
} from "../../src/executor/temporary-runtime.js";
import { DEFAULT_EXECUTOR, DEFAULT_PLANNER } from "../../src/orchestration/coordinator.js";

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-codex-responses",
		provider,
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 1_000,
	};
}

function setup() {
	const planner = model(DEFAULT_PLANNER.provider, DEFAULT_PLANNER.model);
	const executor = model(DEFAULT_EXECUTOR.provider, DEFAULT_EXECUTOR.model);
	let current = planner;
	let thinking: ThinkingLevel = "high";
	const modelEvents: Array<{ model: Model<Api>; source: "set" }> = [];
	const thinkingEvents: ThinkingLevel[] = [];
	const pi = {
		setModel: vi.fn(async (next: Model<Api>) => {
			current = next;
			return true;
		}),
		getThinkingLevel: () => thinking,
		setThinkingLevel: vi.fn((next: ThinkingLevel) => {
			thinking = next;
			thinkingEvents.push(next);
		}),
	};
	const registry = {
		find: (provider: string, id: string) =>
			provider === planner.provider && id === planner.id
				? planner
				: provider === executor.provider && id === executor.id
					? executor
					: undefined,
	};
	const callbacks = {
		isCurrent: () => true,
		shouldRouteToExecutor: () => route,
		onProviderDrift: vi.fn(),
	};
	let route = false;
	const runtime = createTemporaryModelRuntime(pi, registry);
	const plan = {
		runId: "run-1",
		planner: { ...DEFAULT_PLANNER, reasoning: "high" as const },
		executor: { ...DEFAULT_EXECUTOR },
		hiddenPlanPrompt: "ephemeral planner prompt",
	};
	return {
		planner,
		executor,
		pi,
		registry,
		callbacks,
		runtime,
		plan,
		modelEvents,
		thinkingEvents,
		current: () => current,
		thinking: () => thinking,
		setRoute: (value: boolean) => {
			route = value;
		},
	};
}

describe("native temporary model runtime", () => {
	it("switches the session-local model only at the executor boundary and restores it", async () => {
		const fixture = setup();
		const lease = fixture.runtime.mount(fixture.plan, fixture.callbacks);

		await lease.sync();
		expect(fixture.current()).toBe(fixture.planner);
		expect(fixture.pi.setModel).not.toHaveBeenCalled();

		fixture.setRoute(true);
		await lease.sync();
		expect(fixture.current()).toBe(fixture.executor);
		expect(fixture.thinking()).toBe(DEFAULT_EXECUTOR.reasoning);
		expect(fixture.pi.setModel).toHaveBeenCalledOnce();

		await lease.restore();
		await lease.restore();
		expect(fixture.current()).toBe(fixture.planner);
		expect(fixture.thinking()).toBe("high");
		expect(lease.ownsRoute()).toBe(false);
	});

	it("keeps native model and thinking events owned by the switching lease", async () => {
		const fixture = setup();
		const lease = fixture.runtime.mount(fixture.plan, fixture.callbacks);
		let internalModel = false;
		let internalThinking = false;
		fixture.pi.setModel.mockImplementationOnce(async (next) => {
			internalModel = lease.consumeInternalModelSelect(next, "set");
			return true;
		});
		fixture.pi.setThinkingLevel.mockImplementationOnce((next) => {
			internalThinking = lease.consumeInternalThinkingLevel(next);
		});

		fixture.setRoute(true);
		await lease.sync();
		expect(internalModel).toBe(true);
		expect(internalThinking).toBe(true);
		expect(fixture.modelEvents).toEqual([]);
		expect(fixture.thinkingEvents).toEqual([]);
	});

	it("fails closed when the executor disappears and keeps the planner route", async () => {
		const fixture = setup();
		const lease = fixture.runtime.mount(fixture.plan, fixture.callbacks);
		fixture.setRoute(true);
		const originalFind = fixture.registry.find;
		// SAFETY: This test constructs the value with the asserted shape before exercising the boundary.
		fixture.registry.find = ((provider: string, id: string) =>
			provider === fixture.planner.provider && id === fixture.planner.id
				? fixture.planner
				: undefined) as typeof fixture.registry.find;

		await expect(lease.sync()).rejects.toThrow("executor model is no longer registered");
		expect(fixture.current()).toBe(fixture.planner);
		expect(fixture.callbacks.onProviderDrift).toHaveBeenCalledOnce();
		fixture.registry.find = originalFind;
		await lease.restore();
	});

	it("does not let a stale controller identity restore a replacement lease", async () => {
		const fixture = setup();
		const controller = new TemporaryModelController(() => fixture.runtime);
		const first = controller.ensure(
			fixture.plan,
			{ runId: "run-1", epoch: "epoch-1" },
			fixture.callbacks,
		);
		fixture.setRoute(true);
		await first.sync();

		await controller.restore({ runId: "run-2", epoch: "epoch-2" });
		expect(controller.ownsRoute()).toBe(true);
		expect(fixture.current()).toBe(fixture.executor);

		await controller.restore({ runId: "run-1", epoch: "epoch-1" });
		expect(fixture.current()).toBe(fixture.planner);
		expect(controller.ownsRoute()).toBe(true);
	});
});
