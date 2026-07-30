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
	sourceSuites: string[];
	scenarios: Scenario[];
}

describe("canonical OMP parity matrix", () => {
	it("pins and classifies every current coordinator and degradation scenario", async () => {
		const raw = await readFile(
			new URL("./fixtures/omp-prewalk-parity.json", import.meta.url),
			"utf8",
		);
		const matrix = JSON.parse(raw) as Matrix;

		expect(matrix.revision).toBe("8db0228f4d38ff5d41b30038b6d227b01ea0fc8a");
		expect(matrix.sourceSuites).toHaveLength(2);
		expect(matrix.scenarios).toHaveLength(14);
		expect(new Set(matrix.scenarios.map((scenario) => scenario.upstream)).size).toBe(14);
		expect(
			matrix.scenarios.filter((scenario) => scenario.classification === "excluded"),
		).toHaveLength(4);

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
