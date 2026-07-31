import { describe, expect, it } from "vitest";
import {
	delegationEvidenceKey,
	mergeDelegationEvidence,
	parseDelegationAnalyticsEvent,
} from "../src/analytics-subagents.js";

const event = (phase: "start" | "progress" | "terminal", lifecycle: string = "running") => ({
	version: 1,
	eventId: `event-${phase}`,
	phase,
	rootSessionId: "root",
	parentSessionId: "parent",
	invocationId: "tool-call",
	delegationRunId: "run",
	childIndex: 0,
	childSessionId: "child",
	lifecycle,
	observedAt: 1,
	usage: [
		{
			evidenceKey: "usage-key",
			category: "child",
			inputTokens: 1,
			outputTokens: 2,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 3,
			turns: 1,
			costUsd: 0.1,
		},
	],
});

describe("delegation analytics adapter", () => {
	it("accepts content-free terminal child evidence", () => {
		const parsed = parseDelegationAnalyticsEvent(event("terminal", "completed"));
		expect(parsed.childSessionId).toBe("child");
		expect(parsed.usage[0]?.totalTokens).toBe(3);
	});
	it("rejects prohibited fields and unreconciled usage", () => {
		expect(() =>
			parseDelegationAnalyticsEvent({ ...event("start"), prompt: "secret" }),
		).toThrow();
		expect(() =>
			parseDelegationAnalyticsEvent({
				...event("start"),
				usage: [{ ...event("start").usage[0], totalTokens: 99 }],
			}),
		).toThrow();
	});
	it("deduplicates replay and keeps terminal progression", () => {
		const records = new Map<string, ReturnType<typeof parseDelegationAnalyticsEvent>>();
		const start = parseDelegationAnalyticsEvent(event("start"));
		const terminal = parseDelegationAnalyticsEvent(event("terminal", "completed"));
		expect(mergeDelegationEvidence(records, start)).toBe(true);
		expect(mergeDelegationEvidence(records, start)).toBe(false);
		expect(mergeDelegationEvidence(records, terminal)).toBe(true);
		expect(records.get(delegationEvidenceKey(terminal))?.phase).toBe("terminal");
	});
	it("accepts same-phase enrichment without regressing identity or outcome", () => {
		const records = new Map<string, ReturnType<typeof parseDelegationAnalyticsEvent>>();
		const unresolved = parseDelegationAnalyticsEvent({
			...event("terminal", "incomplete"),
			eventId: "terminal-unresolved",
			childSessionId: undefined,
			usage: [],
		});
		const resolved = parseDelegationAnalyticsEvent({
			...event("terminal", "completed"),
			eventId: "terminal-resolved",
		});
		expect(mergeDelegationEvidence(records, unresolved)).toBe(true);
		expect(mergeDelegationEvidence(records, resolved)).toBe(true);
		expect(records.get(delegationEvidenceKey(resolved))?.childSessionId).toBe("child");
		expect(mergeDelegationEvidence(records, unresolved)).toBe(false);
		expect(
			mergeDelegationEvidence(
				records,
				parseDelegationAnalyticsEvent({
					...event("terminal", "failed"),
					eventId: "terminal-conflict",
				}),
			),
		).toBe(false);
	});
});
