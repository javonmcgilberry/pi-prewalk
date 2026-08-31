import { calculateContextTokens } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Context, Message, Model } from "@earendil-works/pi-ai";
import { type BoundaryValue, isString } from "../guards.js";

/** Stock Pi's default reserveTokens value (see core/compaction/compaction.ts). */
export const CONTEXT_RESERVE_TOKENS = 16_384;

/**
 * Small calibration margin for provider-side request estimates. The estimate
 * intentionally remains conservative because provider tokenization and tool
 * serialization are not visible to this extension.
 */
export const CONTEXT_ESTIMATE_SAFETY_MARGIN = 384;

/**
 * Return the request budget using the same reserve Pi uses for its
 * own compaction checks. Callers supply the effective reserve when the host
 * exposes it; this value remains the safe fallback for older hosts.
 */
export function contextThreshold(
	model: Pick<Model<Api>, "contextWindow">,
	reserveTokens = CONTEXT_RESERVE_TOKENS,
): number {
	if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) return 0;
	const reserve =
		Number.isFinite(reserveTokens) && reserveTokens >= 0 ? reserveTokens : CONTEXT_RESERVE_TOKENS;
	return Math.max(0, model.contextWindow - reserve);
}

/**
 * Callers pass Pi's effective compaction reserve when available. Unknown
 * context usage is treated as pressure rather than risking an oversized
 * request.
 */
export function needsContextCompaction(
	contextTokens: number | null | undefined,
	model: Pick<Model<Api>, "contextWindow">,
	reserveTokens = CONTEXT_RESERVE_TOKENS,
): boolean {
	const threshold = contextThreshold(model, reserveTokens);
	if (threshold <= 0 || contextTokens === null || contextTokens === undefined) return true;
	if (!Number.isFinite(contextTokens) || contextTokens < 0) return true;
	return contextTokens > threshold;
}

/**
 * Estimate the context that will be sent in the next provider request.
 *
 * A valid assistant usage block accounts for the prefix before that response,
 * so trailing messages can be estimated from it. The current whole request is
 * also estimated to catch a changed system prompt or tool schema. The
 * estimator intentionally mirrors Pi's conservative four-characters-per-token
 * heuristic rather than pretending to know a provider-specific tokenizer.
 */
export function estimateRequestTokens(context: Context): number {
	const usageIndex = lastApplicableAssistantUsageIndex(context.messages);
	if (usageIndex === null)
		return estimateWholeRequest(context) + CONTEXT_ESTIMATE_SAFETY_MARGIN;
	let tokens = usageTokens(context.messages[usageIndex] as AssistantMessage);
	for (let index = usageIndex + 1; index < context.messages.length; index++) {
		tokens += estimateMessage(context.messages[index]);
	}
	// The usage-bearing response may have been produced before the current
	// system prompt or tool schemas changed. Keep the conservative whole-request
	// estimate when it is larger rather than trusting stale prefix accounting.
	return Math.max(tokens, estimateWholeRequest(context)) + CONTEXT_ESTIMATE_SAFETY_MARGIN;
}

function estimateWholeRequest(context: Context): number {
	let tokens = ceilTokens((context.systemPrompt ?? "").length);
	for (const message of context.messages) tokens += estimateMessage(message);
	for (const tool of context.tools ?? []) {
		tokens += ceilTokens(tool.name.length) + ceilTokens(tool.description.length);
		tokens += ceilTokens((JSON.stringify(tool.parameters) ?? "").length);
	}
	return tokens;
}

function lastApplicableAssistantUsageIndex(messages: readonly Message[]): number | null {
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	let latest: number | null = null;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (
			message.role === "assistant" &&
			message.timestamp >= latestPrefixTimestamp &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error" &&
			usageTokens(message) > 0
		) {
			latest = index;
		}
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}
	return latest;
}

function usageTokens(message: AssistantMessage): number {
	const total = calculateContextTokens(message.usage);
	return Number.isFinite(total) && total > 0 ? total : 0;
}

function estimateMessage(message: Message): number {
	if (message.role === "user" || message.role === "toolResult")
		return estimateContent(message.content);
	let characters = 0;
	for (const block of message.content) {
		if (block.type === "text" || block.type === "thinking") {
			characters += block.type === "text" ? block.text.length : block.thinking.length;
		} else {
			characters += isString(block.name)
				? block.name.length + safeJson(block.arguments).length
				: safeJson(block).length;
		}
	}
	return ceilTokens(characters);
}

function estimateContent(content: string | readonly { type: string; text?: string }[]): number {
	if (isString(content)) return ceilTokens(content.length);
	let characters = 0;
	for (const block of content)
		characters += block.type === "text" ? (block.text?.length ?? 0) : 4_800;
	return ceilTokens(characters);
}

function ceilTokens(characters: number): number {
	return Math.ceil(characters / 4);
}

function safeJson(value: BoundaryValue): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch { return "[unserializable]"; }
}
