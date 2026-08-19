import { describe, expect, it } from "vitest";
import { DEFAULT_ANALYTICS_CONFIG } from "../../src/analytics/index.js";
import {
	DEFAULT_EXECUTOR,
	DEFAULT_PLANNER,
	DEFAULT_PLANNER_RECOVERY_CONFIG,
	type PrewalkRun,
} from "../../src/orchestration/coordinator.js";
import {
	createAuditRecord,
	createAutoModeRecord,
	parseAuditRecord,
	parseAutoModeRecord,
	runFromAudit,
} from "../../src/session/audit.js";

const run: PrewalkRun = {
	id: "run-1",
	epoch: "epoch-1",
	mode: "automatic",
	phase: "handoff-pending",
	effectiveRoute: "planner",
	planner: { ...DEFAULT_PLANNER, reasoning: "high" },
	config: {
		executor: { ...DEFAULT_EXECUTOR },
		plannerRecovery: { maxRetries: 2 },
		analytics: {
			...DEFAULT_ANALYTICS_CONFIG,
			catalogFallbackEnabled: true,
			recentReceiptCount: 7,
		},
	},
	planningPromptInjected: true,
	continuePending: false,
	todoActive: true,
	todoSeen: true,
	trigger: { toolCallId: "call-1", toolName: "edit" },
};

describe("Prewalk audit records", () => {
	it("round-trips only the allowlisted run state", () => {
		const record = createAuditRecord(run, "handoff-triggered");
		expect(parseAuditRecord(record)).toEqual(record);
		expect(runFromAudit(record)).toEqual(run);
		expect(Object.keys(record).sort()).toEqual([
			"analytics",
			"continuePending",
			"effectiveRoute",
			"epoch",
			"event",
			"executor",
			"mode",
			"overlay",
			"phase",
			"planner",
			"plannerRecovery",
			"planningPromptInjected",
			"runId",
			"schemaVersion",
			"todoActive",
			"todoSeen",
			"trigger",
		]);
	});

	it("migrates version 3 recovery settings to the current default", () => {
		const record = createAuditRecord(run, "planning-retry");
		const { plannerRecovery: _plannerRecovery, ...previous } = record;
		const migrated = parseAuditRecord({ ...previous, schemaVersion: 3 });

		expect(migrated?.plannerRecovery).toEqual(DEFAULT_PLANNER_RECOVERY_CONFIG);
		if (!migrated) throw new Error("Expected the version 3 audit record to migrate.");
		expect(runFromAudit(migrated)).toMatchObject({
			config: { plannerRecovery: DEFAULT_PLANNER_RECOVERY_CONFIG },
		});
	});

	it("round-trips terminal lifecycle markers without changing run-state fields", () => {
		for (const event of ["completed", "session-ended"] as const) {
			const record = createAuditRecord(run, event);
			expect(parseAuditRecord(record)).toEqual(record);
		}
	});

	it("round-trips a cross-provider run and binds the executor provider", () => {
		const crossProviderRun: PrewalkRun = {
			...run,
			config: {
				...run.config,
				executor: { ...run.config.executor, provider: "google" },
			},
		};
		const record = createAuditRecord(crossProviderRun, "handoff-triggered");

		expect(parseAuditRecord(record)).toEqual(record);
		expect(runFromAudit(record)).toEqual(crossProviderRun);
		const legacyRecord = {
			...record,
			schemaVersion: 2,
			overlay: `${record.planner.provider}:${record.planner.model}>${record.executor.model}:${record.executor.reasoning}:v1`,
		};
		const migrated = parseAuditRecord(legacyRecord);
		expect(migrated).toMatchObject({
			schemaVersion: record.schemaVersion,
			executor: record.executor,
		});
		expect(
			parseAuditRecord({
				...record,
				executor: { ...record.executor, provider: "anthropic" },
			}),
		).toBeUndefined();
	});

	it("rejects unknown fields, raw errors, and unsupported reasons", () => {
		const record = createAuditRecord(run, "handoff-triggered");
		expect(parseAuditRecord({ ...record, headers: { authorization: "secret" } })).toBeUndefined();
		expect(parseAuditRecord({ ...record, rawError: "/private/path" })).toBeUndefined();
		expect(parseAuditRecord({ ...record, reasonCode: "raw provider error" })).toBeUndefined();
		expect(parseAuditRecord({ ...record, analytics: { enabled: "yes" } })).toBeUndefined();
	});

	it("migrates version 2 audit records without inventing analytics settings", () => {
		const record = createAuditRecord(run, "handoff-triggered");
		const { analytics: _analytics, ...current } = record;
		const legacy = {
			...current,
			schemaVersion: 2,
			overlay: `${record.planner.provider}:${record.planner.model}>${record.executor.model}:${record.executor.reasoning}:v1`,
		};
		const parsed = parseAuditRecord(legacy);
		expect(parsed).toMatchObject({
			schemaVersion: record.schemaVersion,
			executor: record.executor,
		});
		expect(runFromAudit(parsed as NonNullable<typeof parsed>).config.analytics).toBeUndefined();
	});

	it("round-trips only versioned, session-bound automatic mode", () => {
		const record = createAutoModeRecord("session-1", true);
		expect(parseAutoModeRecord(record)).toEqual(record);
		expect(parseAutoModeRecord({ ...record, extra: true })).toBeUndefined();
		expect(parseAutoModeRecord({ ...record, sessionId: "" })).toBeUndefined();
	});
});
