import { describe, expect, it } from "vitest";
import {
	delegationEvidenceKey,
	mergeDelegationEvidence,
	parseDelegationAnalyticsEvent,
	projectDelegationToolResult,
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
	it("projects upstream pi-subagents result details without a package event producer", () => {
		expect(
			projectDelegationToolResult({
				rootSessionId: "root",
				parentSessionId: "parent",
				invocationId: "tool-call",
				childCount: 1,
				details: {
					runId: "run",
					results: [
						{
							agent: "reviewer",
							exitCode: 0,
							usage: {
								input: 10,
								output: 5,
								cacheRead: 20,
								cacheWrite: 1,
								cost: 0.25,
								turns: 2,
							},
						},
					],
				},
				isError: false,
				observedAt: 100,
			}),
		).toEqual([
			{
				schemaVersion: 1,
				eventId: "tool-call.run.0.terminal.100",
				phase: "terminal",
				rootSessionId: "root",
				parentSessionId: "parent",
				invocationId: "tool-call",
				delegationRunId: "run",
				childIndex: 0,
				lifecycle: "completed",
				observedAt: 100,
				usage: [
					{
						evidenceKey: "subagent:run:0",
						category: "child",
						inputTokens: 10,
						outputTokens: 5,
						cacheReadTokens: 20,
						cacheWriteTokens: 1,
						totalTokens: 36,
						turns: 2,
						costUsd: 0.25,
					},
				],
			},
		]);
	});

	it("keeps async launches pending until a terminal public result is observed", () => {
		expect(
			projectDelegationToolResult({
				rootSessionId: "root",
				parentSessionId: "parent",
				invocationId: "tool-call",
				childCount: 2,
				details: { asyncId: "async-run", results: [] },
				isError: false,
				observedAt: 100,
			}).map((item) => ({
				childIndex: item.childIndex,
				phase: item.phase,
				lifecycle: item.lifecycle,
			})),
		).toEqual([
			{ childIndex: 0, phase: "start", lifecycle: "running" },
			{ childIndex: 1, phase: "start", lifecycle: "running" },
		]);
	});

	it("marks nested summaries without complete usage as incomplete", () => {
		const projected = projectDelegationToolResult({
			rootSessionId: "root",
			parentSessionId: "parent",
			invocationId: "tool-call",
			childCount: 1,
			details: {
				runId: "run",
				results: [
					{
						agent: "reviewer",
						exitCode: 0,
						usage: {
							input: 10,
							output: 5,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0.25,
							turns: 2,
						},
						children: [
							{
								id: "nested-run",
								state: "complete",
								children: [{ id: "nested-grandchild", state: "complete" }],
							},
						],
					},
				],
			},
			isError: false,
			observedAt: 100,
		});

		expect(projected).toHaveLength(3);
		expect(projected[1]).toMatchObject({
			delegationRunId: "nested-run",
			childIndex: 1,
			phase: "terminal",
			lifecycle: "incomplete",
			usage: [],
		});
		expect(projected[2]).toMatchObject({
			delegationRunId: "nested-grandchild",
			childIndex: 2,
			phase: "terminal",
			lifecycle: "incomplete",
			usage: [],
		});
	});

	it("does not project fractional token or turn counts", () => {
		const [projected] = projectDelegationToolResult({
			rootSessionId: "root",
			parentSessionId: "parent",
			invocationId: "tool-call",
			childCount: 1,
			details: {
				runId: "run",
				results: [
					{
						exitCode: 0,
						usage: {
							input: 1.5,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0.1,
							turns: 1,
						},
					},
				],
			},
			isError: false,
			observedAt: 100,
		});

		expect(projected?.usage).toEqual([]);
	});

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
