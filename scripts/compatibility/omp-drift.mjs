import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const reportOnly = args.includes("--report-only");
const positional = args.filter((arg) => arg !== "--report-only");
const [ompRoot, output] = positional;
if (!ompRoot || !output) {
	throw new Error("usage: omp-drift.mjs <omp-checkout> <output.json> [--report-only]");
}

const fixture = JSON.parse(await readFile("test/fixtures/omp-prewalk-parity.json", "utf8"));

function decodeTestName(raw) {
	return raw.replace(/\\([\\'"`])/g, "$1");
}

function extractTestCases(source) {
	const cases = [];
	const declaration = /\b(?:it|test)(?:\.each)?\s*\(\s*(["'`])/g;
	while (true) {
		const match = declaration.exec(source);
		if (!match) break;
		const quote = match[1];
		let index = declaration.lastIndex;
		let rawName = "";
		let escaped = false;
		for (; index < source.length; index += 1) {
			const character = source[index];
			if (escaped) {
				rawName += `\\${character}`;
				escaped = false;
			} else if (character === "\\") {
				escaped = true;
			} else if (character === quote) {
				break;
			} else {
				rawName += character;
			}
		}
		if (index >= source.length) continue;
		let callback = index + 1;
		while (/\s/.test(source[callback] ?? "")) callback += 1;
		if (source[callback] !== ",") continue;
		callback += 1;
		while (/\s/.test(source[callback] ?? "")) callback += 1;
		const bodyStart = source.indexOf("{", callback);
		if (bodyStart < 0) continue;

		let depth = 0;
		let state = "code";
		let stringQuote = "";
		escaped = false;
		let bodyEnd = -1;
		for (let cursor = bodyStart; cursor < source.length; cursor += 1) {
			const character = source[cursor];
			const next = source[cursor + 1];
			if (state === "code") {
				if (character === "/" && next === "/") {
					state = "line-comment";
					cursor += 1;
				} else if (character === "/" && next === "*") {
					state = "block-comment";
					cursor += 1;
				} else if (["'", '"', "`"].includes(character)) {
					state = "string";
					stringQuote = character;
					escaped = false;
				} else if (character === "{") {
					depth += 1;
				} else if (character === "}" && --depth === 0) {
					bodyEnd = cursor + 1;
					break;
				}
			} else if (state === "line-comment") {
				if (character === "\n") state = "code";
			} else if (state === "block-comment") {
				if (character === "*" && next === "/") {
					state = "code";
					cursor += 1;
				}
			} else if (escaped) {
				escaped = false;
			} else if (character === "\\") {
				escaped = true;
			} else if (character === stringQuote) {
				state = "code";
			}
		}
		if (bodyEnd < 0) continue;
		cases.push({
			name: decodeTestName(rawName),
			bodySha256: createHash("sha256").update(source.slice(bodyStart, bodyEnd)).digest("hex"),
		});
	}
	return cases;
}

let currentRevision = process.env.OMP_CURRENT_REVISION ?? "unknown";
if (currentRevision === "unknown") {
	try {
		currentRevision = execFileSync("git", ["-C", ompRoot, "rev-parse", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		// An exported source tree has no Git metadata; content checks still work.
	}
}

const promptChanges = [];
for (const [name, asset] of Object.entries(fixture.promptAssets)) {
	const bytes = await readFile(path.join(ompRoot, asset.source));
	const currentSha256 = createHash("sha256").update(bytes).digest("hex");
	if (currentSha256 !== asset.sha256) {
		promptChanges.push({ name, source: asset.source, pinnedSha256: asset.sha256, currentSha256 });
	}
}

const currentCases = [];
for (const source of fixture.sourceSuites) {
	const text = await readFile(path.join(ompRoot, source), "utf8");
	for (const testCase of extractTestCases(text)) currentCases.push({ source, ...testCase });
}
const key = (source, name) => `${source}\u0000${name}`;
const pinned = new Map(
	fixture.scenarios.map((scenario) => [key(scenario.source, scenario.upstream), scenario]),
);
const current = new Map(
	currentCases.map((testCase) => [key(testCase.source, testCase.name), testCase]),
);
const addedScenarios = currentCases
	.filter((testCase) => !pinned.has(key(testCase.source, testCase.name)))
	.map(({ source, name }) => ({ source, name }));
const missingScenarios = fixture.scenarios
	.filter((scenario) => !current.has(key(scenario.source, scenario.upstream)))
	.map(({ source, upstream: name }) => ({ source, name }));
const bodyChanges = fixture.scenarios.flatMap((scenario) => {
	const currentCase = current.get(key(scenario.source, scenario.upstream));
	return currentCase && currentCase.bodySha256 !== scenario.bodySha256
		? [
				{
					source: scenario.source,
					name: scenario.upstream,
					pinnedSha256: scenario.bodySha256,
					currentSha256: currentCase.bodySha256,
				},
			]
		: [];
});
const revisionChanged = currentRevision !== "unknown" && currentRevision !== fixture.revision;
const fingerprint = createHash("sha256")
	.update(
		JSON.stringify({
			fixtureRevision: fixture.revision,
			currentRevision,
			revisionChanged,
			promptChanges,
			addedScenarios,
			missingScenarios,
			bodyChanges,
		}),
	)
	.digest("hex");
const drift = {
	schemaVersion: 2,
	pinnedRevision: fixture.revision,
	currentRevision,
	revisionChanged,
	promptChanges,
	addedScenarios,
	missingScenarios,
	bodyChanges,
	fingerprint,
	reportOnly,
};
await writeFile(output, `${JSON.stringify(drift, null, 2)}\n`);

const hasDrift =
	revisionChanged ||
	promptChanges.length > 0 ||
	addedScenarios.length > 0 ||
	missingScenarios.length > 0 ||
	bodyChanges.length > 0;
if (hasDrift && !reportOnly) {
	console.error(
		`OMP parity drift detected; see ${output}. Refresh or classify the fixture before landing.`,
	);
	process.exitCode = 1;
}
