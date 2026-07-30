export const HIDDEN_GUIDANCE_SENTINEL = "<prewalk-context-only-guidance:v1>";

export const THINKING_LEVELS = Object.freeze([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

const thinkingLevels = new Set(THINKING_LEVELS);

export function containsHiddenGuidance(value) {
	return JSON.stringify(value).includes(HIDDEN_GUIDANCE_SENTINEL);
}

export function isThinkingLevel(value) {
	return typeof value === "string" && thinkingLevels.has(value);
}
