import type { Model } from "@earendil-works/pi-ai";
import type { HostRunIdentity } from "../host-event-correlation.js";
import type { PrewalkRun } from "../orchestration/coordinator.js";
import { needsExecutorCompaction } from "./context.js";

export type ExecutorCompactionPolicy = {
	enabled: boolean;
	reserveTokens: number;
};

export const DEFAULT_EXECUTOR_COMPACTION_POLICY: ExecutorCompactionPolicy = {
	enabled: true,
	reserveTokens: 16_384,
};

type PressureState = HostRunIdentity & { retry: boolean };
type RetryState = HostRunIdentity & { count: number };
type CompactionRequest = PressureState;

type CompactCallbacks = {
	onComplete: () => void;
	onError: (error: Error) => void;
};

/**
 * Host capabilities used by the executor-pressure transaction. The adapter
 * supplies Pi's compactor and notices; this module owns the ordering between
 * pressure, settlement, native compaction, retry, and stale-run checks.
 */
export interface ContextPressureHost {
	currentRun(): PrewalkRun | undefined;
	compact(callbacks: CompactCallbacks): void;
	notify(message: string, level: "error" | "warning"): void;
	fail(reason: string, holdExecutorRoute: boolean, expected: HostRunIdentity): void;
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

function pressureEligibleRun(run: PrewalkRun | undefined): boolean {
	return (
		run !== undefined &&
		(run.phase === "handoff-pending" ||
			(run.effectiveRoute === "executor" &&
				(run.phase === "active" || run.phase === "completed")))
	);
}

function activeExecutorRun(run: PrewalkRun | undefined): boolean {
	return (
		run !== undefined &&
		run.effectiveRoute === "executor" &&
		(run.phase === "active" || run.phase === "completed")
	);
}

/** Owns all mutable executor pressure and compaction transaction state. */
export class ContextPressureController {
	#policy: ExecutorCompactionPolicy = DEFAULT_EXECUTOR_COMPACTION_POLICY;
	#pressure: PressureState | undefined;
	#hostCompaction: PressureState | undefined;
	#pending: CompactionRequest | undefined;
	#committed: CompactionRequest | undefined;
	#retry: RetryState | undefined;
	#pendingFailure: HostRunIdentity | undefined;
	#checklistRun: HostRunIdentity | undefined;

	setPolicy(policy: ExecutorCompactionPolicy): void {
		this.#policy = policy;
	}

	policy(): ExecutorCompactionPolicy {
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
		if (sameValue(this.#retry ?? undefined, identity)) this.#retry = undefined;
	}

	onExecutorStreamFailed(identity: HostRunIdentity): void {
		this.#pendingFailure = { ...identity };
	}

	onExecutorContextPressure(identity: HostRunIdentity, retry: boolean): void {
		this.#pendingFailure = undefined;
		this.#pressure = { ...identity, retry };
	}

	takePendingFailure(run: PrewalkRun): boolean {
		if (!sameIdentity(this.#pendingFailure, run)) return false;
		this.#pendingFailure = undefined;
		return true;
	}

	observeContextUsage(
		run: PrewalkRun,
		usageTokens: number | null | undefined,
		executor: Pick<Model<any>, "contextWindow">,
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
		if (needsExecutorCompaction(usageTokens, executor, this.#policy.reserveTokens)) {
			this.#pressure = {
				runId: run.id,
				epoch: run.epoch,
				retry: stopReason !== "stop",
			};
		}
	}

	/**
	 * Handles the settlement boundary after an executor stream. At most one
	 * compaction request can be issued for a pressure observation.
	 */
	settle(run: PrewalkRun, host: ContextPressureHost): SettlementObservation {
		if (run.phase === "cancelled") return "none";
		if (sameIdentity(this.#hostCompaction, run)) {
			this.#hostCompaction = undefined;
			this.#pressure = undefined;
			return "host-compacted";
		}
		const pressure = this.#pressure;
		if (pressure !== undefined && sameIdentity(pressure, run)) {
			this.requestCompaction(run, pressure.retry, host);
			return "compaction-requested";
		}
		if (this.#pending !== undefined) return "compaction-pending";
		if (this.takePendingFailure(run)) return "executor-failure";
		return "none";
	}

	private requestCompaction(run: PrewalkRun, retry: boolean, host: ContextPressureHost): void {
		if (!pressureEligibleRun(run) || this.#pending !== undefined) return;
		const identity: HostRunIdentity = { runId: run.id, epoch: run.epoch };
		if (!this.#policy.enabled) {
			this.#pressure = undefined;
			host.notify(
				"Prewalk stopped before an oversized executor request because Pi automatic compaction is disabled.",
				"error",
			);
			host.fail("executor-compaction-failed", false, identity);
			return;
		}
		const previousRetry = this.#retry;
		if (
			retry &&
			previousRetry !== undefined &&
			sameValue(previousRetry, identity) &&
			previousRetry.count >= 1
		) {
			host.fail("executor-compaction-failed", false, identity);
			return;
		}
		const request: CompactionRequest = { ...identity, retry };
		if (retry) {
			this.#retry = {
				...identity,
				count:
					(previousRetry !== undefined && sameValue(previousRetry, identity)
						? previousRetry.count
						: 0) + 1,
			};
		}
		this.#pending = request;
		this.#committed = undefined;
		const retryChecklist = (): void => {
			void host.sendRetryChecklist(identity).catch(() => {
				if (sameIdentity(identity, host.currentRun())) {
					host.fail("executor-compaction-failed", false, identity);
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
					if (!sameIdentity(request, current) || !pressureEligibleRun(current)) return;
					if (request.retry) retryChecklist();
				},
				onError: (error) => {
					if (this.#pending !== request) return;
					if (this.#committed === request) {
						this.#pending = undefined;
						this.#committed = undefined;
						this.#pressure = undefined;
						const current = host.currentRun();
						if (!sameIdentity(request, current) || !pressureEligibleRun(current)) return;
						host.notify(
							`Prewalk executor compaction committed before the host reported an observer error (${error.message}); continuing from the compacted context.`,
							"warning",
						);
						if (request.retry) retryChecklist();
						return;
					}
					this.#pending = undefined;
					this.#pressure = undefined;
					if (!sameIdentity(request, host.currentRun())) return;
					host.notify(`Prewalk executor compaction failed: ${error.message}.`, "error");
					host.fail("executor-compaction-failed", false, identity);
				},
			});
		} catch (error) {
			if (this.#pending !== request) return;
			this.#pending = undefined;
			this.#committed = undefined;
			this.#pressure = undefined;
			host.notify(
				`Prewalk executor compaction failed: ${error instanceof Error ? error.message : String(error)}.`,
				"error",
			);
			host.fail("executor-compaction-failed", false, identity);
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
				this.#hostCompaction = pressure;
				this.#pressure = undefined;
				if (pressure.retry && !sameIdentity(this.#checklistRun, run)) {
					await host.sendRetryChecklist({ runId: run.id, epoch: run.epoch });
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
