import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model as PiModel } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { HostRunIdentity } from "../host-event-correlation.js";
import type { ExecutorConfig, PlannerProfile } from "../orchestration/coordinator.js";

export interface TemporaryModelPlan {
	readonly runId: string;
	readonly planner: PlannerProfile;
	readonly executor: Pick<ExecutorConfig, "provider" | "model" | "reasoning">;
	/** Retained for the trajectory contract; native routing does not strip it. */
	readonly hiddenPlanPrompt: string;
}

/**
 * Semantic callbacks owned by the Prewalk adapter. The native runtime only
 * uses the identity/route/drift callbacks; stream lifecycle remains in the Pi
 * event adapter because Pi now owns the actual model request.
 */
export interface TemporaryModelCallbacks {
	isCurrent(): boolean;
	shouldRouteToExecutor(): boolean;
	shouldGuardPlannerContext?(): boolean;
	isPrimaryAgentStream?(): boolean;
	getCompactionReserveTokens?(): number | undefined;
	onPlannerContextPressure?(): void | Promise<void>;
	onPlannerContextSafe?(): void;
	onExecutorStreamStarted?(): void | Promise<void>;
	onExecutorStreamSucceeded?(): void | Promise<void>;
	onExecutorStreamFailed?(): void | Promise<void>;
	onExecutorContextPressure?(retry: boolean): void | Promise<void>;
	onProviderDrift(): void;
}

export interface TemporaryModelLease {
	readonly runId: string;
	/** Reconciles Pi's session-local model and thinking level with the route. */
	sync(): Promise<void>;
	/** Idempotently restores the planner route and releases this lease. */
	restore(restoreModel?: boolean): Promise<void>;
	/** True only while this lease still owns the temporary model route. */
	ownsRoute(): boolean;
	/** Consumes a model event caused by this lease's own native switch. */
	consumeInternalModelSelect(model: PiModel<Api>, source: "set" | "cycle" | "restore"): boolean;
	/** Consumes a thinking-level event caused by this lease's own native switch. */
	consumeInternalThinkingLevel(level: ThinkingLevel): boolean;
}

export interface TemporaryModelRuntime {
	/** Mounts one run-scoped native route; only one live lease is permitted. */
	mount(plan: TemporaryModelPlan, callbacks: TemporaryModelCallbacks): TemporaryModelLease;
}

type RuntimeRegistry = Pick<ModelRegistry, "find">;
type RuntimePi = {
	setModel(model: PiModel<Api>): Promise<boolean>;
	getThinkingLevel(): ThinkingLevel;
	setThinkingLevel(level: ThinkingLevel): void;
};

function sameModel(left: PiModel<Api>, right: PiModel<Api>): boolean {
	return left.provider === right.provider && left.id === right.id;
}

function sameIdentity(left: HostRunIdentity | undefined, right: HostRunIdentity): boolean {
	return left !== undefined && left.runId === right.runId && left.epoch === right.epoch;
}

/**
 * Pi 0.84.3 exposes model mutation as a session-local operation. This adapter
 * deliberately delegates model selection, auth, provider dispatch, transcript
 * persistence, and request construction back to Pi instead of recreating them
 * in a second transport implementation.
 */
class StockPiTemporaryModelRuntime implements TemporaryModelRuntime {
	private activeLease: NativeTemporaryModelLease | undefined;

	constructor(
		private readonly pi: RuntimePi,
		private readonly modelRegistry: RuntimeRegistry,
	) {}

	mount(plan: TemporaryModelPlan, callbacks: TemporaryModelCallbacks): TemporaryModelLease {
		if (this.activeLease) {
			throw new Error("Prewalk temporary model runtime is already mounted.");
		}
		const lease = new NativeTemporaryModelLease(
			this,
			plan.runId,
			plan,
			callbacks,
			this.pi,
			this.modelRegistry,
		);
		this.activeLease = lease;
		return lease;
	}

	release(lease: NativeTemporaryModelLease): void {
		if (this.activeLease === lease) this.activeLease = undefined;
	}
}

class NativeTemporaryModelLease implements TemporaryModelLease {
	private active = true;
	private route: "planner" | "executor" = "planner";
	private pendingModel: PiModel<Api> | undefined;
	private pendingThinking = false;
	private syncChain: Promise<void> = Promise.resolve();

	constructor(
		private readonly runtime: StockPiTemporaryModelRuntime,
		readonly runId: string,
		private readonly plan: TemporaryModelPlan,
		private readonly callbacks: TemporaryModelCallbacks,
		private readonly pi: RuntimePi,
		private readonly modelRegistry: RuntimeRegistry,
	) {}

	sync(): Promise<void> {
		const next = this.syncChain.then(() => this.syncRoute());
		this.syncChain = next.catch(() => undefined);
		return next;
	}

	private async syncRoute(): Promise<void> {
		if (!this.active || !this.callbacks.isCurrent()) return;
		const desiredRoute = this.callbacks.shouldRouteToExecutor() ? "executor" : "planner";
		await this.switchTo(desiredRoute, false);
	}

	private modelFor(route: "planner" | "executor"): PiModel<Api> | undefined {
		const profile = route === "planner" ? this.plan.planner : this.plan.executor;
		return this.modelRegistry.find(profile.provider, profile.model);
	}

	private thinkingFor(route: "planner" | "executor"): ThinkingLevel {
		return route === "planner" ? this.plan.planner.reasoning : this.plan.executor.reasoning;
	}

	private async switchTo(route: "planner" | "executor", duringRestore: boolean): Promise<void> {
		const target = this.modelFor(route);
		if (!target) {
			if (!duringRestore) this.callbacks.onProviderDrift();
			throw new Error(`Prewalk ${route} model is no longer registered.`);
		}
		if (route !== this.route || !sameModel(target, this.modelFor(this.route) ?? target)) {
			this.pendingModel = target;
			try {
				const selected = await this.pi.setModel(target);
				if (selected === false)
					throw new Error(`Prewalk ${route} model authorization is unavailable.`);
				this.route = route;
			} catch (error) {
				if (!duringRestore) this.callbacks.onProviderDrift();
				throw error;
			} finally {
				this.pendingModel = undefined;
			}
		}
		const thinking = this.thinkingFor(route);
		if (this.pi.getThinkingLevel() !== thinking) {
			this.pendingThinking = true;
			try {
				this.pi.setThinkingLevel(thinking);
				// Pi emits thinking_level_select from the synchronous setter. Give the
				// extension runner one turn to deliver that event before disarming the
				// ownership token.
				await Promise.resolve();
			} finally {
				this.pendingThinking = false;
			}
		}
	}

	async restore(restoreModel = true): Promise<void> {
		if (!this.active) return;
		if (!restoreModel) {
			this.active = false;
			this.runtime.release(this);
			return;
		}
		await this.syncChain;
		try {
			await this.switchTo("planner", true);
		} finally {
			this.active = false;
			this.runtime.release(this);
		}
	}

	ownsRoute(): boolean {
		return this.active;
	}

	consumeInternalModelSelect(model: PiModel<Api>, source: "set" | "cycle" | "restore"): boolean {
		return (
			source === "set" && this.pendingModel !== undefined && sameModel(this.pendingModel, model)
		);
	}

	consumeInternalThinkingLevel(_level: ThinkingLevel): boolean {
		return this.pendingThinking || this.pendingModel !== undefined;
	}
}

export function createTemporaryModelRuntime(
	pi: RuntimePi,
	modelRegistry: RuntimeRegistry,
): TemporaryModelRuntime {
	return new StockPiTemporaryModelRuntime(pi, modelRegistry);
}

/** Exact run-scoped controller; stale identities cannot restore a replacement. */
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
		if (this.#lease) void this.restore(this.#leaseRun);
		this.#runtime ??= this.createRuntime();
		const lease = this.#runtime.mount(plan, callbacks);
		this.#lease = lease;
		this.#leaseRun = runIdentity;
		return lease;
	}

	async restore(runIdentity?: HostRunIdentity, restoreModel = true): Promise<void> {
		if (
			runIdentity !== undefined &&
			(this.#leaseRun === undefined || !sameIdentity(this.#leaseRun, runIdentity))
		) {
			return;
		}
		const lease = this.#lease;
		await lease?.restore(restoreModel);
		if (this.#lease === lease) {
			this.#lease = undefined;
			this.#leaseRun = undefined;
		}
	}

	consumeInternalModelSelect(model: PiModel<Api>, source: "set" | "cycle" | "restore"): boolean {
		return this.#lease?.consumeInternalModelSelect(model, source) ?? false;
	}

	consumeInternalThinkingLevel(level: ThinkingLevel): boolean {
		return this.#lease?.consumeInternalThinkingLevel(level) ?? false;
	}

	ownsRoute(): boolean {
		return this.#lease?.ownsRoute() ?? true;
	}
}
