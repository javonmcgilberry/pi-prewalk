import { randomUUID } from "node:crypto";
import {
	chmod,
	link,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
	ANALYTICS_SCHEMA_VERSION,
	comparisonEstimate,
	type DelegationEvidence,
	deserializeRunJournal,
	deserializeRunReceipt,
	parseRunJournal,
	parseRunReceipt,
	parseVerifiedBenchmarkSummary,
	type RunJournal,
	type RunOutcome,
	type RunReceipt,
	serializeRunJournal,
	serializeRunReceipt,
	summarizeActualCost,
	type TaskTreeReport,
	type TaskTreeUnresolvedDescendant,
	type VerifiedBenchmarkSummary,
} from "./analytics.js";
import { delegationEvidenceKey, parseDelegationAnalyticsEvent } from "./analytics-subagents.js";
import { isRecord } from "./guards.js";

const STORE_DIRECTORY = "prewalk/analytics";
const MANIFEST_FILE = "manifest.json";
const JOURNALS_DIRECTORY = "journals";
const RECEIPTS_DIRECTORY = "receipts";
const DELEGATION_DIRECTORY = "delegation";
const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;

export interface AnalyticsManifest {
	schemaVersion: number;
	generation: string;
	retiredGenerations?: string[];
}

export type AnalyticsWindow = "lifetime" | "week" | "month";

export interface AnalyticsQuery {
	window?: AnalyticsWindow;
	now?: Date;
	timeZone?: string;
	outcomes?: readonly RunOutcome[];
	/** Match one exact Pi session. Descendant sessions belong to taskTree(). */
	sessionId?: string;
	recentLimit?: number;
}

export interface UnfinishedRunSummary {
	runId: string;
	epoch: string;
	sessionId: string;
	startedAt: string;
	outcome: "unfinished";
	actualCost: number;
}

export interface AnalyticsAggregate {
	generation: string;
	receiptCount: number;
	actualCost: number;
	estimatedSavings: number;
	estimatedExtraCost: number;
	unavailableSavingsCount: number;
	outcomes: Record<RunOutcome, number>;
	receipts: RunReceipt[];
	recentReceipts: RunReceipt[];
	unfinished: UnfinishedRunSummary[];
}

export interface AnalyticsSnapshot {
	generation: string;
	receipts: RunReceipt[];
	journals: RunJournal[];
	delegationEvidence?: DelegationEvidence[];
}

export interface AnalyticsStoreHooks {
	beforeAtomicReplace?: (target: string) => void | Promise<void>;
	beforeLedgerPublish?: (
		kind: "journal" | "receipt",
		generation: string,
		target: string,
	) => void | Promise<void>;
	afterManifestRotate?: (previousGeneration: string, generation: string) => void | Promise<void>;
	beforeSnapshotValidation?: (generation: string) => void | Promise<void>;
	beforeExportPublish?: (destination: string) => void | Promise<void>;
	beforeRetiredGenerationRemove?: (generation: string) => void | Promise<void>;
}

export interface RetiredGenerationCleanup {
	cleanupComplete: boolean;
	remainingRetiredGenerations: string[];
}

export interface AnalyticsResetResult extends RetiredGenerationCleanup {
	generation: string;
}

export function resolveAnalyticsDirectory(agentDirectory: string): string {
	return path.join(agentDirectory, STORE_DIRECTORY);
}

export class AnalyticsStore {
	readonly directory: string;
	readonly manifestPath: string;

	constructor(
		agentDirectory: string,
		private readonly hooks: AnalyticsStoreHooks = {},
	) {
		this.directory = resolveAnalyticsDirectory(agentDirectory);
		this.manifestPath = path.join(this.directory, MANIFEST_FILE);
	}

	async initialize(): Promise<AnalyticsManifest> {
		await this.ensureDirectories();
		let manifest: AnalyticsManifest;
		try {
			manifest = await this.readManifest();
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) throw error;
			manifest = {
				schemaVersion: ANALYTICS_SCHEMA_VERSION,
				generation: randomUUID(),
			};
			try {
				await writeExclusive(this.manifestPath, `${JSON.stringify(manifest)}\n`);
			} catch (writeError) {
				if (!hasErrorCode(writeError, "EEXIST")) throw writeError;
				manifest = await this.readManifest();
			}
		}
		return manifest;
	}

	async currentGeneration(): Promise<string> {
		return (await this.initialize()).generation;
	}

	async readVerifiedBenchmarkSummary(): Promise<VerifiedBenchmarkSummary | null> {
		const manifest = await this.initialize();
		try {
			return parseVerifiedBenchmarkSummary(
				JSON.parse(
					(await readFile(this.benchmarkSummaryPath(manifest.generation), "utf8")).trim(),
				),
			);
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return null;
			throw error;
		}
	}

	async writeVerifiedBenchmarkSummary(value: VerifiedBenchmarkSummary): Promise<void> {
		const summary = parseVerifiedBenchmarkSummary(value);
		const generation = await this.currentGeneration();
		await this.atomicReplace(
			this.benchmarkSummaryPath(generation),
			`${JSON.stringify(summary)}\n`,
		);
	}

	async writeJournal(value: RunJournal): Promise<void> {
		const journal = parseRunJournal(value);
		await this.requireCurrentGeneration(journal.generation);
		const target = this.journalPath(journal.generation, journal.runId, journal.epoch);
		await this.hooks.beforeLedgerPublish?.("journal", journal.generation, target);
		await this.requireCurrentGeneration(journal.generation);
		await this.atomicReplace(target, `${serializeRunJournal(journal)}\n`);
	}

	async restoreJournal(runId: string, epoch: string): Promise<RunJournal | null> {
		const manifest = await this.initialize();
		let stored: string;
		try {
			stored = await readFile(this.journalPath(manifest.generation, runId, epoch), "utf8");
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return null;
			throw error;
		}
		const journal = parseStoredJournal(stored, ledgerEntryIdentifier(runId, epoch));
		return journal.generation === manifest.generation ? journal : null;
	}

	async promoteReceipt(value: RunReceipt): Promise<RunReceipt> {
		const receipt = parseRunReceipt(value);
		await this.requireCurrentGeneration(receipt.generation);
		const target = this.receiptPath(receipt.generation, receipt.runId, receipt.epoch);
		await this.hooks.beforeLedgerPublish?.("receipt", receipt.generation, target);
		await this.requireCurrentGeneration(receipt.generation);
		try {
			await writeExclusive(target, `${serializeRunReceipt(receipt)}\n`);
		} catch (error) {
			if (!hasErrorCode(error, "EEXIST")) throw error;
			const existing = parseStoredReceipt(
				await readFile(target, "utf8"),
				ledgerEntryIdentifier(receipt.runId, receipt.epoch),
			);
			if (serializeRunReceipt(existing) !== serializeRunReceipt(receipt)) {
				throw new Error(
					`Analytics receipt ${ledgerEntryIdentifier(receipt.runId, receipt.epoch)} already exists with different data.`,
				);
			}
			await this.requireCurrentGeneration(receipt.generation);
			return existing;
		}
		await unlink(this.journalPath(receipt.generation, receipt.runId, receipt.epoch)).catch(
			ignoreMissingFile,
		);
		return receipt;
	}

	async listReceipts(): Promise<RunReceipt[]> {
		const manifest = await this.initialize();
		const receiptsDirectory = this.receiptsDirectoryFor(manifest.generation);
		const names = (await readdir(receiptsDirectory)).filter((name) => name.endsWith(".json"));
		const receipts: RunReceipt[] = [];
		for (const name of names.sort()) {
			const identifier = name.slice(0, -".json".length);
			const receipt = parseStoredReceipt(
				await readFile(path.join(receiptsDirectory, name), "utf8"),
				identifier,
			);
			if (receipt.generation === manifest.generation) receipts.push(receipt);
		}
		return receipts;
	}

	async writeDelegationEvidence(value: unknown, generation: string): Promise<DelegationEvidence> {
		const parsed = parseDelegationAnalyticsEvent(value);
		await this.requireCurrentGeneration(generation);
		const evidence: DelegationEvidence = { ...parsed, generation };
		const target = this.delegationPath(generation, delegationEvidenceKey(evidence));
		try {
			const stored = JSON.parse(await readFile(target, "utf8"));
			const { generation: _generation, schemaVersion, ...event } = stored;
			const existing = parseDelegationAnalyticsEvent({
				...event,
				version: event.version ?? schemaVersion,
			});
			if (
				existing.phase === "terminal" ||
				(existing.phase === evidence.phase && existing.eventId === evidence.eventId)
			) {
				return { ...existing, generation };
			}
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) throw error;
		}
		await this.withDelegationLock(async () => {
			await this.requireCurrentGeneration(generation);
			try {
				const stored = JSON.parse(await readFile(target, "utf8"));
				const { generation: _generation, schemaVersion, ...event } = stored;
				const existing = parseDelegationAnalyticsEvent({
					...event,
					version: event.version ?? schemaVersion,
				});
				if (existing.phase === "terminal" || existing.observedAt > evidence.observedAt) return;
			} catch (error) {
				if (!hasErrorCode(error, "ENOENT")) throw error;
			}
			await this.requireCurrentGeneration(generation);
			await this.atomicReplace(target, `${JSON.stringify(evidence)}\n`);
		});
		return evidence;
	}

	async listDelegationEvidence(): Promise<DelegationEvidence[]> {
		const manifest = await this.initialize();
		const directory = this.delegationDirectoryFor(manifest.generation);
		const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
		return Promise.all(
			names.map(async (name) => {
				const stored = JSON.parse(await readFile(path.join(directory, name), "utf8"));
				const { generation: _generation, schemaVersion, ...event } = stored;
				const parsed = parseDelegationAnalyticsEvent({
					...event,
					version: event.version ?? schemaVersion,
				});
				return { ...parsed, generation: manifest.generation };
			}),
		);
	}

	async taskTree(rootSessionId: string): Promise<TaskTreeReport> {
		const allReceipts = await this.listReceipts();
		const rootReceipts = allReceipts.filter((receipt) => receipt.sessionId === rootSessionId);
		const evidence = (await this.listDelegationEvidence()).filter(
			(item) => item.rootSessionId === rootSessionId,
		);
		const descendantReceipts = evidence
			.filter((item) => item.childSessionId !== undefined)
			.flatMap((item) =>
				allReceipts.some((receipt) => receipt.sessionId === item.childSessionId)
					? allReceipts.filter((receipt) => receipt.sessionId === item.childSessionId)
					: [],
			);
		const uniqueDescendants = [
			...new Map(
				descendantReceipts.map((receipt) => [`${receipt.runId}:${receipt.epoch}`, receipt]),
			).values(),
		];
		const receiptRelationships = new Map<string, DelegationEvidence["relationship"]>();
		for (const item of evidence) {
			if (item.childSessionId !== undefined) {
				receiptRelationships.set(item.childSessionId, item.relationship);
			}
		}
		const receiptEvidenceKeys = new Set(
			uniqueDescendants.flatMap((receipt) => receipt.evidenceKeys ?? []),
		);
		const fallbackEvidence: DelegationEvidence[] = [];
		const unresolved: TaskTreeUnresolvedDescendant[] = [];
		for (const item of evidence) {
			const unresolvedEntry = (
				reason: TaskTreeUnresolvedDescendant["reason"],
			): TaskTreeUnresolvedDescendant => ({
				delegationRunId: item.delegationRunId,
				childIndex: item.childIndex,
				...(item.childSessionId === undefined ? {} : { childSessionId: item.childSessionId }),
				reason,
			});
			if (item.phase !== "terminal") {
				unresolved.push(unresolvedEntry("pending"));
				continue;
			}
			const childHasReceipt = uniqueDescendants.some(
				(receipt) => receipt.sessionId === item.childSessionId,
			);
			if (item.usage.length === 0) {
				if (!childHasReceipt) unresolved.push(unresolvedEntry("missing-cost"));
				continue;
			}
			const unmatched = item.usage.filter(
				(slice) => !receiptEvidenceKeys.has(slice.evidenceKey),
			);
			if (unmatched.length === 0) continue;
			if (childHasReceipt && unmatched.length === item.usage.length) {
				unresolved.push(unresolvedEntry("overlap-unresolved"));
				continue;
			}
			const fallback = { ...item, usage: unmatched };
			fallbackEvidence.push(fallback);
			if (unmatched.some((slice) => slice.tokenCoverage === "partial")) {
				unresolved.push(unresolvedEntry("partial-token-breakdown"));
			}
		}
		const rootActualCost = rootReceipts.reduce((sum, receipt) => sum + receipt.actualCost, 0);
		const receiptActualCost = (relationship: DelegationEvidence["relationship"]): number =>
			uniqueDescendants
				.filter((receipt) => receiptRelationships.get(receipt.sessionId) === relationship)
				.reduce((sum, receipt) => sum + receipt.actualCost, 0);
		const fallbackActualCost = (relationship: DelegationEvidence["relationship"]): number =>
			fallbackEvidence
				.filter((item) => item.relationship === relationship)
				.reduce(
					(sum, item) =>
						sum + item.usage.reduce((usageSum, slice) => usageSum + slice.costUsd, 0),
					0,
				);
		const directChildActualCost = receiptActualCost("direct") + fallbackActualCost("direct");
		const nestedChildActualCost = receiptActualCost("nested") + fallbackActualCost("nested");
		const estimateReceipts = [...rootReceipts, ...uniqueDescendants];
		const estimatedSavings = estimateReceipts.reduce((sum, receipt) => {
			const estimate = comparisonEstimate(receipt);
			return sum + (estimate.kind === "unavailable" ? 0 : Math.max(0, estimate.savings));
		}, 0);
		const estimatedExtraCost = estimateReceipts.reduce((sum, receipt) => {
			const estimate = comparisonEstimate(receipt);
			return sum + (estimate.kind === "unavailable" ? 0 : Math.max(0, -estimate.savings));
		}, 0);
		return {
			rootSessionId,
			rootReceipts,
			descendantReceipts: uniqueDescendants,
			fallbackEvidence,
			unresolved,
			rootActualCost,
			directChildActualCost,
			nestedChildActualCost,
			knownTaskTreeActualCost: rootActualCost + directChildActualCost + nestedChildActualCost,
			reportedChildCount: evidence.filter(
				(item) =>
					item.usage.length > 0 ||
					(item.childSessionId !== undefined &&
						uniqueDescendants.some((receipt) => receipt.sessionId === item.childSessionId)),
			).length,
			expectedChildCount: evidence.length,
			estimatedSavings,
			estimatedExtraCost,
			costCoverage: costCoverageState(evidence, unresolved),
			tokenCoverage: tokenCoverageState(evidence, unresolved),
			estimateCoverage:
				evidence.length === 0
					? "unsupported"
					: unresolved.some((item) => item.reason === "pending")
						? "pending"
						: unresolved.some((item) => item.reason === "overlap-unresolved")
							? "overlap-unresolved"
							: fallbackEvidence.length > 0 || unresolved.length > 0
								? "incomplete"
								: estimateReceipts.every(
											(receipt) => comparisonEstimate(receipt).kind !== "unavailable",
										)
									? "complete"
									: "incomplete",
		};
	}

	async listUnfinishedJournals(): Promise<RunJournal[]> {
		const manifest = await this.initialize();
		const journalsDirectory = this.journalsDirectoryFor(manifest.generation);
		const names = (await readdir(journalsDirectory)).filter((name) => name.endsWith(".json"));
		const journals: RunJournal[] = [];
		for (const name of names.sort()) {
			const identifier = name.slice(0, -".json".length);
			const journal = parseStoredJournal(
				await readFile(path.join(journalsDirectory, name), "utf8"),
				identifier,
			);
			if (journal.generation === manifest.generation) journals.push(journal);
		}
		return journals;
	}

	async aggregate(
		query: AnalyticsQuery = {},
		snapshotOverride?: AnalyticsSnapshot,
	): Promise<AnalyticsAggregate> {
		const snapshot = snapshotOverride ?? (await this.snapshot());
		const generation = snapshot.generation;
		const timeZone = query.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
		const now = query.now ?? new Date();
		const outcomes = query.outcomes === undefined ? null : new Set(query.outcomes);
		const delegationEvidence =
			query.sessionId === undefined ? (snapshot.delegationEvidence ?? []) : [];
		const receipts = snapshot.receipts
			.filter((receipt) => outcomes === null || outcomes.has(receipt.outcome))
			.filter(
				(receipt) => query.sessionId === undefined || receipt.sessionId === query.sessionId,
			)
			.filter((receipt) =>
				inWindow(receipt.completedAt ?? receipt.startedAt, query.window, now, timeZone),
			)
			.sort(compareReceiptsNewestFirst);

		let actualCost = 0;
		let estimatedSavings = 0;
		let estimatedExtraCost = 0;
		let unavailableSavingsCount = 0;
		const outcomeCounts: Record<RunOutcome, number> = {
			active: 0,
			succeeded: 0,
			failed: 0,
			cancelled: 0,
			released: 0,
			"session-ended": 0,
			interrupted: 0,
			unfinished: 0,
		};
		for (const receipt of receipts) {
			actualCost += receipt.actualCost;
			outcomeCounts[receipt.outcome] += 1;
			const estimate = comparisonEstimate(receipt);
			if (estimate.kind === "unavailable") unavailableSavingsCount += 1;
			else if (estimate.savings >= 0) estimatedSavings += estimate.savings;
			else estimatedExtraCost += Math.abs(estimate.savings);
		}

		const unfinished = snapshot.journals
			.filter(() => outcomes === null || outcomes.has("unfinished"))
			.filter(
				(journal) => query.sessionId === undefined || journal.sessionId === query.sessionId,
			)
			.filter((journal) => inWindow(journal.startedAt, query.window, now, timeZone))
			.map(summarizeUnfinishedJournal);

		for (const item of snapshot.journals.filter((journal) =>
			unfinished.some(
				(summary) => summary.runId === journal.runId && summary.epoch === journal.epoch,
			),
		)) {
			actualCost += summarizeActualCost(item.usage).total;
			outcomeCounts.unfinished += 1;
		}

		const receiptEvidenceKeys = new Set(
			receipts.flatMap((receipt) => receipt.evidenceKeys ?? []),
		);
		const successfulRoots = new Set(
			receipts
				.filter((receipt) => receipt.outcome === "succeeded")
				.map((receipt) => receipt.sessionId),
		);
		for (const item of delegationEvidence) {
			if (item.phase !== "terminal") continue;
			if (!inWindow(new Date(item.observedAt).toISOString(), query.window, now, timeZone))
				continue;
			if (outcomes?.has("succeeded") && !successfulRoots.has(item.rootSessionId)) continue;
			for (const slice of item.usage) {
				if (!receiptEvidenceKeys.has(slice.evidenceKey)) actualCost += slice.costUsd;
			}
		}

		const recentLimit = query.recentLimit ?? receipts.length;
		return {
			generation,
			receiptCount: receipts.length,
			actualCost,
			estimatedSavings,
			estimatedExtraCost,
			unavailableSavingsCount,
			outcomes: outcomeCounts,
			receipts,
			recentReceipts: receipts.slice(0, Math.max(0, recentLimit)),
			unfinished,
		};
	}

	async snapshot(): Promise<AnalyticsSnapshot> {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const manifest = await this.initialize();
			const receipts = await this.readReceipts(manifest.generation);
			const journals = await this.readJournals(manifest.generation);
			const delegationEvidence = await this.listDelegationEvidence();
			await this.hooks.beforeSnapshotValidation?.(manifest.generation);
			if ((await this.readManifest()).generation === manifest.generation) {
				return { generation: manifest.generation, receipts, journals, delegationEvidence };
			}
		}
		throw new Error("Analytics ledger changed while reading its snapshot.");
	}

	async exportJsonLines(destination: string): Promise<number> {
		const receipts = (await this.listReceipts()).sort(compareReceiptsOldestFirst);
		const delegation = await this.listDelegationEvidence();
		const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(
				temporary,
				receipts
					.map((item) => serializeRunReceipt(item))
					.concat(delegation.map((item) => JSON.stringify(item)))
					.join("\n") + (receipts.length + delegation.length > 0 ? "\n" : ""),
				{ encoding: "utf8", mode: OWNER_FILE_MODE },
			);
			await this.hooks.beforeExportPublish?.(destination);
			await link(temporary, destination);
		} catch (error) {
			await rm(temporary, { force: true });
			if (hasErrorCode(error, "EEXIST")) {
				throw new Error(
					`Analytics export destination already exists; choose a new filename: ${path.basename(destination)}.`,
				);
			}
			throw error;
		}
		await unlink(temporary).catch(ignoreMissingFile);
		return receipts.length + delegation.length;
	}

	async reset(): Promise<AnalyticsResetResult> {
		const previous = await this.initialize();
		const generation = randomUUID();
		await this.ensureGenerationDirectories(generation);
		const retiredGenerations = [
			...new Set([...(previous.retiredGenerations ?? []), previous.generation]),
		];
		await this.atomicReplace(
			this.manifestPath,
			`${JSON.stringify({ schemaVersion: ANALYTICS_SCHEMA_VERSION, generation, retiredGenerations })}\n`,
		);
		await this.hooks.afterManifestRotate?.(previous.generation, generation);
		return {
			generation,
			...(await this.retryRetiredGenerationCleanup()),
		};
	}

	async retryRetiredGenerationCleanup(): Promise<RetiredGenerationCleanup> {
		const manifest = await this.initialize();
		const remaining: string[] = [];
		for (const retired of manifest.retiredGenerations ?? []) {
			try {
				await this.hooks.beforeRetiredGenerationRemove?.(retired);
				await rm(this.generationDirectory(retired), { recursive: true, force: true });
			} catch {
				remaining.push(retired);
			}
		}
		await this.atomicReplace(
			this.manifestPath,
			`${JSON.stringify({
				schemaVersion: ANALYTICS_SCHEMA_VERSION,
				generation: manifest.generation,
				...(remaining.length > 0 ? { retiredGenerations: remaining } : {}),
			})}\n`,
		);
		return {
			cleanupComplete: remaining.length === 0,
			remainingRetiredGenerations: remaining,
		};
	}

	private async ensureDirectories(): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: OWNER_DIRECTORY_MODE });
		await chmod(this.directory, OWNER_DIRECTORY_MODE);
		let manifest: AnalyticsManifest;
		try {
			manifest = await this.readManifest();
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) throw error;
			manifest = { schemaVersion: ANALYTICS_SCHEMA_VERSION, generation: randomUUID() };
			try {
				await writeExclusive(this.manifestPath, `${JSON.stringify(manifest)}\n`);
			} catch (writeError) {
				if (!hasErrorCode(writeError, "EEXIST")) throw writeError;
				manifest = await this.readManifest();
			}
		}
		await this.ensureGenerationDirectories(manifest.generation);
	}

	private async ensureGenerationDirectories(generation: string): Promise<void> {
		const journals = this.journalsDirectoryFor(generation);
		const receipts = this.receiptsDirectoryFor(generation);
		const delegation = this.delegationDirectoryFor(generation);
		await mkdir(journals, { recursive: true, mode: OWNER_DIRECTORY_MODE });
		await mkdir(receipts, { recursive: true, mode: OWNER_DIRECTORY_MODE });
		await mkdir(delegation, { recursive: true, mode: OWNER_DIRECTORY_MODE });
		await chmod(journals, OWNER_DIRECTORY_MODE);
		await chmod(receipts, OWNER_DIRECTORY_MODE);
		await chmod(delegation, OWNER_DIRECTORY_MODE);
	}

	private generationDirectory(generation: string): string {
		return path.join(this.directory, generation);
	}
	private journalsDirectoryFor(generation: string): string {
		return path.join(this.generationDirectory(generation), JOURNALS_DIRECTORY);
	}
	private receiptsDirectoryFor(generation: string): string {
		return path.join(this.generationDirectory(generation), RECEIPTS_DIRECTORY);
	}
	private delegationDirectoryFor(generation: string): string {
		return path.join(this.generationDirectory(generation), DELEGATION_DIRECTORY);
	}
	private delegationPath(generation: string, key: string): string {
		return path.join(this.delegationDirectoryFor(generation), `${safePathPart(key)}.json`);
	}
	private async readReceipts(generation: string): Promise<RunReceipt[]> {
		const directory = this.receiptsDirectoryFor(generation);
		const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
		const receipts = await Promise.all(
			names.map(async (name) =>
				parseStoredReceipt(
					await readFile(path.join(directory, name), "utf8"),
					name.slice(0, -5),
				),
			),
		);
		if (receipts.some((receipt) => receipt.generation !== generation))
			throw new Error("Analytics receipt belongs to an unexpected ledger generation.");
		return receipts;
	}
	private async readJournals(generation: string): Promise<RunJournal[]> {
		const directory = this.journalsDirectoryFor(generation);
		const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
		const journals = await Promise.all(
			names.map(async (name) =>
				parseStoredJournal(
					await readFile(path.join(directory, name), "utf8"),
					name.slice(0, -5),
				),
			),
		);
		if (journals.some((journal) => journal.generation !== generation))
			throw new Error("Analytics journal belongs to an unexpected ledger generation.");
		return journals;
	}

	private async readManifest(): Promise<AnalyticsManifest> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(this.manifestPath, "utf8"));
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) throw error;
			throw new Error("Analytics manifest is not valid JSON.");
		}
		if (!isRecord(parsed)) throw new Error("Analytics manifest must be a JSON object.");
		const keys = Object.keys(parsed);
		if (
			keys.some((key) => !["schemaVersion", "generation", "retiredGenerations"].includes(key)) ||
			!keys.includes("schemaVersion") ||
			!keys.includes("generation")
		) {
			throw new Error("Analytics manifest contains unsupported fields.");
		}
		if (parsed.schemaVersion !== ANALYTICS_SCHEMA_VERSION) {
			throw new Error(
				`Analytics manifest schemaVersion ${String(parsed.schemaVersion)} is unsupported.`,
			);
		}
		if (typeof parsed.generation !== "string" || !/^[A-Za-z0-9._:-]+$/.test(parsed.generation)) {
			throw new Error("Analytics manifest generation is invalid.");
		}
		if (parsed.retiredGenerations !== undefined && !Array.isArray(parsed.retiredGenerations))
			throw new Error("Analytics manifest retiredGenerations must be an array.");
		const retiredGenerations =
			parsed.retiredGenerations === undefined
				? undefined
				: parsed.retiredGenerations.map((value: unknown, index: number) => {
						if (typeof value !== "string" || !/^[A-Za-z0-9._:-]+$/.test(value))
							throw new Error(`Analytics manifest retired generation ${index} is invalid.`);
						return value;
					});
		return {
			schemaVersion: ANALYTICS_SCHEMA_VERSION,
			generation: parsed.generation,
			...(retiredGenerations ? { retiredGenerations } : {}),
		};
	}

	private async requireCurrentGeneration(generation: string): Promise<void> {
		const current = await this.currentGeneration();
		if (generation !== current) {
			throw new Error(
				"Analytics run belongs to a prior ledger generation and cannot be stored.",
			);
		}
	}

	private journalPath(generation: string, runId: string, epoch: string): string {
		return path.join(
			this.journalsDirectoryFor(generation),
			`${ledgerEntryIdentifier(runId, epoch)}.json`,
		);
	}

	private receiptPath(generation: string, runId: string, epoch: string): string {
		return path.join(
			this.receiptsDirectoryFor(generation),
			`${ledgerEntryIdentifier(runId, epoch)}.json`,
		);
	}

	private benchmarkSummaryPath(generation: string): string {
		return path.join(this.generationDirectory(generation), "verified-benchmark.json");
	}

	private async withDelegationLock(operation: () => Promise<void>): Promise<void> {
		const lockPath = path.join(this.directory, ".delegation.lock");
		for (let attempt = 0; attempt < 40; attempt += 1) {
			try {
				const handle = await open(lockPath, "wx", OWNER_FILE_MODE);
				try {
					await operation();
				} finally {
					await handle.close();
					await unlink(lockPath).catch(ignoreMissingFile);
				}
				return;
			} catch (error) {
				if (!hasErrorCode(error, "EEXIST")) throw error;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		}
		throw new Error("Delegation evidence lock could not be acquired.");
	}

	private async atomicReplace(target: string, contents: string): Promise<void> {
		const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, contents, { encoding: "utf8", mode: OWNER_FILE_MODE });
			await this.hooks.beforeAtomicReplace?.(target);
			await rename(temporary, target);
		} catch (error) {
			await rm(temporary, { force: true });
			throw error;
		}
	}
}

function ledgerEntryIdentifier(runId: string, epoch: string): string {
	return `${safePathPart(runId)}--${safePathPart(epoch)}`;
}

function safePathPart(value: string): string {
	if (!/^[A-Za-z0-9._:-]+$/.test(value)) throw new Error("Analytics identifier is unsafe.");
	return value;
}

function parseStoredJournal(contents: string, identifier: string): RunJournal {
	try {
		return deserializeRunJournal(contents);
	} catch (error) {
		throw new Error(`Analytics journal ${identifier} is invalid: ${safeErrorMessage(error)}`);
	}
}

function parseStoredReceipt(contents: string, identifier: string): RunReceipt {
	try {
		return deserializeRunReceipt(contents);
	} catch (error) {
		throw new Error(`Analytics receipt ${identifier} is invalid: ${safeErrorMessage(error)}`);
	}
}

async function writeExclusive(target: string, contents: string): Promise<void> {
	const handle = await open(target, "wx", OWNER_FILE_MODE);
	try {
		await handle.writeFile(contents, "utf8");
	} catch (error) {
		await handle.close();
		await rm(target, { force: true });
		throw error;
	}
	await handle.close();
}

function hasErrorCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function ignoreMissingFile(error: unknown): void {
	if (!hasErrorCode(error, "ENOENT")) throw error;
}

function safeErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "unknown validation failure";
}

function summarizeUnfinishedJournal(journal: RunJournal): UnfinishedRunSummary {
	return {
		runId: journal.runId,
		epoch: journal.epoch,
		sessionId: journal.sessionId,
		startedAt: journal.startedAt,
		outcome: "unfinished",
		actualCost: summarizeActualCost(journal.usage).total,
	};
}

function compareReceiptsNewestFirst(left: RunReceipt, right: RunReceipt): number {
	return compareReceiptTimestamps(right, left) || left.runId.localeCompare(right.runId);
}

function costCoverageState(
	evidence: DelegationEvidence[],
	unresolved: TaskTreeUnresolvedDescendant[],
): TaskTreeReport["costCoverage"] {
	if (evidence.length === 0) return "unsupported";
	if (unresolved.some((item) => item.reason === "pending")) return "pending";
	if (unresolved.some((item) => item.reason === "overlap-unresolved")) {
		return "overlap-unresolved";
	}
	if (unresolved.some((item) => item.reason === "missing-cost" || item.reason === "unsupported")) {
		return "incomplete";
	}
	return "complete";
}

function tokenCoverageState(
	evidence: DelegationEvidence[],
	unresolved: TaskTreeUnresolvedDescendant[],
): TaskTreeReport["tokenCoverage"] {
	if (evidence.length === 0) return "unsupported";
	if (unresolved.some((item) => item.reason === "pending")) return "pending";
	if (unresolved.some((item) => item.reason === "overlap-unresolved")) {
		return "overlap-unresolved";
	}
	return unresolved.length === 0 ? "complete" : "incomplete";
}

function compareReceiptsOldestFirst(left: RunReceipt, right: RunReceipt): number {
	return compareReceiptTimestamps(left, right) || left.runId.localeCompare(right.runId);
}

function compareReceiptTimestamps(left: RunReceipt, right: RunReceipt): number {
	return (left.completedAt ?? left.startedAt).localeCompare(right.completedAt ?? right.startedAt);
}

function inWindow(
	timestamp: string,
	window: AnalyticsWindow | undefined,
	now: Date,
	timeZone: string,
): boolean {
	if (window === undefined || window === "lifetime") return true;
	const receiptDate = zonedDateKey(new Date(timestamp), timeZone);
	const currentDate = zonedDateKey(now, timeZone);
	if (window === "month") return receiptDate.slice(0, 7) === currentDate.slice(0, 7);
	return weekStart(receiptDate) === weekStart(currentDate);
}

function zonedDateKey(date: Date, timeZone: string): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const year = parts.find((part) => part.type === "year")?.value;
	const month = parts.find((part) => part.type === "month")?.value;
	const day = parts.find((part) => part.type === "day")?.value;
	if (year === undefined || month === undefined || day === undefined) {
		throw new Error(`Unable to calculate analytics window for timezone ${timeZone}.`);
	}
	return `${year}-${month}-${day}`;
}

function weekStart(dateKey: string): string {
	const date = new Date(`${dateKey}T00:00:00.000Z`);
	const daysSinceMonday = (date.getUTCDay() + 6) % 7;
	date.setUTCDate(date.getUTCDate() - daysSinceMonday);
	return date.toISOString().slice(0, 10);
}
