import type { Api, Model } from "@earendil-works/pi-ai";
import type { CompactOptions, CompactionSettings } from "@earendil-works/pi-coding-agent";
import type { BoundaryValue } from "../guards.js";
import type { HostRunIdentity } from "../host-event-correlation.js";
import type { PrewalkRun } from "../orchestration/coordinator.js";
import { needsContextCompaction } from "./context.js";

export type ContextCompactionPolicy = Required<Pick<CompactionSettings, "enabled" | "reserveTokens">>;

export const DEFAULT_CONTEXT_COMPACTION_POLICY: ContextCompactionPolicy = {
	enabled: true,
	reserveTokens: 16_384,
};

type PressureRoute = "planner" | "executor";
type PressureState = HostRunIdentity & { route: PressureRoute; retry: boolean };
type RetryState = HostRunIdentity & { route: PressureRoute; count: number };
type CompactionRequest = PressureState & { committed: boolean };

/**
 * Host capabilities used by the primary-route pressure transaction. The adapter
 * supplies Pi's compactor and notices; this module owns the ordering between
 * pressure, settlement, native compaction, retry, and stale-run checks.
 */
export interface ContextPressureHost {
	currentRun(): PrewalkRun | undefined;
	compact(callbacks: Required<Pick<CompactOptions, "onComplete" | "onError">>): void;
	notify(message: string, level: "error" | "warning"): void;
	fail(reason: string, holdExecutorRoute: boolean, expected: HostRunIdentity): void;
	sendRetryPlanning(expected: HostRunIdentity): Promise<void>;
	sendRetryChecklist(expected: HostRunIdentity): Promise<void>;
}

export type SettlementObservation =
	| "host-compacted"
	| "compaction-requested"
	| "compaction-pending"
	| "executor-failure"
	| "none";

function sameIdentity(identity: HostRunIdentity | undefined, run: PrewalkRun | undefined): boolean {
	return run !== undefined && sameValue(identity, { runId: run.id, epoch: run.epoch });
}

function sameValue(left: HostRunIdentity | undefined, right: HostRunIdentity): boolean {
	return left !== undefined && left.runId === right.runId && left.epoch === right.epoch;
}

function compactionFailureReason(route: PressureRoute): string {
	return route === "planner" ? "planner-compaction-failed" : "executor-compaction-failed";
}

function pressureEligibleRun(run: PrewalkRun | undefined, route: PressureRoute): run is PrewalkRun {
	return route === "planner"
		? run?.effectiveRoute === "planner" && (run.phase === "planning" || run.phase === "ready")
		: run?.phase === "handoff-pending" ||
				(run?.effectiveRoute === "executor" &&
					(run.phase === "active" || run.phase === "completed"));
}

/** Owns all mutable planner/executor pressure and compaction transaction state. */
export class ContextPressureController {
	#policy: ContextCompactionPolicy = DEFAULT_CONTEXT_COMPACTION_POLICY;
	#pressure: PressureState | undefined;
	#hostCompaction: PressureState | undefined;
	#pending: CompactionRequest | undefined;
	#retry: RetryState | undefined;
	#pendingFailure: HostRunIdentity | undefined;
	#checklistRun: HostRunIdentity | undefined;

	setPolicy(policy: ContextCompactionPolicy): void {
		this.#policy = policy;
	}

	reserveTokens(): number {
		return this.#policy.reserveTokens;
	}

	reset(): void {
		this.#pressure = undefined;
		this.#hostCompaction = undefined;
		this.#pending = undefined;
		this.#retry = undefined;
		this.#pendingFailure = undefined;
		this.#checklistRun = undefined;
	}

	onExecutorStreamStarted(identity: HostRunIdentity): void {
		if (sameValue(this.#pendingFailure, identity)) this.#pendingFailure = undefined;
	}

	onExecutorStreamSucceeded(identity: HostRunIdentity): void {
		this.onExecutorStreamStarted(identity);
		if (sameValue(this.#retry, identity) && this.#retry?.route === "executor")
			this.#retry = undefined;
	}

	onExecutorStreamFailed(identity: HostRunIdentity): void {
		this.#pendingFailure = { ...identity };
	}

	onPlannerContextPressure(identity: HostRunIdentity): void {
		this.#pendingFailure = undefined;
		this.#pressure = { ...identity, route: "planner", retry: true };
	}

	onPlannerContextSafe(identity: HostRunIdentity): void {
		if (sameValue(this.#retry, identity) && this.#retry?.route === "planner")
			this.#retry = undefined;
	}

	onExecutorContextPressure(identity: HostRunIdentity, retry: boolean): void {
		this.#pendingFailure = undefined;
		this.#pressure = { ...identity, route: "executor", retry };
	}

	hasPlannerPressure(run: PrewalkRun): boolean {
		return sameIdentity(this.#pressure, run) && this.#pressure?.route === "planner";
	}

	hasRetryPressure(run: PrewalkRun): boolean {
		return (
			sameIdentity(this.#pressure, run) &&
			this.#pressure?.route === "executor" &&
			this.#pressure.retry
		);
	}

	takePendingFailure(run: PrewalkRun): boolean {
		if (!sameIdentity(this.#pendingFailure, run)) return false;
		this.#pendingFailure = undefined;
		return true;
	}

	observeContextUsage(
		run: PrewalkRun,
		usageTokens: number | null | undefined,
		executor: Pick<Model<Api>, "contextWindow">,
		messageProvider: string,
		messageModel: string,
		stopReason: string,
	): void {
		if (!pressureEligibleRun(run, "executor")) return;
		if (
			messageProvider !== run.config.executor.provider ||
			messageModel !== run.config.executor.model
		)
			return;
		if (!needsContextCompaction(usageTokens, executor, this.#policy.reserveTokens)) return;
		this.#pressure = {
			runId: run.id,
			epoch: run.epoch,
			route: "executor",
			retry: stopReason !== "stop",
		};
	}

	/** Handles the settled boundary after a guarded stream. */
	settle(run: PrewalkRun, host: ContextPressureHost): SettlementObservation {
		if (run.phase === "cancelled") return "none";
		if (sameIdentity(this.#hostCompaction, run)) {
			this.#hostCompaction = undefined;
			this.#pressure = undefined;
			return "host-compacted";
		}
		const pressure = this.#pressure;
		if (pressure !== undefined && sameIdentity(pressure, run)) {
			this.requestCompaction(run, pressure, host);
			return "compaction-requested";
		}
		if (this.#pending !== undefined) return "compaction-pending";
		if (this.takePendingFailure(run)) return "executor-failure";
		return "none";
	}

	private requestCompaction(
		run: PrewalkRun,
		pressure: PressureState,
		host: ContextPressureHost,
	): void {
		if (!pressureEligibleRun(run, pressure.route) || this.#pending !== undefined) return;
		const identity: HostRunIdentity = { runId: run.id, epoch: run.epoch };
		const failureReason = compactionFailureReason(pressure.route);
		if (!this.#policy.enabled) {
			this.#pressure = undefined;
				host.notify(
					`Prewalk stopped before an oversized ${pressure.route} request because Pi automatic compaction is disabled.`,
					"error",
				);
				return host.fail(failureReason, false, identity);
		}
		if (!this.recordRetry(pressure)) return host.fail(failureReason, false, identity);
		const request: CompactionRequest = { ...pressure, committed: false };
		this.#pending = request;
		const resume = (): void => {
			const resumed =
				request.route === "planner"
					? host.sendRetryPlanning(identity)
					: host.sendRetryChecklist(identity);
			void resumed.catch(() => {
				if (sameIdentity(identity, host.currentRun()))
					host.fail(failureReason, false, identity);
			});
		};
		try {
			host.compact({
				onComplete: () => {
					if (!this.clearRequest(request)) return;
					const current = host.currentRun();
					if (!sameIdentity(request, current) || !pressureEligibleRun(current, request.route))
						return;
					if (request.retry) resume();
				},
				onError: (error) => {
					const committed = request.committed;
					if (!this.clearRequest(request)) return;
					if (committed) {
						const current = host.currentRun();
						if (
							!sameIdentity(request, current) ||
							!pressureEligibleRun(current, request.route)
						)
							return;
						host.notify(
							`Prewalk ${pressure.route} compaction committed before the host reported an observer error (${error.message}); continuing from the compacted context.`,
							"warning",
						);
						if (request.retry) resume();
						return;
					}
					if (!sameIdentity(request, host.currentRun())) return;
					host.notify(
						`Prewalk ${pressure.route} compaction failed: ${error.message}.`,
						"error",
					);
					host.fail(failureReason, false, identity);
				},
			});
		} catch (error) {
			if (!this.clearRequest(request)) return;
				host.notify(
				`Prewalk ${pressure.route} compaction failed: ${error instanceof Error ? error.message : String(error)}.`,
				"error",
			);
			host.fail(failureReason, false, identity);
		}
	}

	private clearRequest(request: CompactionRequest): boolean {
		if (this.#pending !== request) return false;
		this.#pending = undefined;
		this.#pressure = undefined;
		return true;
	}

	private recordRetry(pressure: PressureState): boolean {
		if (!pressure.retry) return true;
		const previous = this.#retry;
		const repeated = sameValue(previous, pressure) && previous?.route === pressure.route;
		if (repeated && previous.count >= 1) return false;
		this.#retry = {
			runId: pressure.runId,
			epoch: pressure.epoch,
			route: pressure.route,
			count: repeated ? previous.count + 1 : 1,
		};
		return true;
	}

	beforeCompaction(
		run: PrewalkRun | undefined,
		compactedMessages: readonly BoundaryValue[],
		isChecklistForRun: (message: BoundaryValue, runId: string) => boolean,
	): void {
		this.#checklistRun =
			this.#pending === undefined &&
			pressureEligibleRun(run, "executor") &&
			compactedMessages.some((message) => isChecklistForRun(message, run.id))
				? { runId: run.id, epoch: run.epoch }
				: undefined;
	}

	async afterCompaction(
		run: PrewalkRun | undefined,
		host: ContextPressureHost,
		willRetry = false,
	): Promise<void> {
		if (this.#pending !== undefined && sameIdentity(this.#pending, run)) {
			this.#pending.committed = true;
		} else {
			const pressure = this.#pressure;
			if (run && pressure !== undefined && sameIdentity(pressure, run)) {
				this.#pressure = undefined;
				const identity = { runId: run.id, epoch: run.epoch };
				if (!this.recordRetry(pressure)) {
					this.#checklistRun = undefined;
					return host.fail(compactionFailureReason(pressure.route), false, identity);
				}
				this.#hostCompaction = pressure;
				if (pressure.retry && !willRetry) {
					if (pressure.route === "planner") {
						await host.sendRetryPlanning(identity);
					} else if (!sameIdentity(this.#checklistRun, run)) {
						await host.sendRetryChecklist(identity);
					}
				}
			}
		}
		if (!willRetry && sameIdentity(this.#checklistRun, run) && pressureEligibleRun(run, "executor")) {
			await host.sendRetryChecklist({ runId: run.id, epoch: run.epoch });
		}
		this.#checklistRun = undefined;
	}

	/**
	 * Reconciles Pi 0.84.3's terminal compaction failure event. A compaction
	 * requested through `ctx.compact()` still has a callback that owns its
	 * semantic failure path; this method only clears the host-side checklist
	 * marker there. Native compaction has no callback, so an active pressure
	 * sequence fails closed unless Pi says it will retry the interrupted turn.
	 */
	compactionFailed(
		run: PrewalkRun | undefined,
		host: ContextPressureHost,
		willRetry: boolean,
	): void {
		this.#checklistRun = undefined;
		if (sameIdentity(this.#pending, run) || !run || willRetry) return;
		const pressure = this.#pressure;
		if (pressure === undefined || !sameIdentity(pressure, run)) return;
		this.#pressure = undefined;
		this.#hostCompaction = undefined;
		host.notify(
			`Prewalk ${pressure.route} compaction failed before Pi could retry the request.`,
			"error",
		);
		host.fail(compactionFailureReason(pressure.route), false, {
			runId: run.id,
			epoch: run.epoch,
		});
	}
}
