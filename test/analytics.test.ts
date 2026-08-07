import { describe, expect, it } from "vitest";
import {
	ANALYTICS_SCHEMA_VERSION,
	calculateSavings,
	comparisonEstimate,
	DEFAULT_ANALYTICS_CONFIG,
	deserializeRunReceipt,
	HANDOFF_STATES,
	normalizeUsageObservations,
	PRICING_SOURCES,
	parseAnalyticsConfig,
	parseRunReceipt,
	RUN_OUTCOMES,
	type RunReceipt,
	serializeRunReceipt,
	summarizeActualCost,
	UNAVAILABILITY_REASONS,
	USAGE_ROLES,
	type UsageObservation,
	type UsageSlice,
} from "../src/analytics.js";

const receipt: RunReceipt = {
	schemaVersion: ANALYTICS_SCHEMA_VERSION,
	runId: "run-123",
	epoch: "epoch-123",
	sessionId: "session-123",
	generation: "generation-1",
	startedAt: "2026-07-30T12:00:00.000Z",
	completedAt: "2026-07-30T12:01:00.000Z",
	outcome: "succeeded",
	handoffState: "completed",
	planner: { provider: "openai-codex", model: "gpt-5.6-sol" },
	executor: { provider: "openai-codex", model: "gpt-5.6-luna" },
	usage: [
		{
			sequence: 1,
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			role: "planner-primary",
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 50,
			cacheWriteTokens: 10,
			reasoningTokens: 5,
			totalTokens: 185,
			cost: {
				input: 0.1,
				output: 0.2,
				cacheRead: 0.01,
				cacheWrite: 0.02,
				total: 0.33,
			},
		},
		{
			sequence: 2,
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			role: "executor-primary",
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			totalTokens: 15,
			cost: {
				input: 0.05,
				output: 0.05,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0.1,
			},
		},
	],
	actualCost: 0.43,
	estimate: {
		kind: "session-counterfactual",
		plannerOnlyCost: 0.5,
		savings: 0.07,
	},
	pricingEvidence: {
		source: "model-metadata",
		capturedAt: "2026-07-30T12:01:00.000Z",
	},
};

describe("analytics domain contract", () => {
	it("exports stable state and evidence vocabularies", () => {
		expect(RUN_OUTCOMES).toEqual([
			"active",
			"succeeded",
			"failed",
			"cancelled",
			"released",
			"session-ended",
			"interrupted",
			"unfinished",
		]);
		expect(HANDOFF_STATES).toEqual(["not-started", "pending", "completed", "failed"]);
		expect(USAGE_ROLES).toEqual([
			"planner-primary",
			"executor-primary",
			"auxiliary",
			"compaction",
		]);
		expect(PRICING_SOURCES).toEqual([
			"pi-reported-actual",
			"model-metadata",
			"catalog",
			"unavailable",
		]);
		expect(UNAVAILABILITY_REASONS).toContain("pricing-incomplete");
	});

	it("validates analytics configuration strictly", () => {
		expect(parseAnalyticsConfig(DEFAULT_ANALYTICS_CONFIG)).toEqual(DEFAULT_ANALYTICS_CONFIG);
		expect(() => parseAnalyticsConfig({ ...DEFAULT_ANALYTICS_CONFIG, telemetry: true })).toThrow(
			"Unknown analytics config field: telemetry.",
		);
		expect(() => parseAnalyticsConfig({ ...DEFAULT_ANALYTICS_CONFIG, schemaVersion: 2 })).toThrow(
			"schemaVersion 2 is unsupported",
		);
	});

	it("round-trips a valid receipt without losing usage or pricing evidence", () => {
		const serialized = serializeRunReceipt(receipt);
		expect(deserializeRunReceipt(serialized)).toEqual(receipt);
		expect(JSON.parse(serialized)).toEqual(receipt);
	});

	it.each(["prompt", "assistantText", "code", "toolInput", "requestPayload", "rawError", "cwd"])(
		"rejects prohibited receipt field %s",
		(field) => {
			expect(() => parseRunReceipt({ ...receipt, [field]: "secret" })).toThrow(
				`Unknown analytics receipt field: ${field}.`,
			);
		},
	);

	it("rejects prohibited nested provider payloads", () => {
		expect(() =>
			parseRunReceipt({
				...receipt,
				usage: [{ ...receipt.usage[0], providerResponse: { id: "secret" } }],
			}),
		).toThrow("providerResponse");
	});

	it("rejects raw filesystem paths in persisted identifiers", () => {
		expect(() => parseRunReceipt({ ...receipt, sessionId: "/Users/example/session" })).toThrow(
			"without a filesystem path",
		);
	});

	it("rejects unsupported receipt versions", () => {
		expect(() => parseRunReceipt({ ...receipt, schemaVersion: 2 })).toThrow(
			"schemaVersion 2 is unsupported",
		);
	});

	it("rejects financial totals that do not reconcile with usage evidence", () => {
		expect(() => parseRunReceipt({ ...receipt, actualCost: 0.34 })).toThrow(
			"actualCost does not reconcile",
		);
		expect(() =>
			parseRunReceipt({
				...receipt,
				usage: [{ ...receipt.usage[0], cost: { ...receipt.usage[0].cost, total: 0.34 } }],
			}),
		).toThrow("total does not reconcile");
		expect(() =>
			parseRunReceipt({
				...receipt,
				estimate: { ...receipt.estimate, savings: 0.18 },
			}),
		).toThrow("savings does not reconcile");
	});

	it("rejects a one-hour cache-write count larger than total cache writes", () => {
		expect(() =>
			parseRunReceipt({
				...receipt,
				usage: [{ ...receipt.usage[0], cacheWrite1hTokens: 11 }],
			}),
		).toThrow("cacheWrite1hTokens cannot exceed cacheWriteTokens");
	});

	it.each(["released", "session-ended"] as const)(
		"accepts a priced estimate for a %s receipt",
		(outcome) => {
			expect(parseRunReceipt({ ...receipt, outcome })).toEqual({ ...receipt, outcome });
		},
	);

	it.each(["released", "session-ended"] as const)(
		"normalizes legacy unavailable reasons for a %s receipt",
		(outcome) => {
			const parsed = parseRunReceipt({
				...receipt,
				outcome,
				estimate: { kind: "unavailable", reason: "run-not-successful" },
				pricingEvidence: { source: "unavailable", reason: "run-not-successful" },
			});
			expect(parsed.estimate).toEqual({ kind: "unavailable", reason: "pricing-missing" });
			expect(parsed.pricingEvidence).toEqual({
				source: "unavailable",
				reason: "pricing-missing",
			});
		},
	);

	it("rejects a priced handoff estimate when executor usage is missing", () => {
		expect(() =>
			parseRunReceipt({
				...receipt,
				usage: [receipt.usage[0]],
				actualCost: 0.33,
			}),
		).toThrow("estimate requires executor usage after handoff");
	});
});

const emptyCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function usageSlice(
	sequence: number,
	role: UsageSlice["role"],
	overrides: Partial<UsageSlice> = {},
): UsageSlice {
	return {
		sequence,
		provider: "provider",
		model: role === "executor-primary" ? "executor" : "planner",
		role,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		totalTokens: 0,
		cost: emptyCost,
		...overrides,
	};
}

const completeRates = {
	planner: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 },
	executor: { input: 5, output: 8, cacheRead: 0.5, cacheWrite: 1 },
};

describe("analytics usage attribution", () => {
	it("keeps a planning-only receipt financially valid with no estimated difference", () => {
		const calculation = calculateSavings({
			outcome: "succeeded",
			handoffState: "not-started",
			usage: [
				usageSlice(1, "planner-primary", {
					cost: { ...emptyCost, input: 0.4, total: 0.4 },
				}),
			],
			modelMetadata: {
				capturedAt: "2026-07-30T12:00:00.000Z",
				rates: completeRates,
			},
			catalogFallbackEnabled: false,
		});

		expect(calculation.estimate).toEqual({
			kind: "session-counterfactual",
			plannerOnlyCost: 0.4,
			savings: 0,
		});
	});

	it("normalizes final observations and deduplicates overlapping assistant, tool, and compaction evidence", () => {
		const reported = {
			input: 100,
			output: 20,
			cacheRead: 40,
			cacheWrite: 10,
			reasoning: 5,
			totalTokens: 170,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
		};
		const observations: UsageObservation[] = [
			{
				sequence: 2,
				source: "tool-result",
				provider: "provider",
				model: "executor",
				role: "executor-primary",
				final: true,
				usage: reported,
			},
			{
				sequence: 2,
				source: "assistant",
				provider: "provider",
				model: "executor",
				role: "executor-primary",
				final: true,
				usage: reported,
			},
			{
				sequence: 3,
				source: "compaction",
				provider: "provider",
				model: "planner",
				role: "compaction",
				final: true,
				usage: reported,
			},
			{
				sequence: 3,
				source: "assistant",
				provider: "provider",
				model: "planner",
				role: "compaction",
				final: true,
				usage: reported,
			},
			{
				sequence: 4,
				source: "assistant",
				provider: "provider",
				model: "planner",
				role: "auxiliary",
				final: false,
				usage: reported,
			},
		];

		expect(normalizeUsageObservations(observations)).toEqual([
			expect.objectContaining({ sequence: 2, role: "executor-primary", reasoningTokens: 5 }),
			expect.objectContaining({ sequence: 3, role: "compaction", reasoningTokens: 5 }),
		]);
	});

	it("preserves the provider's one-hour cache-write split", () => {
		const normalized = normalizeUsageObservations([
			{
				sequence: 1,
				source: "assistant",
				provider: "provider",
				model: "executor",
				role: "executor-primary",
				final: true,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 1_000_000,
					cacheWrite1h: 1_000_000,
					totalTokens: 1_000_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 2, total: 2 },
				},
			},
		]);

		expect(normalized[0]).toMatchObject({
			cacheWriteTokens: 1_000_000,
			cacheWrite1hTokens: 1_000_000,
		});
	});

	it("reconciles Pi-reported category totals and keeps auxiliary cost separate", () => {
		const summary = summarizeActualCost([
			usageSlice(1, "planner-primary", {
				cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
			}),
			usageSlice(2, "executor-primary", {
				cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, total: 26 },
			}),
			usageSlice(3, "auxiliary", {
				cost: { input: 9, output: 10, cacheRead: 11, cacheWrite: 12, total: 42 },
			}),
		]);

		expect(summary).toEqual({
			input: 15,
			output: 18,
			cacheRead: 21,
			cacheWrite: 24,
			total: 78,
			plannerPrimary: 10,
			executorPrimary: 26,
			auxiliary: 42,
		});
	});
});

describe("analytics counterfactual pricing", () => {
	it("reprices executor requests with planner rates without billing reasoning twice", () => {
		const usage = [
			usageSlice(1, "planner-primary", { cost: { ...emptyCost, total: 0.5 } }),
			usageSlice(2, "executor-primary", {
				inputTokens: 100_000,
				outputTokens: 20_000,
				cacheReadTokens: 50_000,
				cacheWriteTokens: 10_000,
				reasoningTokens: 15_000,
				totalTokens: 180_000,
				cost: { input: 0.5, output: 0.16, cacheRead: 0.025, cacheWrite: 0.01, total: 0.695 },
			}),
			usageSlice(3, "auxiliary", { cost: { ...emptyCost, total: 0.25 } }),
		];

		const calculation = calculateSavings({
			outcome: "succeeded",
			handoffState: "completed",
			usage,
			modelMetadata: { capturedAt: "2026-07-30T12:00:00.000Z", rates: completeRates },
			catalogFallbackEnabled: false,
		});

		expect(calculation.actualCost).toBeCloseTo(1.445, 12);
		expect(calculation.estimate.kind).toBe("session-counterfactual");
		if (calculation.estimate.kind !== "unavailable") {
			expect(calculation.estimate.plannerOnlyCost).toBeCloseTo(1.97, 12);
			expect(calculation.estimate.savings).toBeCloseTo(0.775, 12);
		}
		expect(calculation.pricingEvidence).toEqual({
			source: "model-metadata",
			capturedAt: "2026-07-30T12:00:00.000Z",
		});
	});

	it("reprices one-hour cache writes at twice the planner input rate", () => {
		const calculation = calculateSavings({
			outcome: "succeeded",
			handoffState: "completed",
			usage: [
				usageSlice(1, "planner-primary", { cost: { ...emptyCost, total: 0.5 } }),
				usageSlice(2, "executor-primary", {
					cacheWriteTokens: 1_000_000,
					cacheWrite1hTokens: 1_000_000,
					totalTokens: 1_000_000,
					cost: { ...emptyCost, cacheWrite: 2, total: 2 },
				}),
			],
			modelMetadata: { capturedAt: "2026-07-30T12:00:00.000Z", rates: completeRates },
			catalogFallbackEnabled: false,
		});

		expect(calculation.estimate).toEqual({
			kind: "session-counterfactual",
			plannerOnlyCost: 20.5,
			savings: 18,
		});
	});

	it("requires both model prices before repricing executor usage", () => {
		const calculation = calculateSavings({
			outcome: "succeeded",
			handoffState: "completed",
			usage: [
				usageSlice(1, "planner-primary", { cost: { ...emptyCost, total: 0.5 } }),
				usageSlice(2, "executor-primary", {
					inputTokens: 100_000,
					outputTokens: 20_000,
					cost: { input: 0.5, output: 0.16, cacheRead: 0, cacheWrite: 0, total: 0.66 },
				}),
			],
			modelMetadata: {
				capturedAt: "2026-07-30T12:00:00.000Z",
				rates: { planner: completeRates.planner, executor: {} },
			},
			catalogFallbackEnabled: false,
		});

		expect(calculation.estimate).toEqual({ kind: "unavailable", reason: "pricing-incomplete" });
	});

	it("applies request-wide tiers independently at the strict threshold boundary", () => {
		const usage = [
			usageSlice(1, "planner-primary", {
				inputTokens: 1,
				cost: { ...emptyCost, total: 1 },
			}),
			usageSlice(2, "executor-primary", {
				inputTokens: 100,
				cost: { ...emptyCost, total: 0.1 },
			}),
			usageSlice(3, "executor-primary", {
				inputTokens: 101,
				cost: { ...emptyCost, total: 0.1 },
			}),
		];
		const tieredRates = {
			planner: {
				...completeRates.planner,
				tiers: [{ inputTokensAbove: 100, input: 20, output: 20, cacheRead: 1, cacheWrite: 2 }],
			},
			executor: completeRates.executor,
		};

		const calculation = calculateSavings({
			outcome: "succeeded",
			handoffState: "completed",
			usage,
			modelMetadata: { capturedAt: "2026-07-30T12:00:00.000Z", rates: tieredRates },
			catalogFallbackEnabled: false,
		});

		expect(calculation.estimate.kind).toBe("session-counterfactual");
		if (calculation.estimate.kind !== "unavailable") {
			expect(calculation.estimate.plannerOnlyCost).toBeCloseTo(1.00302, 8);
		}
	});

	it.each([
		[undefined, "pricing-missing"],
		[
			{
				capturedAt: "2026-07-30T12:00:00.000Z",
				rates: {
					planner: { ...completeRates.planner, input: 0 },
					executor: completeRates.executor,
				},
			},
			"pricing-zero",
		],
		[
			{
				capturedAt: "2026-07-30T12:00:00.000Z",
				rates: { planner: { input: 1 }, executor: completeRates.executor },
			},
			"pricing-incomplete",
		],
	] as const)("returns unavailable for invalid model metadata %#", (modelMetadata, reason) => {
		const calculation = calculateSavings({
			outcome: "succeeded",
			handoffState: "completed",
			usage: [
				usageSlice(1, "planner-primary", { inputTokens: 1 }),
				usageSlice(2, "executor-primary", { inputTokens: 1, outputTokens: 1 }),
			],
			modelMetadata,
			catalogFallbackEnabled: false,
		});
		expect(calculation.estimate).toEqual({ kind: "unavailable", reason });
	});

	it("uses a dated catalog estimate only when fallback is enabled", () => {
		const usage = [
			usageSlice(1, "planner-primary", { cost: { ...emptyCost, total: 1 } }),
			usageSlice(2, "executor-primary", {
				inputTokens: 100_000,
				cost: { ...emptyCost, total: 0.5 },
			}),
		];
		const catalog = { catalogDate: "2026-07-30", rates: completeRates };
		const disabled = calculateSavings({
			outcome: "succeeded",
			handoffState: "completed",
			usage,
			catalog,
			catalogFallbackEnabled: false,
		});
		const enabled = calculateSavings({
			outcome: "succeeded",
			handoffState: "completed",
			usage,
			catalog,
			catalogFallbackEnabled: true,
		});

		expect(disabled.estimate).toEqual({ kind: "unavailable", reason: "pricing-missing" });
		expect(enabled.estimate).toEqual({
			kind: "catalog-estimated",
			plannerOnlyCost: 2,
			savings: 0.5,
		});
		expect(enabled.pricingEvidence).toEqual({ source: "catalog", catalogDate: "2026-07-30" });
	});

	it.each(["failed", "cancelled"] as const)(
		"retains recorded spend but refuses estimates for %s runs",
		(outcome) => {
			const calculation = calculateSavings({
				outcome,
				handoffState: "completed",
				usage: [usageSlice(1, "planner-primary", { cost: { ...emptyCost, total: 2 } })],
				modelMetadata: {
					capturedAt: "2026-07-30T12:00:00.000Z",
					rates: completeRates,
				},
				catalogFallbackEnabled: false,
			});
			expect(calculation.actualCost).toBe(2);
			expect(calculation.estimate).toEqual({
				kind: "unavailable",
				reason: "run-not-successful",
			});
		},
	);

	it.each(["released", "session-ended"] as const)(
		"keeps a completed handoff comparable when the session %s",
		(outcome) => {
			const calculation = calculateSavings({
				outcome,
				handoffState: "completed",
				usage: [
					usageSlice(1, "planner-primary", { cost: { ...emptyCost, total: 0.5 } }),
					usageSlice(2, "executor-primary", {
						inputTokens: 100_000,
						cost: { ...emptyCost, total: 0.5 },
					}),
				],
				modelMetadata: { capturedAt: "2026-07-30T12:00:00.000Z", rates: completeRates },
				catalogFallbackEnabled: false,
			});

			expect(calculation.estimate).toEqual({
				kind: "session-counterfactual",
				plannerOnlyCost: 1.5,
				savings: 0.5,
			});
		},
	);
});

describe("analytics receipt repricing", () => {
	const strandedReceipt: RunReceipt = {
		...receipt,
		outcome: "session-ended",
		estimate: { kind: "unavailable", reason: "pricing-missing" },
		pricingEvidence: { source: "unavailable", reason: "pricing-missing" },
	};

	it("leaves a stranded receipt uncomparable when it recorded no rates", () => {
		expect(comparisonEstimate(strandedReceipt)).toEqual({
			kind: "unavailable",
			reason: "pricing-missing",
		});
	});

	it("reprices a stranded receipt that recorded its rates", () => {
		const estimate = comparisonEstimate({
			...strandedReceipt,
			pricing: {
				planner: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
				executor: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
			},
		});
		// 10 input and 5 output executor tokens at planner rates, against a
		// recorded primary cost of 0.33 planner + 0.10 executor.
		expect(estimate.kind).toBe("session-counterfactual");
		if (estimate.kind === "unavailable") throw new Error("Expected a priced estimate.");
		expect(estimate.plannerOnlyCost).toBeCloseTo(0.33 + (10 * 5 + 5 * 30) / 1_000_000, 10);
		expect(estimate.savings).toBeCloseTo(estimate.plannerOnlyCost - 0.43, 10);
	});

	it("round-trips recorded rates through receipt serialization", () => {
		const withPricing: RunReceipt = {
			...receipt,
			pricing: {
				planner: {
					input: 5,
					output: 30,
					cacheRead: 0.5,
					cacheWrite: 6.25,
					tiers: [{ inputTokensAbove: 272_000, input: 10, output: 45, cacheRead: 1 }],
				},
				executor: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
			},
		};
		expect(deserializeRunReceipt(serializeRunReceipt(withPricing))).toEqual(withPricing);
	});

	it("rejects an unknown key inside recorded rates", () => {
		expect(() =>
			parseRunReceipt({
				...receipt,
				pricing: { planner: { input: 5, surcharge: 1 }, executor: { input: 0.2 } },
			}),
		).toThrow(/pricing planner/);
	});
});

describe("analytics legacy receipt compatibility", () => {
	it.each(["released", "session-ended", "interrupted"] as const)(
		"still reads a stored %s receipt written before that outcome was comparable",
		(outcome) => {
			const stored = {
				...receipt,
				outcome,
				estimate: { kind: "unavailable", reason: "run-not-successful" },
				pricingEvidence: { source: "unavailable", reason: "run-not-successful" },
			};
			expect(parseRunReceipt(stored).estimate).toEqual({
				kind: "unavailable",
				reason: "pricing-missing",
			});
		},
	);
});
