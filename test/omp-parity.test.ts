import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface Scenario {
	upstream: string;
	classification: "direct" | "pi-adapted" | "excluded";
	local?: string;
	rationale?: string;
}

interface Matrix {
	revision: string;
	promptAssets: Record<string, { source: string; sha256: string }>;
	sourceSuites: string[];
	scenarios: Scenario[];
}

const revision = "39477ba39bfbdc6be2cfff0efde979dd32bd7eb7";
const promptHashes = new Map([
	["prewalk-plan.md", "0a7442a41c2d8554f0683ac947323bc8a20d2cd6ebda049a9d9df323f2471a78"],
	["prewalk-checklist.md", "045383ef934fe8afc7b0c13ad647caf9ad0aed4d6f1af594657a968aabe660d1"],
	["prewalk-continue.md", "9af48cebe3490c679a6670968b8d59ed418d4a9a374a8d99f9be1165c93478f0"],
]);

describe("canonical OMP parity matrix", () => {
	it("pins and classifies every current coordinator and degradation scenario", async () => {
		const raw = await readFile(
			new URL("./fixtures/omp-prewalk-parity.json", import.meta.url),
			"utf8",
		);
		const matrix = JSON.parse(raw) as Matrix;

		expect(matrix.revision).toBe(revision);
		expect(Object.keys(matrix.promptAssets)).toEqual([...promptHashes.keys()]);
		for (const [name, hash] of promptHashes) {
			expect(matrix.promptAssets[name]).toEqual({
				source: `packages/coding-agent/src/prompts/system/${name}`,
				sha256: hash,
			});
		}
		expect(matrix.sourceSuites).toHaveLength(2);
		expect(matrix.scenarios).toHaveLength(19);
		expect(new Set(matrix.scenarios.map((scenario) => scenario.upstream)).size).toBe(19);
		expect(
			matrix.scenarios.filter((scenario) => scenario.classification === "excluded"),
		).toHaveLength(5);

		for (const scenario of matrix.scenarios) {
			if (scenario.classification === "excluded") {
				expect(scenario.rationale?.length).toBeGreaterThan(20);
			} else {
				expect(scenario.local).toMatch(/^test\/.+\.test\.ts$/);
				await access(new URL(`../${scenario.local}`, import.meta.url));
			}
		}
	});
});
