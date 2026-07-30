import { isThinkingLevel, type ThinkingLevel } from "./protocol.mjs";

export { THINKING_LEVELS, type ThinkingLevel } from "./protocol.mjs";

export const CHECKPOINT_TOOL = "prewalk_checkpoint";
export const MUTATION_TOOLS = new Set(["edit", "write"]);
export const EXPLORATION_TOOLS = new Set(["read", "grep", "find", "ls"]);
export const MAX_CHECKPOINT_ITEMS = 9;
export const MIN_CHECKPOINT_ITEMS = 5;
export const MAX_CHECKPOINT_ITEM_LENGTH = 500;
export const MAX_CHECKPOINT_TOTAL_LENGTH = 3_000;

export interface PrewalkConfig {
	enabled: boolean;
	target: string;
	thinkingLevel: ThinkingLevel;
	crossProviderPairs: string[];
}

export interface TargetSpec {
	provider: string;
	id: string;
	name: string;
}

export type RunMode = "automatic" | "manual";
export type RunPhase =
	| "armed"
	| "planning"
	| "checkpointed"
	| "mutation-pending"
	| "handoff-pending"
	| "completed";
export type ToolResultStatus = "success" | "error" | "cancelled";

export interface PrewalkRun {
	id: string;
	mode: RunMode;
	phase: RunPhase;
	target: TargetSpec;
	thinkingLevel: ThinkingLevel;
	plannerRecipientFingerprint: string;
	targetRecipientFingerprint: string;
	crossProviderPair?: string;
	projectionActive: boolean;
	mutationToolCallId?: string;
	checkpointItems?: string[];
}

export type SettledAction = { type: "none" } | { type: "disarmed"; reason: string };
export type ToolCallAction = { block: false } | { block: true; reason: string };
export type ToolResultAction =
	| { type: "none" }
	| { type: "activated" }
	| { type: "handoff-pending"; run: PrewalkRun };
export type TurnEndAction = { type: "none" } | { type: "handoff"; run: PrewalkRun };
export type LifecycleAction = { type: "none" } | { type: "disarmed"; reason: string };

const CONFIG_KEYS = new Set(["enabled", "target", "thinkingLevel", "crossProviderPairs"]);
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._:/-]*$/i;

export function parseTarget(value: string): { provider: string; id: string } | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	const provider = value.slice(0, slash);
	const id = value.slice(slash + 1);
	if (!PROVIDER_PATTERN.test(provider) || !MODEL_PATTERN.test(id)) return undefined;
	return { provider, id };
}

export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
	return isThinkingLevel(value) ? value : undefined;
}

export function parseConfig(value: unknown): PrewalkConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Prewalk config must be a JSON object.");
	}
	const record = value as Record<string, unknown>;
	const unknownKeys = Object.keys(record).filter((key) => !CONFIG_KEYS.has(key));
	if (unknownKeys.length > 0)
		throw new Error(`Unknown Prewalk config field: ${unknownKeys.join(", ")}.`);
	if (typeof record.enabled !== "boolean")
		throw new Error("Prewalk config enabled must be boolean.");
	if (typeof record.target !== "string" || !parseTarget(record.target)) {
		throw new Error("Prewalk config target must be provider/model.");
	}
	const thinkingLevel = parseThinkingLevel(record.thinkingLevel);
	if (!thinkingLevel) throw new Error("Prewalk config thinkingLevel is invalid.");
	if (
		!Array.isArray(record.crossProviderPairs) ||
		!record.crossProviderPairs.every((pair) => typeof pair === "string")
	) {
		throw new Error("Prewalk config crossProviderPairs must be a string array.");
	}
	const pairs = [...new Set(record.crossProviderPairs as string[])];
	for (const pair of pairs) {
		const [from, to, ...extra] = pair.split("->");
		if (
			extra.length > 0 ||
			!PROVIDER_PATTERN.test(from ?? "") ||
			!PROVIDER_PATTERN.test(to ?? "")
		) {
			throw new Error(`Invalid cross-provider pair: ${pair}.`);
		}
	}
	return {
		enabled: record.enabled,
		target: record.target,
		thinkingLevel,
		crossProviderPairs: pairs,
	};
}

export function validateCheckpoint(
	run: PrewalkRun,
	input: Record<string, unknown>,
): string[] | undefined {
	if (input.runId !== run.id || !Array.isArray(input.items)) return undefined;
	if (input.items.length < MIN_CHECKPOINT_ITEMS || input.items.length > MAX_CHECKPOINT_ITEMS)
		return undefined;
	const items: string[] = [];
	let totalLength = 0;
	for (const item of input.items) {
		if (typeof item !== "string") return undefined;
		const trimmed = item.trim();
		if (!trimmed || trimmed.length > MAX_CHECKPOINT_ITEM_LENGTH) return undefined;
		totalLength += trimmed.length;
		if (totalLength > MAX_CHECKPOINT_TOTAL_LENGTH) return undefined;
		items.push(trimmed);
	}
	return items;
}

function clearRunState(run: PrewalkRun): void {
	run.projectionActive = false;
	run.checkpointItems = undefined;
	run.mutationToolCallId = undefined;
}

export class PrewalkCoordinator {
	run: PrewalkRun | undefined;

	arm(run: Omit<PrewalkRun, "phase" | "projectionActive">): PrewalkRun {
		if (this.run) throw new Error("Prewalk is already armed.");
		this.run = {
			...run,
			phase: run.mode === "automatic" ? "armed" : "planning",
			projectionActive: run.mode === "manual",
		};
		return this.run;
	}

	activateManual(): PrewalkRun {
		const run = this.run;
		if (!run || run.phase !== "armed")
			throw new Error("No dormant automatic Prewalk run is available.");
		run.mode = "manual";
		this.activatePlanning(run);
		return run;
	}

	disarm(): void {
		if (this.run) clearRunState(this.run);
		this.run = undefined;
	}

	onLifecycleBoundary(reason: string): LifecycleAction {
		if (!this.run) return { type: "none" };
		this.disarm();
		return { type: "disarmed", reason };
	}

	onAgentSettled(): SettledAction {
		const run = this.run;
		if (!run) return { type: "none" };
		this.disarm();
		if (run.phase === "completed") return { type: "none" };
		return {
			type: "disarmed",
			reason: "Prewalk disarmed when the agent settled before handoff.",
		};
	}

	onCheckpointResult(input: Record<string, unknown>, isError: boolean): boolean {
		const run = this.run;
		if (!run || run.phase !== "planning" || isError) return false;
		const items = validateCheckpoint(run, input);
		if (!items) return false;
		run.checkpointItems = items;
		run.phase = "checkpointed";
		return true;
	}

	onToolCall(toolName: string, toolCallId: string, targetReady = false): ToolCallAction {
		const run = this.run;
		if (!run || !MUTATION_TOOLS.has(toolName)) return { block: false };
		if (run.phase === "armed") this.activatePlanning(run);
		if (run.phase === "planning") {
			return {
				block: true,
				reason: `Call ${CHECKPOINT_TOOL} successfully before editing or writing.`,
			};
		}
		if (run.phase === "checkpointed") {
			if (!targetReady) {
				return {
					block: true,
					reason:
						"Prewalk target is not ready; configure and authenticate it before mutation.",
				};
			}
			run.phase = "mutation-pending";
			run.mutationToolCallId = toolCallId;
			return { block: false };
		}
		if (run.phase === "mutation-pending" && run.mutationToolCallId === toolCallId)
			return { block: false };
		if (run.phase === "handoff-pending" || run.phase === "completed") {
			return {
				block: true,
				reason: "Prewalk handoff is already pending or complete.",
			};
		}
		return {
			block: true,
			reason: "Prewalk permits exactly one post-checkpoint mutation at a time.",
		};
	}

	onToolResult(toolName: string, toolCallId: string, status: ToolResultStatus): ToolResultAction {
		const run = this.run;
		if (!run) return { type: "none" };

		if (EXPLORATION_TOOLS.has(toolName)) {
			if (run.phase === "armed" && status === "success") {
				this.activatePlanning(run);
				return { type: "activated" };
			}
			return { type: "none" };
		}

		if (!MUTATION_TOOLS.has(toolName)) return { type: "none" };
		if (run.phase !== "mutation-pending" || run.mutationToolCallId !== toolCallId)
			return { type: "none" };
		if (status !== "success") {
			run.phase = "checkpointed";
			run.mutationToolCallId = undefined;
			return { type: "none" };
		}
		run.phase = "handoff-pending";
		run.projectionActive = false;
		return { type: "handoff-pending", run };
	}

	onTurnEnd(): TurnEndAction {
		const run = this.run;
		if (!run || run.phase !== "handoff-pending") return { type: "none" };
		run.phase = "completed";
		return { type: "handoff", run };
	}

	private activatePlanning(run: PrewalkRun): void {
		run.phase = "planning";
		run.projectionActive = true;
	}
}
