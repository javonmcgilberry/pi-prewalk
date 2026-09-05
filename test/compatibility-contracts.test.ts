import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
	type CandidateResult,
	CONVERSION_PACKAGE,
	failureFingerprint,
	PI_PACKAGES,
	renderLedgerEntry,
	upsertLedger,
	validateCandidateResult,
} from "../scripts/compatibility/contracts.mjs";
import { installedDependencies } from "../scripts/compatibility/installed-dependencies.mjs";

function dependenciesFor(version: string): Record<string, string> {
	return Object.fromEntries([
		...PI_PACKAGES.map((packageName) => [packageName, version]),
		[CONVERSION_PACKAGE, "3.0.10"],
	]);
}

const result = {
	version: "0.83.1",
	status: "supported",
	integrity: "sha512-immutable",
	testedAt: "2026-08-04T00:00:00.000Z",
	runId: "12345",
	artifactId: "candidate-0.83.1-12345",
	summary: "All public compatibility checks passed.",
	dependencies: dependenciesFor("0.83.1"),
} satisfies CandidateResult;

describe("compatibility reporting contract", () => {
	it("validates bounded data and rejects candidate-controlled extra fields", () => {
		expect(validateCandidateResult(result)).toEqual(result);
		expect(() => validateCandidateResult({ ...result, command: "echo unsafe" })).toThrow(
			"fields are invalid",
		);
		expect(
			validateCandidateResult({
				...result,
				version: "0.84.0-beta.1",
				dependencies: dependenciesFor("0.84.0-beta.1"),
			}).version,
		).toBe("0.84.0-beta.1");
	});

	it("requires the exact installed dependency pair and matching Pi candidate", () => {
		expect(() =>
			validateCandidateResult({
				...result,
				dependencies: {
					...dependenciesFor("0.83.1"),
					"@earendil-works/pi-coding-agent": "0.83.0",
				},
			}),
		).toThrow("Pi dependency must match candidate version");
		expect(() =>
			validateCandidateResult({
				...result,
				dependencies: {
					"@earendil-works/pi-coding-agent": "0.83.1",
				},
			}),
		).toThrow("dependency keys are invalid");
		expect(() =>
			validateCandidateResult({
				...result,
				dependencies: { ...dependenciesFor("0.83.1"), [CONVERSION_PACKAGE]: "not-semver" },
			}),
		).toThrow("dependency version is invalid");
	});

	it("extracts every installed Pi package and the optional Conversion version", () => {
		const dependencies = Object.fromEntries(
			Object.entries(result.dependencies).map(([name, version]) => [name, { version }]),
		);
		expect(installedDependencies({ dependencies }, result.version)).toEqual(result.dependencies);
		expect(() =>
			installedDependencies(
				{ dependencies: { ...dependencies, "@earendil-works/pi-tui": undefined } },
				result.version,
			),
		).toThrow("installed dependency is missing: @earendil-works/pi-tui");
	});

	it("makes the compatibility workflow report extracted dependency metadata", async () => {
		const workflow = await readFile(
			new URL("../.github/workflows/pi-compatibility.yml", import.meta.url),
			"utf8",
		);
		expect(workflow).toContain("installed-dependencies.mjs");
		expect(workflow).toContain("const dependencies=JSON.parse");
		expect(workflow).not.toContain('"@howaboua/pi-codex-conversion":"3.0.3"');
	});

	it("updates one stable ledger marker idempotently without touching another candidate", () => {
		const first = upsertLedger("# Compatibility ledger\n", result);
		const retry = upsertLedger(first, { ...result, summary: "Retry passed." });
		const next = upsertLedger(retry, {
			...result,
			version: "0.83.2",
			artifactId: "candidate-2",
			dependencies: dependenciesFor("0.83.2"),
		});

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
