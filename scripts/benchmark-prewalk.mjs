import { readFile } from "node:fs/promises";
import path from "node:path";
import {
	parseBenchmarkArgs,
	validateBenchmarkOptions,
	validateManifest,
} from "./benchmark-contract.mjs";
import { executeBenchmark } from "./benchmark-controller.mjs";
import { createBenchmarkRuntime } from "./benchmark-runtime.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const options = validateBenchmarkOptions(parseBenchmarkArgs(process.argv.slice(2)));
const manifestPath = path.resolve(
	options.manifestPath ?? path.join(packageRoot, "benchmark", "corpus.json"),
);
const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
if (options.repetitions !== undefined && options.repetitions !== manifest.repetitions) {
	throw new Error(`Benchmark requires exactly ${manifest.repetitions} repetitions.`);
}
const runtime = createBenchmarkRuntime({
	authFile: options.authFile,
	piExecutable: options.piExecutable,
	protocol: manifest.protocol,
});
const result = await executeBenchmark({
	manifest,
	outputDirectory: options.outputDirectory,
	controlDirectory: options.controlDirectory,
	confirmation: options.confirmation,
	runtime,
});
console.log(JSON.stringify({ ok: true, runCount: result.runCount, metrics: result.metricsPath }));
