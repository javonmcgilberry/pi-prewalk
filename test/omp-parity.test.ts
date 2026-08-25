import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type Classification =
	| "direct"
	| "forced-pi-adaptation"
	| "chosen-divergence"
	| "addition"
	| "unknown";

interface Scenario {
	upstream: string;
	source: string;
	bodySha256: string;
	classification: Classification;
	local?: string;
	rationale?: string;
}

interface Matrix {
	schemaVersion: 2;
	revision: string;
	promptSourceRevision: string;
	promptAssets: Record<string, { source: string; sha256: string }>;
	sourceSuites: string[];
	scenarios: Scenario[];
}

const behaviorRevision = "969a94c1eeccb1b7528cd5621934bca1908ab622";
const promptSourceRevision = "c101452bb5a6eb40490efc0d49035f201ee5aa21";
const promptHashes = new Map([
	["prewalk-plan.md", "5daf4e727817fafa94fe4a1fcb84905da66aa28358328329a6eccc0aae8a41ee"],
	["prewalk-checklist.md", "0d4897f505957ff5e0466fe43f5e681e1b373eb8789c2ca976ea08deaa11d1cb"],
	["prewalk-continue.md", "769599ce9fc5db930b2db47dccd1d98e7528e720a35520ea8039b4acb4c97955"],
]);

describe("pinned OMP behavior parity matrix", () => {
	it("keeps scenario behavior and copied prompt provenance as separate authorities", async () => {
		const raw = await readFile(
			new URL("./fixtures/omp-prewalk-parity.json", import.meta.url),
			"utf8",
		);
		const matrix = JSON.parse(raw) as Matrix;

		expect(matrix.revision).toBe(behaviorRevision);
		expect(matrix.schemaVersion).toBe(2);
		expect(matrix.promptSourceRevision).toBe(promptSourceRevision);
		expect(matrix.promptSourceRevision).not.toBe(matrix.revision);
		expect(Object.keys(matrix.promptAssets)).toEqual([...promptHashes.keys()]);
		for (const [name, hash] of promptHashes) {
			expect(matrix.promptAssets[name]).toEqual({
				source: `packages/coding-agent/src/prompts/system/${name}`,
				sha256: hash,
			});
		}

		expect(matrix.sourceSuites).toHaveLength(2);
		expect(matrix.scenarios).toHaveLength(21);
		expect(new Set(matrix.scenarios.map((scenario) => scenario.upstream)).size).toBe(21);
		expect(new Set(matrix.scenarios.map((scenario) => scenario.source))).toEqual(
			new Set(matrix.sourceSuites),
		);
		expect(
			matrix.scenarios.filter((scenario) => scenario.classification === "direct").length,
		).toBe(10);
		expect(
			matrix.scenarios.filter((scenario) => scenario.classification === "forced-pi-adaptation")
				.length,
		).toBe(10);
		expect(
			matrix.scenarios.filter((scenario) => scenario.classification === "chosen-divergence")
				.length,
		).toBe(1);

		for (const scenario of matrix.scenarios) {
			expect(scenario.bodySha256).toMatch(/^[a-f0-9]{64}$/);
			if (scenario.classification === "direct") {
				expect(scenario.local).toMatch(/^test\/.+\.test\.ts$/);
				await access(new URL(`../${scenario.local}`, import.meta.url));
			} else {
				expect(scenario.rationale?.length).toBeGreaterThan(20);
			}
		}

		const automaticRows = matrix.scenarios.filter((scenario) =>
			/arm|re-arm|restoring|configured auth/i.test(scenario.upstream),
		);
		expect(automaticRows.map((scenario) => scenario.upstream)).toEqual(
			expect.arrayContaining([
				"armPrewalk (the /prewalk slash command) pre-arms the switch for the very next edit/write",
				"does not implicitly re-arm configured prewalk while restoring a session",
				"honors an explicit prewalk flag while restoring a session",
			]),
		);
	});
});
