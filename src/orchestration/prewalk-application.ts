import {
	type CoordinatorAction,
	createPrewalkRun,
	type PlannerProfile,
	type PrewalkConfig,
	type PrewalkRun,
	type RunMode,
	type TurnEvidence,
} from "./coordinator.js";

/**
 * The one-run application boundary. Pi adapters may observe a snapshot and
 * ask for a lifecycle decision, but they do not own the run object or phase
 * transitions. Every replacement is a new immutable identity (run ID + epoch)
 * and every restore is cloned before it becomes live state.
 */
export class PrewalkApplication {
	#run: PrewalkRun | undefined;

	get run(): PrewalkRun | undefined {
		return this.#run;
	}

	identity(): { runId: string; epoch: string } | undefined {
		const run = this.#run;
		return run === undefined ? undefined : { runId: run.id, epoch: run.epoch };
	}

	isCurrent(identity: { runId: string; epoch: string } | undefined): boolean {
		const current = this.#run;
		return (
			identity !== undefined &&
			current !== undefined &&
			identity.runId === current.id &&
			identity.epoch === current.epoch
		);
	}

	start(
		id: string,
		epoch: string,
		mode: RunMode,
		todoActive: boolean,
		planner: PlannerProfile,
		config: PrewalkConfig,
	): CoordinatorAction {
		if (this.#run && this.#run.phase !== "cancelled" && this.#run.phase !== "failed") {
			throw new Error("Prewalk is already active.");
		}
		this.#run = createPrewalkRun(id, epoch, mode, todoActive, planner, config);
		return mode === "manual" ? { type: "send-planning" } : { type: "none" };
	}

	/** Compatibility spelling for callers that still call the start transition "arm". */
	arm(
		id: string,
		epoch: string,
		mode: RunMode,
		todoActive: boolean,
		planner: PlannerProfile,
		config: PrewalkConfig,
	): CoordinatorAction {
		return this.start(id, epoch, mode, todoActive, planner, config);
	}

	/** Alias used by the Pi adapter when restoring a persisted trajectory. */
	restore(run: PrewalkRun): void {
		this.#run = structuredClone(run);
	}

	/** Explicit replacement boundary; old state cannot leak into the new run. */
	replace(
		id: string,
		epoch: string,
		mode: RunMode,
		todoActive: boolean,
		planner: PlannerProfile,
		config: PrewalkConfig,
	): CoordinatorAction {
		this.#run = undefined;
		return this.start(id, epoch, mode, todoActive, planner, config);
	}

	reset(): void {
		this.#run = undefined;
	}

	settle(evidence: TurnEvidence): CoordinatorAction {
		const run = this.#run;
		if (
			!run ||
			run.phase === "active" ||
			run.phase === "completed" ||
			run.phase === "cancelled" ||
			run.phase === "failed"
		) {
			return { type: "none" };
		}

		if (evidence.todoSucceeded) run.todoSeen = true;
		const gateOpen = run.todoSeen || !run.todoActive;
		if (gateOpen && evidence.mutation) {
			run.phase = "handoff-pending";
			run.trigger = evidence.mutation;
			return { type: "handoff", trigger: evidence.mutation };
		}
		if (!run.planningPromptInjected) {
			run.planningPromptInjected = true;
			run.phase = gateOpen ? "ready" : "planning";
			return { type: "send-planning" };
		}
		run.phase = gateOpen ? "ready" : "planning";
		return { type: "none" };
	}

	/** Compatibility spelling for the host event named turn_end. */
	onTurnEnd(evidence: TurnEvidence): CoordinatorAction {
		return this.settle(evidence);
	}

	requestContinuation(actionableTodo: boolean): CoordinatorAction {
		const run = this.#run;
		if (
			!run ||
			(run.phase !== "planning" && run.phase !== "ready") ||
			!run.todoSeen ||
			!actionableTodo ||
			run.continuePending
		) {
			return { type: "none" };
		}
		run.continuePending = true;
		return { type: "send-continuation" };
	}

	activateExecutor(): void {
		const run = this.requiredRun();
		if (run.phase !== "handoff-pending") {
			throw new Error("Prewalk handoff is not pending.");
		}
		run.phase = "active";
		run.effectiveRoute = "executor";
	}

	completeHandoff(): void {
		const run = this.requiredRun();
		if (run.phase !== "active") {
			throw new Error("The Prewalk executor is not active.");
		}
		run.phase = "completed";
	}

	release(): void {
		const run = this.requiredRun();
		if (
			run.effectiveRoute !== "executor" ||
			(run.phase !== "active" && run.phase !== "completed")
		) {
			throw new Error("The Prewalk executor is not active.");
		}
		run.effectiveRoute = "planner";
	}

	cancel(selectedModelIsPlanner: boolean): void {
		const run = this.requiredRun();
		run.phase = "cancelled";
		run.effectiveRoute = selectedModelIsPlanner ? "planner" : "selected";
		run.continuePending = false;
	}

	fail(reasonCode: string, holdExecutorRoute: boolean): void {
		const run = this.requiredRun();
		run.phase = "failed";
		run.reasonCode = reasonCode;
		run.effectiveRoute = holdExecutorRoute ? "executor" : "planner";
		run.continuePending = false;
	}

	private requiredRun(): PrewalkRun {
		if (!this.#run) throw new Error("Prewalk is not active.");
		return this.#run;
	}
}
