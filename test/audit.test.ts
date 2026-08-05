import { describe, expect, it } from "vitest";
import { DEFAULT_ANALYTICS_CONFIG } from "../src/analytics.js";
import {
	createAuditRecord,
	createAutoModeRecord,
	parseAuditRecord,
	parseAutoModeRecord,
	runFromAudit,
} from "../src/audit.js";
import { DEFAULT_EXECUTOR, DEFAULT_PLANNER, type PrewalkRun } from "../src/core.js";

const run: PrewalkRun = {
	id: "run-1",
	epoch: "epoch-1",
	mode: "automatic",
	phase: "handoff-pending",
	effectiveRoute: "planner",
	planner: { ...DEFAULT_PLANNER, reasoning: "high" },
	config: {
		executor: { ...DEFAULT_EXECUTOR },
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
			"planningPromptInjected",
			"runId",
			"schemaVersion",
			"todoActive",
			"todoSeen",
			"trigger",
		]);
	});

	it("rejects unknown fields, raw errors, and unsupported reasons", () => {
		const record = createAuditRecord(run, "handoff-triggered");
		expect(parseAuditRecord({ ...record, headers: { authorization: "secret" } })).toBeUndefined();
		expect(parseAuditRecord({ ...record, rawError: "/private/path" })).toBeUndefined();
		expect(parseAuditRecord({ ...record, reasonCode: "raw provider error" })).toBeUndefined();
		expect(parseAuditRecord({ ...record, analytics: { enabled: "yes" } })).toBeUndefined();
	});

	it("keeps older audit records readable without inventing analytics settings", () => {
		const record = createAuditRecord(run, "handoff-triggered");
		const { analytics: _analytics, ...legacy } = record;
		const parsed = parseAuditRecord(legacy);
		expect(parsed).toBeDefined();
		expect(runFromAudit(parsed as NonNullable<typeof parsed>).config.analytics).toBeUndefined();
	});

	it("round-trips only versioned, session-bound automatic mode", () => {
		const record = createAutoModeRecord("session-1", true);
		expect(parseAutoModeRecord(record)).toEqual(record);
		expect(parseAutoModeRecord({ ...record, extra: true })).toBeUndefined();
		expect(parseAutoModeRecord({ ...record, sessionId: "" })).toBeUndefined();
	});
});
