import type { ModelCost, Usage } from "@earendil-works/pi-ai";
import type { PrewalkRun } from "../orchestration/coordinator.js";
import {
	ANALYTICS_SCHEMA_VERSION,
	calculateSavings,
	DEFAULT_ANALYTICS_CONFIG,
	normalizeUsageObservations,
	type RunJournal,
	type RunOutcome,
	type RunReceipt,
	type UsageObservationSource,
	type UsageRole,
	usageEvidenceKey,
} from "./index.js";
import {
	type AnalyticsAggregate,
	type AnalyticsQuery,
	type AnalyticsResetResult,
	type AnalyticsSnapshot,
	AnalyticsStore,
	type UnfinishedJournalRecord,
} from "./store.js";
import { projectDelegationToolResult } from "./subagents.js";

export interface AnalyticsModel {
	provider: string;
	id: string;
	cost: ModelCost;
}

export interface AnalyticsHost {
	sessionId: string;
	findModel(provider: string, model: string): AnalyticsModel | undefined;
}

export interface DelegationProjectionInput {
	rootSessionId: string;
	parentSessionId: string;
	invocationId: string;
	childCount: number;
	details: unknown;
	isError: boolean;
	generation: string;
}

type PricingSchedule = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: ModelCost["tiers"];
};

type ActiveAnalyticsState = {
	journal: RunJournal;
	pricing: {
		capturedAt: string;
		rates: { planner: PricingSchedule; executor: PricingSchedule };
	};
	catalog: {
		catalogDate: string;
		rates: { planner: PricingSchedule; executor: PricingSchedule };
	};
	finalization?: Promise<void>;
};

function pricingSchedule(cost: ModelCost): PricingSchedule {
	return {
		input: cost.input,
		output: cost.output,
		cacheRead: cost.cacheRead,
		cacheWrite: cost.cacheWrite,
		...(cost.tiers ? { tiers: cost.tiers.map((tier) => ({ ...tier })) } : {}),
	};
}

function handoffState(run: PrewalkRun): RunJournal["handoffState"] {
	if (run.phase === "failed") return "failed";
	if (run.phase === "handoff-pending") return "pending";
	if (run.phase === "active" || run.phase === "completed") return "completed";
	return "not-started";
}

function journalPricingInputs(
	journal: RunJournal,
	host: AnalyticsHost,
): {
	catalogFallbackEnabled: boolean;
	modelMetadata?: {
		capturedAt: string;
		rates: { planner: PricingSchedule; executor: PricingSchedule };
	};
	catalog?: {
		catalogDate: string;
		rates: { planner: PricingSchedule; executor: PricingSchedule };
	};
} {
	const catalogFallbackEnabled = journal.configuration.analytics.catalogFallbackEnabled;
	const planner = host.findModel(
		journal.configuration.planner.provider,
		journal.configuration.planner.model,
	);
	const executor = host.findModel(
		journal.configuration.executor.provider,
		journal.configuration.executor.model,
	);
	if (!planner || !executor) return { catalogFallbackEnabled };
	const capturedAt = new Date().toISOString();
	const rates = {
		planner: pricingSchedule(planner.cost),
		executor: pricingSchedule(executor.cost),
	};
	return {
		catalogFallbackEnabled,
		modelMetadata: { capturedAt, rates },
		catalog: { catalogDate: capturedAt.slice(0, 10), rates },
	};
}

/**
 * Owns the mutable analytics trajectory for one Prewalk application. The Pi
 * adapter supplies model lookup and session identity; it never manipulates a
 * journal, receipt, generation, or write queue directly.
 */
export class PrewalkAnalytics {
	readonly #store: AnalyticsStore;
	#state: ActiveAnalyticsState | undefined;
	#writes: Promise<void> = Promise.resolve();

	constructor(agentDirectory: string) {
		this.#store = new AnalyticsStore(agentDirectory);
	}

	get storeDirectory(): AnalyticsStore {
		return this.#store;
	}

	get active(): boolean {
		return this.#state !== undefined;
	}

	hasStateFor(run: PrewalkRun | undefined): boolean {
		return this.owns(run);
	}

	hasUsageFor(run: PrewalkRun | undefined): boolean {
		return this.owns(run) && (this.#state?.journal.usage.length ?? 0) > 0;
	}

	resetActive(): void {
		this.#state = undefined;
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		this.#writes = this.#writes.then(operation, operation);
		return this.#writes;
	}

	waitForWrites(): Promise<void> {
		return this.#writes;
	}

	usageRole(run: PrewalkRun, provider: string, model: string): UsageRole {
		const handedOff = handoffState(run) === "completed";
		if (
			handedOff &&
			provider === run.config.executor.provider &&
			model === run.config.executor.model
		) {
			return "executor-primary";
		}
		if (!handedOff && provider === run.planner.provider && model === run.planner.model) {
			return "planner-primary";
		}
		return "auxiliary";
	}

	private owns(run: PrewalkRun | undefined): boolean {
		return (
			this.#state !== undefined &&
			run !== undefined &&
			this.#state.journal.runId === run.id &&
			this.#state.journal.epoch === run.epoch
		);
	}

	async open(run: PrewalkRun, host: AnalyticsHost): Promise<void> {
		this.#state = undefined;
		const analytics = run.config.analytics ?? DEFAULT_ANALYTICS_CONFIG;
		if (!analytics.enabled) return;
		const planner = host.findModel(run.planner.provider, run.planner.model);
		const executor = host.findModel(run.config.executor.provider, run.config.executor.model);
		if (!planner || !executor) return;
		const generation = await this.#store.currentGeneration();
		const journal: RunJournal = {
			schemaVersion: ANALYTICS_SCHEMA_VERSION,
			runId: run.id,
			epoch: run.epoch,
			sessionId: host.sessionId,
			generation,
			configuration: {
				analytics: structuredClone(analytics),
				planner: { provider: run.planner.provider, model: run.planner.model },
				executor: { provider: run.config.executor.provider, model: run.config.executor.model },
			},
			startedAt: new Date().toISOString(),
			lastObservedSequence: 0,
			evidenceKeys: [],
			outcome: "active",
			handoffState: handoffState(run),
			usage: [],
		};
		const capturedAt = new Date().toISOString();
		const rates = {
			planner: pricingSchedule(planner.cost),
			executor: pricingSchedule(executor.cost),
		};
		await this.#store.writeJournal(journal);
		this.#state = {
			journal,
			pricing: { capturedAt, rates },
			catalog: { catalogDate: capturedAt.slice(0, 10), rates },
		};
	}

	async restore(run: PrewalkRun, host: AnalyticsHost): Promise<void> {
		this.#state = undefined;
		const analytics = run.config.analytics ?? DEFAULT_ANALYTICS_CONFIG;
		if (!analytics.enabled) return;
		const journal = await this.#store.restoreJournal(run.id, run.epoch);
		if (!journal) return;
		const planner = host.findModel(run.planner.provider, run.planner.model);
		const executor = host.findModel(run.config.executor.provider, run.config.executor.model);
		if (!planner || !executor) return;
		const capturedAt = new Date().toISOString();
		const rates = {
			planner: pricingSchedule(planner.cost),
			executor: pricingSchedule(executor.cost),
		};
		this.#state = {
			journal,
			pricing: { capturedAt, rates },
			catalog: { catalogDate: capturedAt.slice(0, 10), rates },
		};
	}

	recordUsage(
		source: UsageObservationSource,
		evidenceId: string,
		provider: string,
		model: string,
		role: UsageRole,
		usage: Usage,
		targetRun?: PrewalkRun,
	): Promise<void> {
		const state = this.#state;
		if (!state || (targetRun !== undefined && !this.owns(targetRun))) return Promise.resolve();
		const observation = {
			sequence: state.journal.lastObservedSequence + 1,
			evidenceId,
			source,
			provider,
			model,
			role,
			final: true,
			usage: { ...usage },
		};
		const key = usageEvidenceKey(observation);
		const evidenceKeys = state.journal.evidenceKeys ?? [];
		state.journal.evidenceKeys = evidenceKeys;
		if (evidenceKeys.includes(key)) return Promise.resolve();
		state.journal.lastObservedSequence = observation.sequence;
		evidenceKeys.push(key);
		if (targetRun) state.journal.handoffState = handoffState(targetRun);
		const [slice] = normalizeUsageObservations([observation]);
		if (slice) state.journal.usage.push(slice);
		return this.enqueue(() => this.#store.writeJournal(state.journal));
	}

	finalize(outcome: RunOutcome, targetRun?: PrewalkRun): Promise<void> {
		const state = this.#state;
		if (!state || (targetRun !== undefined && !this.owns(targetRun))) return this.#writes;
		if (state.finalization) return state.finalization;
		const { journal, pricing } = state;
		const finalHandoffState = targetRun ? handoffState(targetRun) : journal.handoffState;
		const promise = this.enqueue(async () => {
			journal.outcome = outcome;
			journal.handoffState = finalHandoffState;
			const calculation = calculateSavings({
				outcome,
				handoffState: journal.handoffState,
				usage: journal.usage,
				modelMetadata: pricing,
				catalog: state.catalog,
				catalogFallbackEnabled: journal.configuration.analytics.catalogFallbackEnabled,
			});
			const receipt: RunReceipt = {
				schemaVersion: ANALYTICS_SCHEMA_VERSION,
				runId: journal.runId,
				epoch: journal.epoch,
				sessionId: journal.sessionId,
				generation: journal.generation,
				startedAt: journal.startedAt,
				completedAt: new Date().toISOString(),
				outcome,
				handoffState: journal.handoffState,
				planner: journal.configuration.planner,
				executor: journal.configuration.executor,
				usage: journal.usage,
				actualCost: calculation.actualCost,
				estimate: calculation.estimate,
				pricingEvidence: calculation.pricingEvidence,
				pricing: pricing.rates,
				evidenceKeys: [...(journal.evidenceKeys ?? [])],
				...(journal.lineage === undefined ? {} : { lineage: journal.lineage }),
			};
			try {
				await this.#store.promoteReceipt(receipt);
			} catch (error) {
				if ((await this.#store.supersedeRecoveredReceipt(receipt)) === null) throw error;
			}
			if (this.#state === state) this.#state = undefined;
		}).catch((error) => {
			if (state.finalization === promise) state.finalization = undefined;
			throw error;
		});
		state.finalization = promise;
		return promise;
	}

	async finalizeInterrupted(sessionId: string, host: AnalyticsHost): Promise<void> {
		await this.#writes;
		const records = await this.#store.listUnfinishedJournalRecords();
		const staleBefore = Date.now() - 24 * 60 * 60 * 1000;
		for (const { journal, modifiedAt } of records) {
			if (journal.sessionId !== sessionId && modifiedAt > staleBefore) continue;
			const outcome: RunOutcome = journal.outcome === "active" ? "interrupted" : journal.outcome;
			const pricingInputs = journalPricingInputs(journal, host);
			const calculation = calculateSavings({
				outcome,
				handoffState: journal.handoffState,
				usage: journal.usage,
				...pricingInputs,
			});
			const recovered: RunReceipt = {
				schemaVersion: ANALYTICS_SCHEMA_VERSION,
				runId: journal.runId,
				epoch: journal.epoch,
				sessionId: journal.sessionId,
				generation: journal.generation,
				startedAt: journal.startedAt,
				completedAt: new Date().toISOString(),
				outcome,
				handoffState: journal.handoffState,
				planner: journal.configuration.planner,
				executor: journal.configuration.executor,
				usage: journal.usage,
				actualCost: calculation.actualCost,
				estimate: calculation.estimate,
				pricingEvidence: calculation.pricingEvidence,
				...(pricingInputs.modelMetadata === undefined
					? {}
					: { pricing: pricingInputs.modelMetadata.rates }),
				evidenceKeys: [...(journal.evidenceKeys ?? [])],
				...(journal.lineage === undefined ? {} : { lineage: journal.lineage }),
			};
			try {
				await this.#store.promoteReceipt(recovered);
			} catch (error) {
				if ((await this.#store.supersedeRecoveredReceipt(recovered)) === null) throw error;
			}
		}
	}

	async recordDelegation(input: DelegationProjectionInput): Promise<string | undefined> {
		const evidence = projectDelegationToolResult({
			rootSessionId: input.rootSessionId,
			parentSessionId: input.parentSessionId,
			invocationId: input.invocationId,
			childCount: input.childCount,
			details: input.details,
			isError: input.isError,
		});
		for (const item of evidence) {
			if (input.generation !== (await this.#store.currentGeneration())) continue;
			const { schemaVersion, ...eventValue } = item;
			await this.enqueue(async () => {
				await this.#store.writeDelegationEvidence(
					{ ...eventValue, version: schemaVersion },
					input.generation,
				);
			});
		}
		return evidence[0]?.delegationRunId;
	}

	currentGeneration(): Promise<string> {
		return this.#store.currentGeneration();
	}

	listReceipts() {
		return this.#store.listReceipts();
	}

	snapshot(): Promise<AnalyticsSnapshot> {
		return this.#store.snapshot();
	}

	aggregate(query: AnalyticsQuery, snapshot: AnalyticsSnapshot): Promise<AnalyticsAggregate> {
		return this.#store.aggregate(query, snapshot);
	}

	readVerifiedBenchmarkSummary() {
		return this.#store.readVerifiedBenchmarkSummary();
	}

	taskTree(sessionId: string) {
		return this.#store.taskTree(sessionId);
	}

	writeVerifiedBenchmarkSummary(
		value: Parameters<AnalyticsStore["writeVerifiedBenchmarkSummary"]>[0],
	) {
		return this.#store.writeVerifiedBenchmarkSummary(value);
	}

	exportJsonLines(destination: string) {
		return this.#store.exportJsonLines(destination);
	}

	reset(): Promise<AnalyticsResetResult> {
		this.#state = undefined;
		return this.#store.reset();
	}

	retryRetiredGenerationCleanup() {
		return this.#store.retryRetiredGenerationCleanup();
	}
}

export type {
	AnalyticsAggregate,
	AnalyticsQuery,
	AnalyticsResetResult,
	AnalyticsSnapshot,
	UnfinishedJournalRecord,
};
