import type { Api, Model } from "@earendil-works/pi-ai";
import { isRecord } from "./guards.js";

export const PLANNER_PROVIDER = "openai-codex";
export const PLANNER_MODEL_ID = "gpt-5.6-sol";
export const EXECUTOR_PROVIDER = "openai-codex";
export const EXECUTOR_MODEL_ID = "gpt-5.6-luna";
export const EXECUTOR_THINKING_LEVEL = "low";

export const PREWALK_PLAN_MESSAGE_TYPE = "prewalk-plan";
export const PREWALK_CONTINUE_MESSAGE_TYPE = "prewalk-continue";
export const PREWALK_CHECKLIST_MESSAGE_TYPE = "prewalk-checklist";

export interface PrewalkConfig {
	enabled: boolean;
}

export type RunMode = "automatic" | "manual";
export type RunPhase =
	| "armed"
	| "planning"
	| "ready"
	| "handoff-pending"
	| "active"
	| "completed"
	| "cancelled"
	| "failed";
export type EffectiveRoute = "sol" | "luna" | "selected";

export interface MutationTrigger {
	toolCallId: string;
	toolName: string;
}

export interface PrewalkRun {
	id: string;
	epoch: string;
	mode: RunMode;
	phase: RunPhase;
	effectiveRoute: EffectiveRoute;
	planningPromptInjected: boolean;
	continuePending: boolean;
	todoActive: boolean;
	todoSeen: boolean;
	trigger?: MutationTrigger;
	reasonCode?: string;
}

export interface TurnEvidence {
	hasToolResults: boolean;
	todoSucceeded: boolean;
	mutation?: MutationTrigger;
}

export type CoordinatorAction =
	| { type: "none" }
	| { type: "send-planning" }
	| { type: "send-continuation" }
	| { type: "handoff"; trigger: MutationTrigger };

const CONFIG_KEYS = new Set(["enabled"]);

export function isPlannerSelected(model: Model<Api> | undefined): boolean {
	return model?.provider === PLANNER_PROVIDER && model.id === PLANNER_MODEL_ID;
}

export function parseConfig(value: unknown): PrewalkConfig {
	if (!isRecord(value)) {
		throw new Error("Prewalk config must be a JSON object.");
	}
	const unknownKeys = Object.keys(value).filter((key) => !CONFIG_KEYS.has(key));
	if (unknownKeys.length > 0) {
		throw new Error(`Unknown Prewalk config field: ${unknownKeys.join(", ")}.`);
	}
	if (typeof value.enabled !== "boolean") {
		throw new Error("Prewalk config enabled must be boolean.");
	}
	return { enabled: value.enabled };
}

function createRun(id: string, epoch: string, mode: RunMode, todoActive: boolean): PrewalkRun {
	return {
		id,
		epoch,
		mode,
		phase: mode === "manual" ? "planning" : "armed",
		effectiveRoute: "sol",
		planningPromptInjected: mode === "manual",
		continuePending: mode === "manual",
		todoActive,
		todoSeen: false,
	};
}

export class PrewalkCoordinator {
	#run: PrewalkRun | undefined;

	get run(): PrewalkRun | undefined {
		return this.#run;
	}

	arm(id: string, epoch: string, mode: RunMode, todoActive: boolean): CoordinatorAction {
		if (this.#run && this.#run.phase !== "cancelled" && this.#run.phase !== "failed") {
			throw new Error("Prewalk is already active.");
		}
		this.#run = createRun(id, epoch, mode, todoActive);
		return mode === "manual" ? { type: "send-planning" } : { type: "none" };
	}

	restore(run: PrewalkRun): void {
		this.#run = structuredClone(run);
	}

	reset(): void {
		this.#run = undefined;
	}

	onTurnEnd(evidence: TurnEvidence): CoordinatorAction {
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

		if (run.planningPromptInjected && evidence.hasToolResults) {
			run.continuePending = true;
		} else if (run.continuePending) {
			run.continuePending = false;
			return { type: "send-continuation" };
		}

		const gateOpen = run.todoSeen || !run.todoActive;
		if (gateOpen && evidence.mutation) {
			run.phase = "handoff-pending";
			run.trigger = evidence.mutation;
			return { type: "handoff", trigger: evidence.mutation };
		}

		if (!run.planningPromptInjected) {
			run.planningPromptInjected = true;
			run.continuePending = true;
			run.phase = gateOpen ? "ready" : "planning";
			return { type: "send-planning" };
		}

		run.phase = gateOpen ? "ready" : "planning";
		return { type: "none" };
	}

	activateLuna(): void {
		const run = this.requiredRun();
		if (run.phase !== "handoff-pending") {
			throw new Error("Prewalk handoff is not pending.");
		}
		run.phase = "active";
		run.effectiveRoute = "luna";
	}

	completeHandoff(): void {
		const run = this.requiredRun();
		if (run.phase !== "active") {
			throw new Error("Luna is not active.");
		}
		run.phase = "completed";
	}

	cancel(selectedModelIsSol: boolean): void {
		const run = this.requiredRun();
		run.phase = "cancelled";
		run.effectiveRoute = selectedModelIsSol ? "sol" : "selected";
		run.continuePending = false;
	}

	fail(reasonCode: string, holdLunaRoute: boolean): void {
		const run = this.requiredRun();
		run.phase = "failed";
		run.reasonCode = reasonCode;
		run.effectiveRoute = holdLunaRoute ? "luna" : "sol";
		run.continuePending = false;
	}

	private requiredRun(): PrewalkRun {
		if (!this.#run) throw new Error("Prewalk is not active.");
		return this.#run;
	}
}
