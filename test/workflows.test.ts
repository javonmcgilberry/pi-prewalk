import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function workflow(name: string): Promise<string> {
	return readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
}

describe("automation trust boundaries", () => {
	it("keeps ordinary and candidate checks read-only and credential-free", async () => {
		const check = await workflow("check.yml");
		const candidates = await workflow("pi-compatibility.yml");
		for (const source of [check, candidates]) {
			expect(source).toContain("contents: read");
			expect(source).toContain("persist-credentials: false");
			expect(source).not.toMatch(/issues:\s*write/);
			expect(source).not.toMatch(/secrets\./);
		}
		expect(candidates).toContain("--ignore-scripts");
		expect(candidates).toContain("$RUNNER_TEMP/prewalk-candidate");
		expect(candidates).toContain("npm_config_offline=true");
		expect(candidates).toContain("timeout 15m");
		expect(candidates).toContain("tail -c 2000");
		expect(candidates).toContain("retention-days: 30");
	});

	it("isolates issue writing in reporters that only consume validated artifacts", async () => {
		const reporter = await workflow("pi-compatibility-report.yml");
		expect(reporter).toContain("issues: write");
		expect(reporter).toContain("validate-result.mjs");
		expect(reporter).toContain("--body-file");
		expect(reporter).not.toMatch(/eval\s/);
		expect(reporter).not.toMatch(/npm (?:install|ci)/);
	});

	it("keeps OMP drift report-only and never changes pinned assets", async () => {
		const drift = await workflow("omp-drift.yml");
		expect(drift).toContain("omp-drift.mjs");
		expect(drift).toContain("Human classification required");
		expect(drift).not.toMatch(/git\s+(?:commit|push|merge)/);
		expect(drift).not.toMatch(/npm publish|gh pr merge/);
	});
});
