import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isRecord, isString } from "../value-contracts.mjs";
import {
	CONVERSION_PACKAGE,
	candidateVersion,
	PI_PACKAGES,
	validateCandidateResult,
} from "./contracts.mjs";

function readInstalledTree() {
	return JSON.parse(execFileSync("npm", ["ls", "--json", "--depth=0"], { encoding: "utf8" }));
}

export function installedDependencies(tree, version) {
	if (!candidateVersion(version)) throw new Error("candidate version is invalid");
	if (!isRecord(tree) || !isRecord(tree.dependencies)) {
		throw new Error("installed dependency tree is invalid");
	}

	const dependencies = {};
	for (const packageName of [...PI_PACKAGES, CONVERSION_PACKAGE]) {
		const packageInfo = tree.dependencies[packageName];
		if (!isRecord(packageInfo) || !isString(packageInfo.version)) {
			throw new Error(`installed dependency is missing: ${packageName}`);
		}
		dependencies[packageName] = packageInfo.version;
	}

	validateCandidateResult({
		version,
		status: "pending",
		integrity: "placeholder",
		testedAt: "placeholder",
		runId: "placeholder",
		artifactId: "placeholder",
		summary: "",
		dependencies,
	});
	return dependencies;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const [version] = process.argv.slice(2);
	if (!version) throw new Error("usage: installed-dependencies.mjs <candidate-version>");
	process.stdout.write(`${JSON.stringify(installedDependencies(readInstalledTree(), version))}\n`);
}
