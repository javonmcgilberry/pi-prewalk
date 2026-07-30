import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateManifest } from "./benchmark-contract.mjs";
import { unblindFrozenMetrics, verifyFrozenMetrics } from "./benchmark-report-lib.mjs";

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const name = argv[index];
		if (
			![
				"--manifest",
				"--schedule",
				"--raw-results",
				"--lock",
				"--metrics",
				"--unblinding",
				"--output",
			].includes(name)
		) {
			throw new Error(`Unknown benchmark report option: ${name}`);
		}
		const value = argv[++index];
		if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
		options[name.slice(2)] = path.resolve(value);
	}
	for (const name of ["schedule", "raw-results", "lock", "metrics", "unblinding", "output"]) {
		if (!options[name]) throw new Error(`Benchmark report requires --${name}.`);
	}
	return options;
}

const packageRoot = path.resolve(import.meta.dirname, "..");
const options = parseArgs(process.argv.slice(2));
const manifest = validateManifest(
	JSON.parse(
		await readFile(
			options.manifest ?? path.join(packageRoot, "benchmark", "corpus.json"),
			"utf8",
		),
	),
);
const frozen = JSON.parse(await readFile(options.metrics, "utf8"));
const schedule = JSON.parse(await readFile(options.schedule, "utf8"));
const rows = (await readFile(options["raw-results"], "utf8"))
	.trim()
	.split(/\r?\n/)
	.filter(Boolean)
	.map((line) => JSON.parse(line));
const lock = JSON.parse(await readFile(options.lock, "utf8"));
const unblinding = JSON.parse(await readFile(options.unblinding, "utf8"));
verifyFrozenMetrics(manifest, schedule, rows, lock, frozen);
const report = unblindFrozenMetrics(manifest, frozen, unblinding);
await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, {
	mode: 0o400,
	flag: "wx",
});
console.log(JSON.stringify({ releasePassed: report.releasePassed, outputPath: options.output }));
