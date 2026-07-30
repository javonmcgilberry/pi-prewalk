import { describe, expect, it } from "vitest";
import { createAuditRecord, parseAuditRecord, runFromAudit } from "../src/audit.js";
import type { PrewalkRun } from "../src/core.js";

const run: PrewalkRun = {
	id: "run-1",
	epoch: "epoch-1",
	mode: "automatic",
	phase: "handoff-pending",
	effectiveRoute: "sol",
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
	});
});
