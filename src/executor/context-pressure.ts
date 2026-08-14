import type { Api, Model } from "@earendil-works/pi-ai";
import type { HostRunIdentity } from "../host-event-correlation.js";
import type { PrewalkRun } from "../orchestration/coordinator.js";
import { needsContextCompaction } from "./context.js";

export type ContextCompactionPolicy = {
	enabled: boolean;
	reserveTokens: number;
};

export const DEFAULT_CONTEXT_COMPACTION_POLICY: ContextCompactionPolicy = {
	enabled: true,
	reserveTokens: 16_384,
};

type PressureRoute = "planner" | "executor";
type PressureState = HostRunIdentity & { route: PressureRoute; retry: boolean };
type RetryState = HostRunIdentity & { route: PressureRoute; count: number };
type CompactionRequest = PressureState;

type CompactCallbacks = {
	onComplete: () => void;
	onError: (error: Error) => void;
};

/**
 * Host capabilities used by the primary-route pressure transaction. The adapter
 * supplies Pi's compactor and notices; this module owns the ordering between
 * pressure, settlement, native compaction, retry, and stale-run checks.
 */
export interface ContextPressureHost {
	currentRun(): PrewalkRun | undefined;
	compact(callbacks: CompactCallbacks): void;
	notify(message: string, level: "error" | "warning"): void;
	fail(reason: string, holdExecutorRoute: boolean, expected: HostRunIdentity): void;
	sendRetryPlanning(expected: HostRunIdentity): Promise<void>;
	sendRetryChecklist(expected: HostRunIdentity): Promise<void>;
	sendNextTurnChecklist(expected: HostRunIdentity): void;
}

export type SettlementObservation =
	| "host-compacted"
	| "compaction-requested"
	| "compaction-pending"
	| "executor-failure"
	| "none";

function sameIdentity(identity: HostRunIdentity | undefined, run: PrewalkRun | undefined): boolean {
	return (
		identity !== undefined &&
		run !== undefined &&
		identity.runId === run.id &&
		identity.epoch === run.epoch
	);
}

function sameValue(left: HostRunIdentity | undefined, right: HostRunIdentity): boolean {
	return left !== undefined && left.runId === right.runId && left.epoch === right.epoch;
}

function samePressure(left: RetryState | undefined, right: PressureState): boolean {
	return sameValue(left, right) && left?.route === right.route;
}

function compactionFailureReason(route: PressureRoute): string {
	return route === "planner" ? "planner-compaction-failed" : "executor-compaction-failed";
}

function pressureEligibleRun(run: PrewalkRun | undefined, route: PressureRoute): boolean {
	if (!run) return false;
	if (route === "planner") {
		return (
			run.effectiveRoute === "planner" && (run.phase === "planning" || run.phase === "ready")
		);
	}
	return (
		run.phase === "handoff-pending" ||
		(run.effectiveRoute === "executor" && (run.phase === "active" || run.phase === "completed"))
	);
}

function activeExecutorRun(run: PrewalkRun | undefined): boolean {
	return (
		run !== undefined &&
		run.effectiveRoute === "executor" &&
		(run.phase === "active" || run.phase === "completed")
	);
}

/** Owns all mutable planner/executor pressure and compaction transaction state. */
export class ContextPressureController {
	#policy: ContextCompactionPolicy = DEFAULT_CONTEXT_COMPACTION_POLICY;
	#pressure: PressureState | undefined;
	#hostCompaction: PressureState | undefined;
	#pending: CompactionRequest | undefined;
	#committed: CompactionRequest | undefined;
	#retry: RetryState | undefined;
	#pendingFailure: HostRunIdentity | undefined;
	#checklistRun: HostRunIdentity | undefined;

	setPolicy(policy: ContextCompactionPolicy): void {
		this.#policy = policy;
	}

	policy(): ContextCompactionPolicy {
		return this.#policy;
	}

	reserveTokens(): number {
		return this.#policy.reserveTokens;
	}

	reset(): void {
		this.#pressure = undefined;
		this.#hostCompaction = undefined;
		this.#pending = undefined;
		this.#committed = undefined;
		this.#retry = undefined;
		this.#pendingFailure = undefined;
		this.#checklistRun = undefined;
	}

	onExecutorStreamStarted(identity: HostRunIdentity): void {
		if (sameValue(this.#pendingFailure ?? undefined, identity)) this.#pendingFailure = undefined;
	}

	onExecutorStreamSucceeded(identity: HostRunIdentity): void {
		if (sameValue(this.#pendingFailure ?? undefined, identity)) this.#pendingFailure = undefined;
		if (sameValue(this.#retry ?? undefined, identity) && this.#retry?.route === "executor") {
			this.#retry = undefined;
		}
	}

	onExecutorStreamFailed(identity: HostRunIdentity): void {
		this.#pendingFailure = { ...identity };
	}

	onPlannerContextPressure(identity: HostRunIdentity): void {
		this.#pendingFailure = undefined;
		this.#pressure = { ...identity, route: "planner", retry: true };
	}

	onPlannerContextSafe(identity: HostRunIdentity): void {
		if (sameValue(this.#retry ?? undefined, identity) && this.#retry?.route === "planner") {
			this.#retry = undefined;
		}
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
		if (!activeExecutorRun(run)) return;
		if (
			messageProvider !== run.config.executor.provider ||
			messageModel !== run.config.executor.model
		) {
			return;
		}
		if (needsContextCompaction(usageTokens, executor, this.#policy.reserveTokens)) {
			this.#pressure = {
				runId: run.id,
				epoch: run.epoch,
				route: "executor",
				retry: stopReason !== "stop",
			};
		}
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
		const routeLabel = pressure.route === "planner" ? "planner" : "executor";
		const failureReason = compactionFailureReason(pressure.route);
		if (!this.#policy.enabled) {
			this.#pressure = undefined;
			host.notify(
				`Prewalk stopped before an oversized ${routeLabel} request because Pi automatic compaction is disabled.`,
				"error",
			);
			host.fail(failureReason, false, identity);
			return;
		}
		const previousRetry = this.#retry;
		if (
			pressure.retry &&
			previousRetry !== undefined &&
			samePressure(previousRetry, pressure) &&
			previousRetry.count >= 1
		) {
			host.fail(failureReason, false, identity);
			return;
		}
		const request: CompactionRequest = { ...pressure };
		if (pressure.retry) {
			this.#retry = {
				...identity,
				route: pressure.route,
				count:
					(previousRetry !== undefined && samePressure(previousRetry, pressure)
						? previousRetry.count
						: 0) + 1,
			};
		}
		this.#pending = request;
		this.#committed = undefined;
		const resume = (): void => {
			const resumed =
				request.route === "planner"
					? host.sendRetryPlanning(identity)
					: host.sendRetryChecklist(identity);
			void resumed.catch(() => {
				if (sameIdentity(identity, host.currentRun())) {
					host.fail(failureReason, false, identity);
				}
			});
		};
		try {
			host.compact({
				onComplete: () => {
					if (this.#pending !== request) return;
					this.#pending = undefined;
					this.#pressure = undefined;
					const current = host.currentRun();
					if (!sameIdentity(request, current) || !pressureEligibleRun(current, request.route))
						return;
					if (request.retry) resume();
				},
				onError: (error) => {
					if (this.#pending !== request) return;
					if (this.#committed === request) {
						this.#pending = undefined;
						this.#committed = undefined;
						this.#pressure = undefined;
						const current = host.currentRun();
						if (
							!sameIdentity(request, current) ||
							!pressureEligibleRun(current, request.route)
						)
							return;
						host.notify(
							`Prewalk ${routeLabel} compaction committed before the host reported an observer error (${error.message}); continuing from the compacted context.`,
							"warning",
						);
						if (request.retry) resume();
						return;
					}
					this.#pending = undefined;
					this.#pressure = undefined;
					if (!sameIdentity(request, host.currentRun())) return;
					host.notify(`Prewalk ${routeLabel} compaction failed: ${error.message}.`, "error");
					host.fail(failureReason, false, identity);
				},
			});
		} catch (error) {
			if (this.#pending !== request) return;
			this.#pending = undefined;
			this.#committed = undefined;
			this.#pressure = undefined;
			host.notify(
				`Prewalk ${routeLabel} compaction failed: ${error instanceof Error ? error.message : String(error)}.`,
				"error",
			);
			host.fail(failureReason, false, identity);
		}
	}

	beforeCompaction(
		run: PrewalkRun | undefined,
		compactedMessages: readonly unknown[],
		isChecklistForRun: (message: unknown, runId: string) => boolean,
	): void {
		this.#checklistRun =
			this.#pending === undefined &&
			activeExecutorRun(run) &&
			run !== undefined &&
			compactedMessages.some((message) => isChecklistForRun(message, run.id))
				? { runId: run.id, epoch: run.epoch }
				: undefined;
	}

	async afterCompaction(run: PrewalkRun | undefined, host: ContextPressureHost): Promise<void> {
		if (
			run &&
			this.#pending !== undefined &&
			sameValue(this.#pending, { runId: run.id, epoch: run.epoch })
		) {
			this.#committed = this.#pending;
		} else {
			const pressure = this.#pressure;
			if (run && pressure !== undefined && sameIdentity(pressure, run)) {
				this.#pressure = undefined;
				const identity = { runId: run.id, epoch: run.epoch };
				if (pressure.retry) {
					const previousRetry = this.#retry;
					if (
						previousRetry !== undefined &&
						samePressure(previousRetry, pressure) &&
						previousRetry.count >= 1
					) {
						this.#checklistRun = undefined;
						host.fail(compactionFailureReason(pressure.route), false, identity);
						return;
					}
					this.#retry = {
						...identity,
						route: pressure.route,
						count:
							(previousRetry !== undefined && samePressure(previousRetry, pressure)
								? previousRetry.count
								: 0) + 1,
					};
				}
				this.#hostCompaction = pressure;
				if (pressure.retry) {
					if (pressure.route === "planner") {
						await host.sendRetryPlanning(identity);
					} else if (!sameIdentity(this.#checklistRun, run)) {
						await host.sendRetryChecklist(identity);
					}
				}
			}
		}
		if (run && sameIdentity(this.#checklistRun, run) && activeExecutorRun(run)) {
			host.sendNextTurnChecklist({ runId: run.id, epoch: run.epoch });
		}
		this.#checklistRun = undefined;
	}

	hasPendingCompaction(): boolean {
		return this.#pending !== undefined;
	}
}
