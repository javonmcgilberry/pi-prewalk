/**
 * Verifies that a test can actually fail.
 *
 * A test that cannot fail is worse than no test: it reports safety that does
 * not exist. Two failure modes have already produced false confidence in this
 * repository, and both are silent:
 *
 *   1. The assertion watches the wrong signal. A smoke test checked stderr
 *      while the failure it was meant to catch went to the audit trail, so it
 *      passed against a deliberately broken build.
 *   2. The mutation never applied. A hand-run sed/replace found no match, left
 *      the source untouched, and the "mutated" run passed for that reason.
 *
 * This command removes both. Every mutation must be found before it is applied,
 * and the test must fail once it is. A mutation the test survives is reported as
 * SURVIVED, which means the test does not cover the behavior it claims to.
 *
 * Usage: node scripts/verify-teeth.mjs <spec.json> [--filter <substring>]
 *
 * Spec shape:
 *   {
 *     "test": "npx vitest run test/x.test.ts -t 'name'",
 *     "mutations": [
 *       { "name": "...", "file": "src/y.ts", "find": "...", "replace": "..." }
 *     ]
 *   }
 *
 * `find` must occur exactly once in the file, so a mutation cannot silently hit
 * a different site than intended.
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");

const [specPath, ...rest] = process.argv.slice(2);
if (!specPath) {
	throw new Error("Usage: node scripts/verify-teeth.mjs <spec.json> [--filter <substring>]");
}
const filterIndex = rest.indexOf("--filter");
const filter = filterIndex === -1 ? undefined : rest[filterIndex + 1];

const resolvedSpecPath = path.resolve(packageRoot, specPath);
let spec;
try {
	spec = JSON.parse(await readFile(resolvedSpecPath, "utf8"));
} catch (error) {
	// An unreadable or malformed spec must name itself. Verifying teeth is
	// already a trust exercise, so a vague parse error is the wrong failure.
	throw new Error(
		`Could not read mutation spec ${resolvedSpecPath}: ${error instanceof Error ? error.message : String(error)}`,
	);
}
if (typeof spec.test !== "string" || !Array.isArray(spec.mutations)) {
	throw new Error("Spec needs a `test` command string and a `mutations` array.");
}
for (const [index, mutation] of spec.mutations.entries()) {
	if (
		typeof mutation?.name !== "string" ||
		typeof mutation?.file !== "string" ||
		typeof mutation?.find !== "string" ||
		typeof mutation?.replace !== "string"
	) {
		throw new Error(`mutations[${index}] needs string name, file, find, and replace.`);
	}
}
const mutations = spec.mutations.filter(
	(mutation) => !filter || mutation.name.includes(filter) || mutation.file.includes(filter),
);
if (mutations.length === 0) throw new Error("No mutations matched.");

/** Runs the spec's test command. Resolves true when it passes. */
async function testPasses() {
	try {
		await run("sh", ["-c", spec.test], { cwd: packageRoot, maxBuffer: 32 * 1024 * 1024 });
		return true;
	} catch {
		return false;
	}
}

const results = [];
let baselineOk = false;

try {
	// A mutation result means nothing if the suite is already red.
	baselineOk = await testPasses();
	if (!baselineOk) {
		throw new Error(`Baseline failed. The test must pass before mutation:\n  ${spec.test}`);
	}

	for (const mutation of mutations) {
		const target = path.resolve(packageRoot, mutation.file);
		const original = await readFile(target, "utf8");
		const occurrences = original.split(mutation.find).length - 1;
		if (occurrences !== 1) {
			// Never silently skip. An anchor that moved is a spec bug that would
			// otherwise be indistinguishable from a passing mutation.
			results.push({ name: mutation.name, status: "ANCHOR-NOT-UNIQUE", occurrences });
			continue;
		}
		try {
			await writeFile(target, original.replace(mutation.find, mutation.replace));
			const survived = await testPasses();
			results.push({ name: mutation.name, status: survived ? "SURVIVED" : "CAUGHT" });
		} finally {
			await writeFile(target, original);
		}
	}
} finally {
	// Restoration already happened per mutation; re-assert the suite is green so
	// a crashed run cannot leave a mutated tree behind unnoticed.
	if (baselineOk && !(await testPasses())) {
		console.error("WARNING: the test does not pass after restoration. Check `git status`.");
	}
}

const bad = results.filter((result) => result.status !== "CAUGHT");
for (const result of results) {
	const detail = result.occurrences === undefined ? "" : ` (found ${result.occurrences}x, need 1)`;
	console.log(`${result.status.padEnd(18)} ${result.name}${detail}`);
}
console.log(`\n${results.length - bad.length}/${results.length} mutations caught.`);
if (bad.length > 0) {
	console.error(
		"\nA SURVIVED mutation means the test passes with the behavior broken.\n" +
			"An ANCHOR-NOT-UNIQUE mutation never ran; fix the spec before trusting it.",
	);
	process.exitCode = 1;
}
