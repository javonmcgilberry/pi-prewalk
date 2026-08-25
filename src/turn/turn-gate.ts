import {
	type MutationExecutionUpdate,
	type MutationToolResult,
	MutationTurnBuffer,
	type MutationTurnEvidence,
	type MutationTurnOptions,
} from "./mutation.js";
import {
	applyTodoOperation,
	hasActionableTodo,
	latestTodoPhases,
	type TodoInput,
	type TodoPhase,
	type TodoResult,
} from "./todo.js";

/**
 * Turn-proof boundary for one Prewalk trajectory. It is the only owner of the
 * current checklist snapshot and the buffered mutation evidence used to open
 * handoff.
 */
export class TurnGate {
	readonly #runMutations = new MutationTurnBuffer();
	#todoPhases: TodoPhase[] = [];

	resetRun(): void {
		this.#runMutations.resetForRun();
		this.#todoPhases = [];
	}

	resetMutationEvidence(): void {
		this.#runMutations.resetForRun();
	}

	restoreTodo(messages: readonly unknown[]): void {
		this.#todoPhases = latestTodoPhases(messages);
	}

	setTodoPhases(phases: readonly TodoPhase[]): void {
		this.#todoPhases = structuredClone([...phases]);
	}

	todoPhases(): TodoPhase[] {
		return structuredClone(this.#todoPhases);
	}

	applyTodo(input: TodoInput): TodoResult {
		const result = applyTodoOperation(this.#todoPhases, input);
		if (!result.isError) this.#todoPhases = result.details.phases;
		return result;
	}

	viewTodo(): TodoResult {
		return applyTodoOperation(this.#todoPhases, { op: "view" });
	}

	hasActionableTodo(): boolean {
		return hasActionableTodo(this.#todoPhases);
	}

	recordExecutionUpdate(event: MutationExecutionUpdate): void {
		this.#runMutations.recordExecutionUpdate(event);
	}

	recordResult(event: MutationToolResult): void {
		this.#runMutations.recordResult(event);
	}

	finishTurn(message: unknown, options: MutationTurnOptions): MutationTurnEvidence {
		return this.#runMutations.finishTurn(message, options);
	}
}
