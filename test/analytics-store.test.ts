import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ANALYTICS_SCHEMA_VERSION,
	DEFAULT_ANALYTICS_CONFIG,
	type RunJournal,
	type RunOutcome,
	type RunReceipt,
	summarizeActualCost,
	type UsageSlice,
	type VerifiedBenchmarkSummary,
} from "../src/analytics.js";
import { AnalyticsStore, resolveAnalyticsDirectory } from "../src/analytics-store.js";
import { projectDelegationToolResult } from "../src/analytics-subagents.js";

const planner = { provider: "provider", model: "planner" };
const executor = { provider: "provider", model: "executor" };

function usage(sequence: number, cost: number): UsageSlice {
	return {
		sequence,
		provider: "provider",
		model: sequence % 2 === 0 ? "executor" : "planner",
		role: sequence % 2 === 0 ? "executor-primary" : "planner-primary",
		inputTokens: 10,
		outputTokens: 5,
		cacheReadTokens: 2,
		cacheWriteTokens: 1,
		reasoningTokens: 0,
		totalTokens: 18,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function journal(
	generation: string,
	runId = "run-1",
	overrides: Partial<RunJournal> = {},
): RunJournal {
	return {
		schemaVersion: ANALYTICS_SCHEMA_VERSION,
		runId,
		epoch: "epoch-1",
		sessionId: "session-1",
		generation,
		configuration: { analytics: DEFAULT_ANALYTICS_CONFIG, planner, executor },
		startedAt: "2026-03-08T06:30:00.000Z",
		lastObservedSequence: 1,
		outcome: "active",
		handoffState: "pending",
		usage: [usage(1, 0.25)],
		...overrides,
	};
}

function receipt(
	generation: string,
	runId = "run-1",
	overrides: Partial<RunReceipt> = {},
): RunReceipt {
	return {
		schemaVersion: ANALYTICS_SCHEMA_VERSION,
		runId,
		epoch: "epoch-1",
		sessionId: "session-1",
		generation,
		startedAt: "2026-03-08T06:30:00.000Z",
		completedAt: "2026-03-08T07:30:00.000Z",
		outcome: "succeeded",
		handoffState: "completed",
		planner,
		executor,
		usage: [usage(1, 0.25), usage(2, 0.1)],
		actualCost: 0.35,
		estimate: { kind: "session-counterfactual", plannerOnlyCost: 0.5, savings: 0.15 },
		pricingEvidence: { source: "model-metadata", capturedAt: "2026-03-08T07:30:00.000Z" },
		...overrides,
	};
}

function checksum(contents: Buffer | string): string {
	return createHash("sha256").update(contents).digest("hex");
}

function delegationEvent(
	childIndex: number,
	childSessionId: string,
	evidenceKey: string,
	costUsd: number,
) {
	return {
		version: 2,
		eventId: `event-${childIndex}`,
		phase: "terminal",
		rootSessionId: "root",
		parentSessionId: "root",
		invocationId: "tool-call",
		delegationRunId: "delegation",
		childIndex,
		relationship: "direct",
		childSessionId,
		lifecycle: "completed",
		observedAt: childIndex + 1,
		usage: [
			{
				evidenceKey,
				category: "child",
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 2,
				turns: 1,
				costUsd,
				tokenCoverage: "complete",
			},
		],
	};
}

let root: string;
let agentDirectory: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "prewalk-analytics-store-"));
	agentDirectory = path.join(root, "agent");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("AnalyticsStore", () => {
	it("creates an extension-owned store with owner-only permissions", async () => {
		const store = new AnalyticsStore(agentDirectory);
		const manifest = await store.initialize();

		expect(resolveAnalyticsDirectory(agentDirectory)).toBe(
			path.join(agentDirectory, "prewalk", "analytics"),
		);
		expect(manifest.schemaVersion).toBe(ANALYTICS_SCHEMA_VERSION);
		expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
		expect((await stat(store.manifestPath)).mode & 0o777).toBe(0o600);
	});

	it("keeps concurrent runs in independent journals and reconciles both receipts", async () => {
		const storeA = new AnalyticsStore(agentDirectory);
		const storeB = new AnalyticsStore(agentDirectory);
		const generation = await storeA.currentGeneration();
		expect(await storeB.currentGeneration()).toBe(generation);

		await Promise.all([
			storeA.writeJournal(journal(generation, "run-a")),
			storeB.writeJournal(journal(generation, "run-b")),
		]);
		await Promise.all([
			storeA.promoteReceipt(receipt(generation, "run-a", { actualCost: 0.35 })),
			storeB.promoteReceipt(receipt(generation, "run-b", { actualCost: 0.35 })),
		]);

		const aggregate = await storeA.aggregate();
		expect(aggregate.receiptCount).toBe(2);
		expect(aggregate.actualCost).toBe(0.7);
		expect(aggregate.receipts.map((item) => item.runId).sort()).toEqual(["run-a", "run-b"]);
	});

	it("restores repeated journal writes and receipt promotion without duplication", async () => {
		const store = new AnalyticsStore(agentDirectory);
		const generation = await store.currentGeneration();
		const first = journal(generation);
		const updated = journal(generation, "run-1", {
			lastObservedSequence: 2,
			usage: [usage(1, 0.25), usage(2, 0.1)],
		});

		await store.writeJournal(first);
		await store.writeJournal(updated);
		expect(await store.restoreJournal("run-1", "epoch-1")).toEqual(updated);
		const terminal = receipt(generation);
		await store.promoteReceipt(terminal);
		await expect(store.promoteReceipt(terminal)).resolves.toEqual(terminal);
		expect(await store.restoreJournal("run-1", "epoch-1")).toBeNull();
		expect(await store.listReceipts()).toEqual([terminal]);
	});

	it("removes a stale matching journal when receipt promotion is retried", async () => {
		const store = new AnalyticsStore(agentDirectory);
		const generation = await store.currentGeneration();
		const terminal = receipt(generation);

		await store.promoteReceipt(terminal);
		await store.writeJournal(journal(generation));
		await store.promoteReceipt(terminal);

		expect(await store.restoreJournal("run-1", "epoch-1")).toBeNull();
	});

	it("never counts a journal after the matching receipt is visible", async () => {
		const store = new AnalyticsStore(agentDirectory);
		const generation = await store.currentGeneration();

		await store.promoteReceipt(receipt(generation));
		await store.writeJournal(journal(generation));

		const snapshot = await store.snapshot();
		const aggregate = await store.aggregate({}, snapshot);
		expect(snapshot.journals).toEqual([]);
		expect(aggregate.actualCost).toBe(0.35);
		expect(aggregate.outcomes.unfinished).toBe(0);
		expect(aggregate.unfinished).toEqual([]);
	});

	it("reconciles descendant receipts, fallback slices, and unresolved overlap once", async () => {
		const store = new AnalyticsStore(agentDirectory);
		const generation = await store.currentGeneration();
		await Promise.all([
			store.promoteReceipt(
				receipt(generation, "root-run", {
					sessionId: "root",
					usage: [usage(1, 0.5), usage(2, 0)],
					actualCost: 0.5,
					estimate: {
						kind: "session-counterfactual",
						plannerOnlyCost: 0.65,
						savings: 0.15,
					},
				}),
			),
			store.promoteReceipt(
				receipt(generation, "child-a-run", {
					sessionId: "child-a",
					usage: [usage(1, 0.2), usage(2, 0)],
					actualCost: 0.2,
					estimate: {
						kind: "session-counterfactual",
						plannerOnlyCost: 0.35,
						savings: 0.15,
					},
					evidenceKeys: ["usage-a"],
				}),
			),
			store.promoteReceipt(
				receipt(generation, "child-c-run", {
					sessionId: "child-c",
					usage: [usage(1, 0.4), usage(2, 0)],
					actualCost: 0.4,
					estimate: {
						kind: "session-counterfactual",
						plannerOnlyCost: 0.55,
						savings: 0.15,
					},
					evidenceKeys: [],
				}),
			),
		]);
		await Promise.all([
			store.writeDelegationEvidence(delegationEvent(0, "child-a", "usage-a", 0.2), generation),
			store.writeDelegationEvidence(delegationEvent(1, "child-b", "usage-b", 0.1), generation),
			store.writeDelegationEvidence(delegationEvent(2, "child-c", "usage-c", 0.3), generation),
		]);

		const report = await store.taskTree("root");

		expect(report.rootActualCost).toBe(0.5);
		expect(report.directChildActualCost).toBeCloseTo(0.7);
		expect(report.nestedChildActualCost).toBe(0);
		expect(report.knownTaskTreeActualCost).toBeCloseTo(1.2);
		expect(report.fallbackEvidence.map((item) => item.childSessionId)).toEqual(["child-b"]);
		expect(report.unresolved).toContainEqual({
			delegationRunId: "delegation",
			childIndex: 2,
			childSessionId: "child-c",
			reason: "overlap-unresolved",
		});
		expect(report.costCoverage).toBe("overlap-unresolved");
		expect(report.tokenCoverage).toBe("overlap-unresolved");
		expect(report.estimateCoverage).toBe("overlap-unresolved");
	});

	it("reconciles exact root, direct-child, and nested-child costs with separate token coverage", async () => {
		const store = new AnalyticsStore(agentDirectory);
		const generation = await store.currentGeneration();
		await store.promoteReceipt(
			receipt(generation, "root-run", {
				sessionId: "root",
				usage: [usage(1, 0.5), usage(2, 0)],
				actualCost: 0.5,
				estimate: {
					kind: "session-counterfactual",
					plannerOnlyCost: 0.65,
					savings: 0.15,
				},
			}),
		);
		const evidence = projectDelegationToolResult({
			rootSessionId: "root",
			parentSessionId: "root",
			invocationId: "tool-call",
			childCount: 2,
			details: {
				runId: "delegation",
				results: [
					{
						agent: "reviewer",
						exitCode: 0,
						usage: {
							input: 10,
							output: 5,
							cacheRead: 2,
							cacheWrite: 1,
							cost: 0.1,
							turns: 1,
						},
						children: [
							{
								id: "nested",
								state: "complete",
								totalTokens: { input: 4, output: 2, total: 6 },
								totalCost: { inputTokens: 4, outputTokens: 2, costUsd: 0.05 },
							},
						],
					},
					{
						agent: "tester",
						exitCode: 0,
						usage: {
							input: 20,
							output: 10,
							cacheRead: 4,
							cacheWrite: 2,
							cost: 0.2,
							turns: 2,
						},
					},
				],
			},
			isError: false,
			observedAt: 100,
		});
		for (const item of evidence) {
			const { schemaVersion, ...stored } = item;
			await store.writeDelegationEvidence({ ...stored, version: schemaVersion }, generation);
		}

		const report = await store.taskTree("root");

		expect(report.rootActualCost).toBe(0.5);
		expect(report.directChildActualCost).toBeCloseTo(0.3);
		expect(report.nestedChildActualCost).toBeCloseTo(0.05);
		expect(report.knownTaskTreeActualCost).toBeCloseTo(0.85);
		expect(report.reportedChildCount).toBe(3);
		expect(report.expectedChildCount).toBe(3);
		expect(report.costCoverage).toBe("complete");
		expect(report.tokenCoverage).toBe("incomplete");
		expect(report.unresolved).toContainEqual({
			delegationRunId: "nested",
			childIndex: 2,
			reason: "partial-token-breakdown",
		});

		const reopenedReport = await new AnalyticsStore(agentDirectory).taskTree("root");
		expect(reopenedReport).toEqual(report);
	});

	it("keeps missing child cost explicit without estimating the actual subtotal", async () => {
		const store = new AnalyticsStore(agentDirectory);
		const generation = await store.currentGeneration();
		const evidence = projectDelegationToolResult({
			rootSessionId: "root",
			parentSessionId: "root",
			invocationId: "tool-call",
			childCount: 1,
			details: {
				runId: "delegation",
				results: [
					{
						exitCode: 0,
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0.1,
							turns: 1,
						},
						children: [{ id: "nested", state: "complete" }],
					},
				],
			},
			isError: false,
			observedAt: 100,
		});
		for (const item of evidence) {
			const { schemaVersion, ...stored } = item;
			await store.writeDelegationEvidence({ ...stored, version: schemaVersion }, generation);
		}

		const report = await store.taskTree("root");

		expect(report.directChildActualCost).toBe(0.1);
		expect(report.nestedChildActualCost).toBe(0);
		expect(report.knownTaskTreeActualCost).toBe(0.1);
		expect(report.costCoverage).toBe("incomplete");
		expect(report.tokenCoverage).toBe("incomplete");
		expect(report.unresolved).toContainEqual({
			delegationRunId: "nested",
			childIndex: 1,
			reason: "missing-cost",
		});
	});

	it("rejects delegation evidence captured before a ledger reset", async () => {
		const store = new AnalyticsStore(agentDirectory);
		const priorGeneration = await store.currentGeneration();
		await store.reset();

		await expect(
			store.writeDelegationEvidence(delegationEvent(0, "child", "usage", 0.1), priorGeneration),
		).rejects.toThrow("prior ledger generation");
		expect(await store.listDelegationEvidence()).toEqual([]);
	});

	it("preserves the last valid journal when atomic replacement fails", async () => {
		let fail = false;
		const store = new AnalyticsStore(agentDirectory, {
			beforeAtomicReplace: () => {
				if (fail) throw new Error("simulated interruption");
			},
		});
		const generation = await store.currentGeneration();
		const original = journal(generation);
		await store.writeJournal(original);
		fail = true;

		await expect(
			store.writeJournal(journal(generation, "run-1", { lastObservedSequence: 2 })),
		).rejects.toThrow("simulated interruption");
		expect(await store.restoreJournal("run-1", "epoch-1")).toEqual(original);
	});

	it("persists validated benchmark summaries separately and removes them on reset", async () => {
		const store = new AnalyticsStore(agentDirectory);
		const summary: VerifiedBenchmarkSummary = {
			schemaVersion: 1,
			benchmarkContractVersion: "benchmark-report-v2",
			evidenceFingerprint: "a".repeat(64),
			completedAt: "2026-03-08T07:30:00.000Z",
			runCounts: { solOnly: 20, lunaOnly: 20, prewalk: 20 },
			comparisons: {
				solOnlyCost: 1,
				lunaOnlyCost: 1,
				prewalkCost: 0.5,
				prewalkVsSolSavings: 0.5,
				prewalkVsLunaSavings: 0.5,
			},
		};
		await store.writeVerifiedBenchmarkSummary(summary);
		expect(await store.readVerifiedBenchmarkSummary()).toEqual(summary);
		await store.reset();
		expect(await store.readVerifiedBenchmarkSummary()).toBeNull();
	});

	it("rotates generations and refuses writes from a run active before reset", async () => {
		const store = new AnalyticsStore(agentDirectory);
		const oldGeneration = await store.currentGeneration();
		await store.writeJournal(journal(oldGeneration, "old-run"));

		const { generation: newGeneration } = await store.reset();
		expect(newGeneration).not.toBe(oldGeneration);
		expect((await store.aggregate()).receiptCount).toBe(0);
		expect((await store.aggregate()).unfinished).toEqual([]);
		await expect(
			stat(path.join(store.directory, oldGeneration, "journals", "old-run--epoch-1.json")),
		).rejects.toThrow(/ENOENT/);
		await expect(store.writeJournal(journal(oldGeneration, "old-run"))).rejects.toThrow(
			"prior ledger generation",
		);
		await expect(store.promoteReceipt(receipt(oldGeneration, "old-run"))).rejects.toThrow(
			"prior ledger generation",
		);

		await store.writeJournal(journal(newGeneration, "new-run"));
		await store.promoteReceipt(receipt(newGeneration, "new-run"));
		expect((await store.aggregate()).receiptCount).toBe(1);
	});

	it("keeps failed retired-generation cleanup retryable without rotating the new ledger", async () => {
		let failCleanup = true;
		const store = new AnalyticsStore(agentDirectory, {
			beforeRetiredGenerationRemove: () => {
				if (failCleanup) throw new Error("simulated cleanup failure");
			},
		});
		const oldGeneration = await store.currentGeneration();
		await store.writeJournal(journal(oldGeneration, "old-run"));

		const reset = await store.reset();

		expect(reset.cleanupComplete).toBe(false);
		expect(reset.remainingRetiredGenerations).toEqual([oldGeneration]);
		expect((await store.aggregate()).generation).toBe(reset.generation);
		expect((await store.aggregate()).unfinished).toEqual([]);
		expect(
			await stat(path.join(store.directory, oldGeneration, "journals", "old-run--epoch-1.json")),
		).toBeDefined();

		failCleanup = false;
		const cleanup = await store.retryRetiredGenerationCleanup();

		expect(cleanup).toEqual({
			cleanupComplete: true,
			remainingRetiredGenerations: [],
		});
		expect((await store.aggregate()).generation).toBe(reset.generation);
		await expect(stat(path.join(store.directory, oldGeneration))).rejects.toThrow(/ENOENT/);
	});

	it("does not retain a paused old-generation write after reset", async () => {
		let release: (() => void) | undefined;
		const paused = new Promise<void>((resolve) => {
			release = resolve;
		});
		const store = new AnalyticsStore(agentDirectory, {
			beforeLedgerPublish: async (kind, generation) => {
				if (kind === "journal") await paused;
				if (generation.length === 0) throw new Error("unreachable");
			},
		});
		const oldGeneration = await store.currentGeneration();
		const write = store.writeJournal(journal(oldGeneration));
		await new Promise((resolve) => setImmediate(resolve));
		const { generation: newGeneration } = await store.reset();
		release?.();
		await expect(write).rejects.toThrow("prior ledger generation");
		await expect(stat(path.join(store.directory, oldGeneration))).rejects.toThrow(/ENOENT/);
		expect((await store.aggregate()).generation).toBe(newGeneration);
	});

	it("reports unfinished observed spend without estimating savings", async () => {
		const store = new AnalyticsStore(agentDirectory);
		const generation = await store.currentGeneration();
		await store.writeJournal(journal(generation));

		const aggregate = await store.aggregate();
		expect(aggregate.actualCost).toBe(0.25);
		expect(aggregate.outcomes.unfinished).toBe(1);
		expect(aggregate.estimatedSavings).toBe(0);
		expect((await store.aggregate({ outcomes: ["succeeded"] })).actualCost).toBe(0);
		expect(aggregate.unfinished).toEqual([
			{
				runId: "run-1",
				epoch: "epoch-1",
				sessionId: "session-1",
				startedAt: "2026-03-08T06:30:00.000Z",
				outcome: "unfinished",
				actualCost: 0.25,
			},
		]);
	});

	it("keeps legacy planning-only receipts out of handoff comparisons", async () => {
		const store = new AnalyticsStore(agentDirectory);
		const generation = await store.currentGeneration();
		await store.promoteReceipt(
			receipt(generation, "planning-only", {
				handoffState: "not-started",
				usage: [usage(1, 0.25)],
				actualCost: 0.25,
				estimate: { kind: "unavailable", reason: "usage-incomplete" },
				pricingEvidence: { source: "unavailable", reason: "usage-incomplete" },
			}),
		);

		const aggregate = await store.aggregate();
		expect(aggregate.unavailableSavingsCount).toBe(0);
		expect(aggregate.estimatedSavings).toBe(0);
		expect(aggregate.estimatedExtraCost).toBe(0);
		expect(aggregate.comparison.comparedRuns).toBe(0);
		expect(aggregate.comparison.noHandoffRuns).toBe(1);
	});

	it("keeps active journals local to one exact Pi session", async () => {
		const store = new AnalyticsStore(agentDirectory);
		const generation = await store.currentGeneration();
		await store.writeJournal(journal(generation, "root-active", { sessionId: "root" }));
		await store.writeJournal(
			journal(generation, "child-active", { epoch: "child-epoch", sessionId: "child" }),
		);

		const session = await store.aggregate({ sessionId: "root" });

		expect(session.actualCost).toBe(0.25);
		expect(session.unfinished.map((run) => run.runId)).toEqual(["root-active"]);
	});

	it("aggregates by outcome, session, recent limit, local week, and DST-aware month", async () => {
		const store = new AnalyticsStore(agentDirectory);
		const generation = await store.currentGeneration();
		const outcomes: RunOutcome[] = ["succeeded", "failed", "cancelled"];
		const completed = [
			"2026-03-01T04:30:00.000Z",
			"2026-03-08T07:30:00.000Z",
			"2026-03-09T04:30:00.000Z",
		];
		for (let index = 0; index < completed.length; index += 1) {
			const unavailableReason =
				outcomes[index] === "succeeded" ? "pricing-missing" : "run-not-successful";
			await store.promoteReceipt(
				receipt(generation, `run-${index}`, {
					epoch: `epoch-${index}`,
					sessionId: index === 2 ? "other-session" : "session-1",
					completedAt: completed[index],
					outcome: outcomes[index],
					actualCost: 0.35,
					estimate: { kind: "unavailable", reason: unavailableReason },
					pricingEvidence: { source: "unavailable", reason: unavailableReason },
				}),
			);
		}

		const month = await store.aggregate({
			window: "month",
			now: new Date("2026-03-15T12:00:00.000Z"),
			timeZone: "America/New_York",
			recentLimit: 1,
		});
		expect(month.receipts.map((item) => item.runId)).toEqual(["run-2", "run-1"]);
		expect(month.actualCost).toBe(0.7);
		expect(month.estimatedExtraCost).toBe(0);
		expect(month.recentReceipts).toHaveLength(1);

		const weekAndSession = await store.aggregate({
			window: "week",
			now: new Date("2026-03-08T16:00:00.000Z"),
			timeZone: "America/New_York",
			sessionId: "session-1",
			outcomes: ["failed"],
		});
		expect(weekAndSession.receipts.map((item) => item.runId)).toEqual(["run-1"]);
	});

	it("counts child receipts once in lifetime and task-tree totals when a parent summary overlaps", async () => {
		const store = new AnalyticsStore(agentDirectory);
		const generation = await store.currentGeneration();
		await store.promoteReceipt(
			receipt(generation, "root-run", {
				sessionId: "root",
				actualCost: 0.5,
				usage: [usage(1, 0.5), usage(2, 0)],
				estimate: {
					kind: "session-counterfactual",
					plannerOnlyCost: 0.65,
					savings: 0.15,
				},
			}),
		);
		await store.promoteReceipt(
			receipt(generation, "child-run", {
				sessionId: "child",
				actualCost: 0.2,
				usage: [usage(1, 0.2), usage(2, 0)],
				evidenceKeys: ["subagent:delegation:0"],
				estimate: {
					kind: "session-counterfactual",
					plannerOnlyCost: 0.35,
					savings: 0.15,
				},
			}),
		);
		await store.writeDelegationEvidence(
			delegationEvent(0, "child", "subagent:delegation:0", 0.2),
			generation,
		);

		const lifetime = await store.aggregate();
		const session = await store.aggregate({ sessionId: "root" });
		const taskTree = await store.taskTree("root");

		expect(lifetime.actualCost).toBeCloseTo(0.7);
		expect(session.actualCost).toBeCloseTo(0.5);
		expect(session.receipts.map((item) => item.runId)).toEqual(["root-run"]);
		expect(taskTree.rootActualCost).toBe(0.5);
		expect(taskTree.directChildActualCost).toBe(0.2);
		expect(taskTree.knownTaskTreeActualCost).toBeCloseTo(0.7);
		expect(taskTree.fallbackEvidence).toEqual([]);
		expect(taskTree.costCoverage).toBe("complete");
	});

	it("keeps child-only delegation evidence out of exact-session spend", async () => {
		const store = new AnalyticsStore(agentDirectory);
		const generation = await store.currentGeneration();
		await store.promoteReceipt(
			receipt(generation, "root-run", {
				sessionId: "root",
				actualCost: 0.5,
				usage: [usage(1, 0.5), usage(2, 0)],
				estimate: {
					kind: "session-counterfactual",
					plannerOnlyCost: 0.65,
					savings: 0.15,
				},
			}),
		);
		await store.writeDelegationEvidence(
			delegationEvent(0, "child-without-prewalk", "subagent:child-only:0", 0.2),
			generation,
		);

		const lifetime = await store.aggregate();
		const session = await store.aggregate({ sessionId: "root" });
		const taskTree = await store.taskTree("root");

		expect(lifetime.actualCost).toBeCloseTo(0.7);
		expect(session.actualCost).toBeCloseTo(0.5);
		expect(session.receipts.map((item) => item.runId)).toEqual(["root-run"]);
		expect(taskTree.knownTaskTreeActualCost).toBeCloseTo(0.7);
	});

	it("uses a linked child receipt when the parent summary has no cost", async () => {
		const store = new AnalyticsStore(agentDirectory);
		const generation = await store.currentGeneration();
		await store.promoteReceipt(
			receipt(generation, "child-run", {
				sessionId: "child",
				actualCost: 0.2,
				usage: [usage(1, 0.2), usage(2, 0)],
				estimate: {
					kind: "session-counterfactual",
					plannerOnlyCost: 0.35,
					savings: 0.15,
				},
			}),
		);
		await store.writeDelegationEvidence(
			{ ...delegationEvent(0, "child", "unused", 0.2), usage: [] },
			generation,
		);

		const taskTree = await store.taskTree("root");

		expect(taskTree.directChildActualCost).toBe(0.2);
		expect(taskTree.reportedChildCount).toBe(1);
		expect(taskTree.expectedChildCount).toBe(1);
		expect(taskTree.costCoverage).toBe("complete");
		expect(taskTree.tokenCoverage).toBe("complete");
		expect(taskTree.unresolved).toEqual([]);
	});

	it("does not publish an incomplete export when publication is interrupted", async () => {
		const store = new AnalyticsStore(agentDirectory, {
			beforeExportPublish: () => {
				throw new Error("simulated export interruption");
			},
		});
		const generation = await store.currentGeneration();
		await store.promoteReceipt(receipt(generation));
		const destination = path.join(root, "interrupted.jsonl");
		await expect(store.exportJsonLines(destination)).rejects.toThrow(
			"simulated export interruption",
		);
		await expect(stat(destination)).rejects.toThrow(/ENOENT/);
		const leftovers = (await readdir(root)).filter(
			(name) => name.includes("interrupted.jsonl.") && name.endsWith(".tmp"),
		);
		expect(leftovers).toEqual([]);
	});

	it("exports validated receipts as JSONL without prohibited content", async () => {
		const store = new AnalyticsStore(agentDirectory);
		const generation = await store.currentGeneration();
		await store.promoteReceipt(receipt(generation, "run-b", { epoch: "epoch-b" }));
		await store.promoteReceipt(
			receipt(generation, "run-a", {
				epoch: "epoch-a",
				completedAt: "2026-03-08T06:00:00.000Z",
			}),
		);
		await store.writeDelegationEvidence(
			delegationEvent(0, "child", "subagent:run:0", 0.1),
			generation,
		);
		const destination = path.join(root, "analytics.jsonl");

		expect(await store.exportJsonLines(destination)).toBe(3);
		const lines = (await readFile(destination, "utf8")).trim().split("\n");
		expect(lines.map((line) => JSON.parse(line).runId)).toEqual(["run-a", "run-b", undefined]);
		expect(JSON.parse(lines[2] ?? "{}")).toMatchObject({
			schemaVersion: 2,
			relationship: "direct",
			delegationRunId: "delegation",
		});
		expect(lines.join("\n")).not.toMatch(/prompt|assistantText|toolInput|rawError|\/Users\//);
		expect((await stat(destination)).mode & 0o777).toBe(0o600);
	});

	it("refuses an existing export destination and leaves its bytes unchanged", async () => {
		const store = new AnalyticsStore(agentDirectory);
		const generation = await store.currentGeneration();
		await store.promoteReceipt(receipt(generation));
		const destination = path.join(root, "keep.jsonl");
		const original = Buffer.from("do-not-change\n\u0000binary-tail");
		await writeFile(destination, original);
		const before = checksum(await readFile(destination));
		expect(before).toBe("09ff3c4a29a9cfbe52d2851d70f3e894523297e971159dc3d257757252d2f275");

		await expect(store.exportJsonLines(destination)).rejects.toThrow(
			/exists; choose a new filename: keep\.jsonl/,
		);
		const afterContents = await readFile(destination);
		expect(checksum(afterContents)).toBe(before);
		expect(afterContents).toEqual(original);
	});

	it("surfaces corrupted and unsupported receipts with safe identifiers", async () => {
		const store = new AnalyticsStore(agentDirectory);
		const generation = await store.currentGeneration();
		await store.promoteReceipt(receipt(generation));
		const storedPath = path.join(store.directory, generation, "receipts", "run-1--epoch-1.json");
		await writeFile(storedPath, '{"schemaVersion":2}\n', { mode: 0o600 });

		await expect(store.aggregate()).rejects.toThrow(
			/Analytics receipt run-1--epoch-1 is invalid:.*schemaVersion 2 is unsupported/,
		);
		await writeFile(storedPath, "not-json\n", { mode: 0o600 });
		await expect(store.listReceipts()).rejects.toThrow(
			"Analytics receipt run-1--epoch-1 is invalid",
		);
	});
});

describe("recovered receipt supersession", () => {
	it("lets the owning session reclaim a run that recovery finalized while it was idle", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "prewalk-supersede-"));
		const store = new AnalyticsStore(directory);
		const generation = await store.currentGeneration();
		const base = {
			schemaVersion: ANALYTICS_SCHEMA_VERSION,
			runId: "run-supersede",
			epoch: "epoch-1",
			sessionId: "session-1",
			generation,
			startedAt: "2026-08-01T00:00:00.000Z",
			completedAt: "2026-08-01T00:05:00.000Z",
			handoffState: "not-started" as const,
			planner: { provider: "openai-codex", model: "gpt-5.6-sol" },
			executor: { provider: "openai-codex", model: "gpt-5.6-luna" },
			estimate: { kind: "unavailable" as const, reason: "pricing-missing" as const },
			pricingEvidence: { source: "unavailable" as const, reason: "pricing-missing" as const },
		};
		const recovered = {
			...base,
			outcome: "interrupted" as const,
			usage: [usage(1, 0.5)],
			actualCost: summarizeActualCost([usage(1, 0.5)]).total,
			evidenceKeys: ["evidence-1"],
		};
		await store.promoteReceipt(recovered);

		const owned = {
			...base,
			outcome: "succeeded" as const,
			usage: [usage(1, 0.5), usage(2, 0.25)],
			actualCost: summarizeActualCost([usage(1, 0.5), usage(2, 0.25)]).total,
			evidenceKeys: ["evidence-1", "evidence-2"],
		};
		await expect(store.promoteReceipt(owned)).rejects.toThrow(
			/already exists with different data/,
		);
		expect(await store.supersedeRecoveredReceipt(owned)).not.toBeNull();
		expect((await store.listReceipts())[0]?.evidenceKeys).toEqual(["evidence-1", "evidence-2"]);

		// A receipt that is not a strict superset never overwrites the stored one.
		expect(await store.supersedeRecoveredReceipt(recovered)).toBeNull();
		expect((await store.listReceipts())[0]?.evidenceKeys).toEqual(["evidence-1", "evidence-2"]);
		await rm(directory, { recursive: true, force: true });
	});
});

describe("finalized run journals", () => {
	it("does not keep a journal written after its receipt exists", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "prewalk-finalized-"));
		const store = new AnalyticsStore(directory);
		const generation = await store.currentGeneration();
		const open = journal(generation, "run-final");
		await store.writeJournal(open);
		expect(await store.listUnfinishedJournals()).toHaveLength(1);

		await store.promoteReceipt({
			schemaVersion: ANALYTICS_SCHEMA_VERSION,
			runId: open.runId,
			epoch: open.epoch,
			sessionId: open.sessionId,
			generation,
			startedAt: open.startedAt,
			completedAt: "2026-08-01T00:05:00.000Z",
			outcome: "succeeded",
			handoffState: open.handoffState,
			planner: open.configuration.planner,
			executor: open.configuration.executor,
			usage: open.usage,
			actualCost: summarizeActualCost(open.usage).total,
			estimate: { kind: "unavailable", reason: "pricing-missing" },
			pricingEvidence: { source: "unavailable", reason: "pricing-missing" },
			evidenceKeys: [...(open.evidenceKeys ?? [])],
		});
		expect(await store.listUnfinishedJournals()).toEqual([]);

		// A late write for a finalized run must not resurrect the journal, which
		// is how a journal outlives its receipt and accrues uncounted spend.
		await store.writeJournal(open);
		expect(await store.listUnfinishedJournals()).toEqual([]);
		expect(await store.restoreJournal(open.runId, open.epoch)).toBeNull();
		await rm(directory, { recursive: true, force: true });
	});
});
