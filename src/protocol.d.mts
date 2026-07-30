export const HIDDEN_GUIDANCE_SENTINEL: "<prewalk-context-only-guidance:v1>";
export const THINKING_LEVELS: readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export function containsHiddenGuidance(value: unknown): boolean;
export function isThinkingLevel(value: unknown): value is ThinkingLevel;
