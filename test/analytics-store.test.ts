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
	type UsageSlice,
	type VerifiedBenchmarkSummary,
} from "../src/analytics.js";
import { AnalyticsStore, resolveAnalyticsDirectory } from "../src/analytics-store.js";

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
		version: 1,
		eventId: `event-${childIndex}`,
		phase: "terminal",
		rootSessionId: "root",
		parentSessionId: "root",
		invocationId: "tool-call",
		delegationRunId: "delegation",
		childIndex,
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

	it("reconciles descendant receipts, fallback slices, and unresolved overlap once", async () => {
		const store = new AnalyticsStore(agentDirectory);
		const generation = await store.currentGeneration();
		await Promise.all([
			store.promoteReceipt(
				receipt(generation, "root-run", {
					sessionId: "root",
					usage: [usage(1, 0.5)],
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
					usage: [usage(1, 0.2)],
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
					usage: [usage(1, 0.4)],
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
			store.writeDelegationEvidence(delegationEvent(0, "child-a", "usage-a", 0.2)),
			store.writeDelegationEvidence(delegationEvent(1, "child-b", "usage-b", 0.1)),
			store.writeDelegationEvidence(delegationEvent(2, "child-c", "usage-c", 0.3)),
		]);

		const report = await store.taskTree("root");

		expect(report.rootActualCost).toBe(0.5);
		expect(report.descendantActualCost).toBeCloseTo(0.7);
		expect(report.totalActualCost).toBeCloseTo(1.2);
		expect(report.fallbackEvidence.map((item) => item.childSessionId)).toEqual(["child-b"]);
		expect(report.unresolved).toContainEqual({
			delegationRunId: "delegation",
			childIndex: 2,
			childSessionId: "child-c",
			reason: "overlap-unresolved",
		});
		expect(report.actualCoverage).toBe("overlap-unresolved");
		expect(report.estimateCoverage).toBe("overlap-unresolved");
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

		const newGeneration = await store.reset();
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
		const newGeneration = await store.reset();
		release?.();
		await expect(write).rejects.toThrow("prior ledger generation");
		await expect(stat(path.join(store.directory, oldGeneration))).rejects.toThrow(/ENOENT/);
		expect((await store.aggregate()).generation).toBe(newGeneration);
	});

	it("reports unfinished observed actual spend without estimating savings", async () => {
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
			await store.promoteReceipt(
				receipt(generation, `run-${index}`, {
					epoch: `epoch-${index}`,
					sessionId: index === 2 ? "other-session" : "session-1",
					completedAt: completed[index],
					outcome: outcomes[index],
					actualCost: 0.35,
					estimate: { kind: "unavailable", reason: "run-not-successful" },
					pricingEvidence: { source: "unavailable", reason: "run-not-successful" },
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
		const destination = path.join(root, "analytics.jsonl");

		expect(await store.exportJsonLines(destination)).toBe(2);
		const lines = (await readFile(destination, "utf8")).trim().split("\n");
		expect(lines.map((line) => JSON.parse(line).runId)).toEqual(["run-a", "run-b"]);
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
