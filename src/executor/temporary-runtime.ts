import type { ModelRegistry, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { HostRunIdentity } from "../host-event-correlation.js";
import type { ExecutorConfig, PlannerProfile } from "../orchestration/coordinator.js";
import {
	createProviderOverlay,
	type ProviderOverlay,
	removeExactUserPrompt,
} from "./provider-overlay.js";

export interface TemporaryModelPlan {
	readonly runId: string;
	readonly planner: PlannerProfile;
	readonly executor: Pick<ExecutorConfig, "provider" | "model" | "reasoning">;
	readonly hiddenPlanPrompt: string;
}

/**
 * Semantic events from the temporary model driver. The driver deliberately
 * does not own Prewalk's phases, audit records, or checklist messages; it only
 * reports what the host/runtime actually observed.
 */
export interface TemporaryModelCallbacks {
	isCurrent(): boolean;
	shouldRouteToExecutor(): boolean;
	shouldGuardPlannerContext(): boolean;
	isPrimaryAgentStream(): boolean;
	getCompactionReserveTokens?(): number | undefined;
	onPlannerContextPressure(): void | Promise<void>;
	onPlannerContextSafe(): void;
	onExecutorStreamStarted(): void | Promise<void>;
	onExecutorStreamSucceeded(): void | Promise<void>;
	onExecutorStreamFailed(): void | Promise<void>;
	onExecutorContextPressure(retry: boolean): void | Promise<void>;
	onProviderDrift(): void;
}

export interface TemporaryModelLease {
	readonly runId: string;
	/** Idempotently invalidates the lease and restores the planner transport. */
	restore(): void;
	/** True only while this lease still owns the temporary model route. */
	ownsRoute(): boolean;
}

export interface TemporaryModelRuntime {
	/**
	 * Mounts one run-scoped route immediately. A runtime accepts only one live
	 * lease; callers must restore it before mounting a replacement run.
	 */
	mount(plan: TemporaryModelPlan, callbacks: TemporaryModelCallbacks): TemporaryModelLease;
}

type RuntimeRegistry = Pick<
	ModelRegistry,
	"find" | "getApiKeyAndHeaders" | "getRegisteredProviderConfig"
>;

type RuntimePi = {
	registerProvider(name: string, config: ProviderConfig): void;
	unregisterProvider(name: string): void;
};

class StockPiTemporaryModelRuntime implements TemporaryModelRuntime {
	private activeLease: StockPiTemporaryModelLease | undefined;

	constructor(
		private readonly pi: RuntimePi,
		private readonly modelRegistry: RuntimeRegistry,
	) {}

	mount(plan: TemporaryModelPlan, callbacks: TemporaryModelCallbacks): TemporaryModelLease {
		if (this.activeLease) {
			throw new Error("Prewalk temporary model runtime is already mounted.");
		}

		let lease: StockPiTemporaryModelLease;
		const overlay = createProviderOverlay(
			this.pi,
			this.modelRegistry,
			plan.planner,
			plan.executor,
			{
				shouldRouteToExecutor: () =>
					lease.isActive() && callbacks.isCurrent() && callbacks.shouldRouteToExecutor(),
				shouldGuardPlannerContext: () =>
					lease.isActive() && callbacks.isCurrent() && callbacks.shouldGuardPlannerContext(),
				isPrimaryAgentStream: () =>
					lease.isActive() && callbacks.isCurrent() && callbacks.isPrimaryAgentStream(),
				currentRunId: () =>
					lease.isActive() && callbacks.isCurrent() ? plan.runId : undefined,
				getCompactionReserveTokens: () => callbacks.getCompactionReserveTokens?.(),
				prepareExecutorContext: (context) =>
					removeExactUserPrompt(context, plan.hiddenPlanPrompt),
				onPlannerContextPressure: (runId) => {
					if (runId === plan.runId && lease.isActive() && callbacks.isCurrent()) {
						return callbacks.onPlannerContextPressure();
					}
				},
				onPlannerContextSafe: (runId) => {
					if (runId === plan.runId && lease.isActive() && callbacks.isCurrent()) {
						callbacks.onPlannerContextSafe();
					}
				},
				onExecutorStreamStarted: (runId) => {
					if (runId === plan.runId && lease.isActive() && callbacks.isCurrent()) {
						return callbacks.onExecutorStreamStarted();
					}
				},
				onExecutorStreamSucceeded: (runId) => {
					if (runId === plan.runId && lease.isActive() && callbacks.isCurrent()) {
						return callbacks.onExecutorStreamSucceeded();
					}
				},
				onExecutorStreamFailed: (runId) => {
					if (runId === plan.runId && lease.isActive() && callbacks.isCurrent()) {
						return callbacks.onExecutorStreamFailed();
					}
				},
				onExecutorContextPressure: (runId, retry) => {
					if (runId === plan.runId && lease.isActive() && callbacks.isCurrent()) {
						return callbacks.onExecutorContextPressure(retry);
					}
				},
				onProviderDrift: (runId) => {
					if (runId === plan.runId && lease.isActive() && callbacks.isCurrent()) {
						callbacks.onProviderDrift();
					}
				},
			},
		);
		lease = new StockPiTemporaryModelLease(this, plan.runId, overlay);
		this.activeLease = lease;
		try {
			overlay.install();
		} catch (error) {
			lease.restore();
			throw error;
		}
		return lease;
	}

	release(lease: StockPiTemporaryModelLease): void {
		if (this.activeLease === lease) this.activeLease = undefined;
	}
}

class StockPiTemporaryModelLease implements TemporaryModelLease {
	private active = true;

	constructor(
		private readonly runtime: StockPiTemporaryModelRuntime,
		readonly runId: string,
		private readonly overlay: ProviderOverlay,
	) {}

	isActive(): boolean {
		return this.active;
	}

	restore(): void {
		if (!this.active) return;
		this.active = false;
		this.runtime.release(this);
		this.overlay.restore();
	}

	ownsRoute(): boolean {
		return this.active && this.overlay.ownsRegistration();
	}
}

export function createTemporaryModelRuntime(
	pi: RuntimePi,
	modelRegistry: RuntimeRegistry,
): TemporaryModelRuntime {
	return new StockPiTemporaryModelRuntime(pi, modelRegistry);
}

function sameIdentity(left: HostRunIdentity | undefined, right: HostRunIdentity): boolean {
	return left !== undefined && left.runId === right.runId && left.epoch === right.epoch;
}

/**
 * Owns the replaceable runtime and its exact run-scoped lease. The Pi adapter
 * supplies semantic callbacks, while this controller prevents a disposed lease
 * from being reused by a replacement run or restoring a newer route.
 */
export class TemporaryModelController {
	#runtime: TemporaryModelRuntime | undefined;
	#lease: TemporaryModelLease | undefined;
	#leaseRun: HostRunIdentity | undefined;

	constructor(private readonly createRuntime: () => TemporaryModelRuntime) {}

	ensure(
		plan: TemporaryModelPlan,
		runIdentity: HostRunIdentity,
		callbacks: TemporaryModelCallbacks,
	): TemporaryModelLease {
		if (this.#lease && sameIdentity(this.#leaseRun, runIdentity)) return this.#lease;
		this.restore(this.#leaseRun);
		this.#runtime ??= this.createRuntime();
		const lease = this.#runtime.mount(plan, callbacks);
		this.#lease = lease;
		this.#leaseRun = runIdentity;
		return lease;
	}

	restore(runIdentity?: HostRunIdentity): void {
		if (
			runIdentity !== undefined &&
			(this.#leaseRun === undefined || !sameIdentity(this.#leaseRun, runIdentity))
		) {
			return;
		}
		this.#lease?.restore();
		this.#lease = undefined;
		this.#leaseRun = undefined;
	}

	ownsRoute(): boolean {
		return this.#lease?.ownsRoute() ?? true;
	}
}
