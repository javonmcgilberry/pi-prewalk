import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [ompRoot, output] = process.argv.slice(2);
if (!ompRoot || !output) throw new Error("usage: omp-drift.mjs <omp-checkout> <output.json>");
const fixture = JSON.parse(await readFile("test/fixtures/omp-prewalk-parity.json", "utf8"));
const promptChanges = [];
for (const [name, asset] of Object.entries(fixture.promptAssets)) {
	const bytes = await readFile(path.join(ompRoot, asset.source));
	const currentSha256 = createHash("sha256").update(bytes).digest("hex");
	if (currentSha256 !== asset.sha256) {
		promptChanges.push({ name, source: asset.source, pinnedSha256: asset.sha256, currentSha256 });
	}
}
const scenarioNames = [];
for (const source of fixture.sourceSuites) {
	const text = await readFile(path.join(ompRoot, source), "utf8");
	for (const match of text.matchAll(/\bit\(\s*["'`]([^"'`]+)["'`]/g)) scenarioNames.push(match[1]);
}
const pinnedNames = fixture.scenarios.map((scenario) => scenario.upstream);
const addedScenarios = scenarioNames.filter((name) => !pinnedNames.includes(name));
const missingScenarios = pinnedNames.filter((name) => !scenarioNames.includes(name));
const currentRevision = process.env.OMP_CURRENT_REVISION ?? "unknown";
const fingerprint = createHash("sha256")
	.update(
		JSON.stringify({
			pinned: fixture.revision,
			currentRevision,
			promptChanges,
			addedScenarios,
			missingScenarios,
		}),
	)
	.digest("hex");
await writeFile(
	output,
	`${JSON.stringify(
		{
			schemaVersion: 1,
			pinnedRevision: fixture.revision,
			currentRevision,
			promptChanges,
			addedScenarios,
			missingScenarios,
			xdMutationTierScenarios: pinnedNames.filter((name) => name.includes("xd://")),
			fingerprint,
			reportOnly: true,
		},
		null,
		2,
	)}\n`,
);
