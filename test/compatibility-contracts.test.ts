import { describe, expect, it } from "vitest";
import {
	type CandidateResult,
	failureFingerprint,
	renderLedgerEntry,
	upsertLedger,
	validateCandidateResult,
} from "../scripts/compatibility/contracts.mjs";

const result = {
	version: "0.83.1",
	status: "supported",
	integrity: "sha512-immutable",
	testedAt: "2026-08-04T00:00:00.000Z",
	runId: "12345",
	artifactId: "candidate-0.83.1-12345",
	summary: "All public compatibility checks passed.",
	dependencies: {
		"@howaboua/pi-codex-conversion": "3.0.10",
		"@earendil-works/pi-coding-agent": "0.83.1",
	},
} satisfies CandidateResult;

describe("compatibility reporting contract", () => {
	it("validates bounded data and rejects candidate-controlled extra fields", () => {
		expect(validateCandidateResult(result)).toEqual(result);
		expect(() => validateCandidateResult({ ...result, command: "echo unsafe" })).toThrow(
			"fields are invalid",
		);
		expect(validateCandidateResult({ ...result, version: "0.84.0-beta.1" }).version).toBe(
			"0.84.0-beta.1",
		);
	});

	it("updates one stable ledger marker idempotently without touching another candidate", () => {
		const first = upsertLedger("# Compatibility ledger\n", result);
		const retry = upsertLedger(first, { ...result, summary: "Retry passed." });
		const next = upsertLedger(retry, { ...result, version: "0.83.2", artifactId: "candidate-2" });

		expect(retry.match(/<!-- prewalk-compat:start:0\.83\.1 -->/g)).toHaveLength(1);
		expect(retry).toContain("Retry passed.");
		expect(next).toContain("Pi 0.83.1");
		expect(next).toContain("Pi 0.83.2");
	});

	it("renders escaped markdown-only evidence and stable failure fingerprints", () => {
		const entry = renderLedgerEntry({ ...result, summary: "<script>bad()</script>\n`code`" });
		expect(entry).toContain("@earendil-works/pi-coding-agent@0.83.1");
		expect(entry).not.toContain("<script>");
		expect(entry).toContain("&lt;script&gt;");
		expect(failureFingerprint(result)).toBe(failureFingerprint(structuredClone(result)));
	});
});
