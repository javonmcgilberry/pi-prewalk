import { describe, expect, it, vi } from "vitest";
import {
	ContextPressureController,
	type ContextPressureHost,
} from "../../src/executor/context-pressure.js";
import type { HostRunIdentity } from "../../src/host-event-correlation.js";
import {
	DEFAULT_EXECUTOR,
	DEFAULT_PLANNER,
	type PrewalkRun,
} from "../../src/orchestration/coordinator.js";

type CompactCallbacks = Parameters<ContextPressureHost["compact"]>[0];

function executorRun(runId = "run-1", epoch = "epoch-1"): PrewalkRun {
	return {
		id: runId,
		epoch,
		mode: "automatic",
		phase: "active",
		effectiveRoute: "executor",
		planner: { ...DEFAULT_PLANNER, reasoning: "low" },
		config: { executor: { ...DEFAULT_EXECUTOR } },
		planningPromptInjected: true,
		continuePending: false,
		todoActive: true,
		todoSeen: true,
	};
}

function createHost(run: PrewalkRun) {
	const compactions: CompactCallbacks[] = [];
	const fail = vi.fn();
	const retryChecklist = vi.fn(async () => {});
	return {
		compactions,
		fail,
		retryChecklist,
		host: {
			currentRun: () => run,
			compact: (callbacks: CompactCallbacks) => compactions.push(callbacks),
			notify: vi.fn(),
			fail,
			sendRetryPlanning: vi.fn(async () => {}),
			sendRetryChecklist: retryChecklist,
		},
	};
}

describe("ContextPressureController", () => {
	it("allows one executor retry per pressure sequence and resets after matching success", () => {
		const run = executorRun();
		const identity: HostRunIdentity = { runId: run.id, epoch: run.epoch };
		const controller = new ContextPressureController();
		const { host, compactions, fail, retryChecklist } = createHost(run);

		controller.onExecutorContextPressure(identity, true);
		expect(controller.settle(run, host)).toBe("compaction-requested");
		compactions[0]?.onComplete();
		expect(retryChecklist).toHaveBeenCalledTimes(1);

		controller.onExecutorContextPressure(identity, true);
		expect(controller.settle(run, host)).toBe("compaction-requested");
		expect(compactions).toHaveLength(1);
		expect(fail).toHaveBeenCalledOnce();

		controller.onExecutorStreamSucceeded(identity);
		controller.onExecutorContextPressure(identity, true);
		expect(controller.settle(run, host)).toBe("compaction-requested");
		expect(compactions).toHaveLength(2);
	});

	it("does not reset executor retry state for a stale run or epoch", () => {
		const run = executorRun();
		const identity: HostRunIdentity = { runId: run.id, epoch: run.epoch };
		const controller = new ContextPressureController();
		const { host, compactions, fail } = createHost(run);

		controller.onExecutorContextPressure(identity, true);
		controller.settle(run, host);
		compactions[0]?.onComplete();

		controller.onExecutorStreamSucceeded({ runId: "stale-run", epoch: run.epoch });
		controller.onExecutorContextPressure(identity, true);
		controller.settle(run, host);
		controller.onExecutorStreamSucceeded({ runId: run.id, epoch: "stale-epoch" });
		controller.onExecutorContextPressure(identity, true);
		controller.settle(run, host);

		expect(compactions).toHaveLength(1);
		expect(fail).toHaveBeenCalledTimes(2);
	});

	it("clears pending executor failure only for the matching stream identity", () => {
		const run = executorRun();
		const identity: HostRunIdentity = { runId: run.id, epoch: run.epoch };
		const controller = new ContextPressureController();

		controller.onExecutorStreamFailed(identity);
		controller.onExecutorStreamStarted({ runId: run.id, epoch: "stale-epoch" });
		expect(controller.takePendingFailure(run)).toBe(true);

		controller.onExecutorStreamFailed(identity);
		controller.onExecutorStreamStarted(identity);
		expect(controller.takePendingFailure(run)).toBe(false);
	});
});
