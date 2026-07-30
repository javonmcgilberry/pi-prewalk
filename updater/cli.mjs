#!/usr/bin/env node

import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isThinkingLevel } from "../src/protocol.mjs";
import {
	createNodeAdapters,
	defaultAgentPaths,
	detectPiInstallation,
	migrateLegacyArtifacts,
} from "./node-adapters.mjs";
import {
	attestationMatches,
	commitOfficialCandidate,
	runRecoveredAction as defaultRunRecoveredAction,
	restoreOfficialFromSource,
	runUpdater,
	siblingPath,
	UpdaterError,
} from "./update.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELP = `Usage: prewalk-update-pi <mode> [--json]\n\nModes:\n  update            Verify official source/npm inputs, build/test/stage, then install the reviewed host patch\n  status            Report supported unpatched, patched, unsupported, damaged, or recovery-required state\n  migrate           Preserve valid config and remove only manifest-identified legacy artifacts\n  uninstall|restore Restore verified official unpatched Pi 0.82.1; never substitute another release\n  recovery-report   Recover an owned interrupted transaction or report a clean state\n  help               Show this help\n\nInitial support is exact: @earendil-works/pi-coding-agent 0.82.1, official commit\nb4f293684bba718d59cc1157679bcf6157b3a7f5, darwin/arm64, and the detected\nnpm-global pi -> @earendil-works/pi-coding-agent/dist/cli.js topology. Unknown\nversions, platforms, package managers, layouts, source shapes, or digests refuse.\n\nEvery operational mode acquires the per-installation lock and resolves a durable\nrecovery journal before its requested action. Update safely extracts verified\narchives into owned staging, runs manifest-pinned gates, validates a same-filesystem\ncandidate, retains a validated backup, and rolls back handled failures. It never\nruns the provider canary or edits saved Pi model/thinking defaults.\n`;

function uniqueStrings(value) {
	return Array.isArray(value)
		? [...new Set(value.filter((item) => typeof item === "string"))]
		: [];
}

export function parseCliArgs(argv) {
	let mode = argv[0] ?? "help";
	if (mode === "--help" || mode === "-h") mode = "help";
	if (mode === "restore") mode = "uninstall";
	const supported = new Set([
		"update",
		"status",
		"migrate",
		"uninstall",
		"recovery-report",
		"help",
	]);
	if (!supported.has(mode)) throw new UpdaterError(`Unknown mode: ${mode}`, "usage");
	let json = false;
	for (const option of argv.slice(1)) {
		if (option === "--json") json = true;
		else throw new UpdaterError(`Unknown option: ${option}`, "usage");
	}
	return { mode, json };
}

export function sanitizeLegacyConfig(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new UpdaterError("Legacy Prewalk config is not a JSON object.", "migration-invalid");
	}
	const record = value;
	const targetPattern = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*$/i;
	if (typeof record.enabled !== "boolean")
		throw new UpdaterError("Legacy enabled value is invalid.", "migration-invalid");
	if (typeof record.target !== "string" || !targetPattern.test(record.target))
		throw new UpdaterError("Legacy target is invalid.", "migration-invalid");
	if (!isThinkingLevel(record.thinkingLevel))
		throw new UpdaterError("Legacy thinking level is invalid.", "migration-invalid");
	const fingerprintPair = /^[a-f0-9]{64}->[a-f0-9]{64}$/;
	return {
		enabled: record.enabled,
		target: record.target,
		thinkingLevel: record.thinkingLevel,
		crossProviderPairs: uniqueStrings(record.crossProviderPairs).filter((pair) =>
			fingerprintPair.test(pair),
		),
	};
}

export async function classifyInstallation({ manifest, installation, adapters }) {
	const attestation = await adapters.attestation.read(installation.packagePath);
	if (attestation !== undefined) {
		if (
			attestationMatches(attestation, manifest) &&
			(await adapters.validatePackage(installation.packagePath, "attested", {
				expectedTreeSha256: attestation.packageTreeSha256,
			}))
		) {
			return { status: "supported-patched", disposition: "supported-patched" };
		}
		return {
			status: "damaged",
			disposition: "damaged",
			reasonCode: "attestation-invalid",
		};
	}
	if (await adapters.validatePackage(installation.packagePath, "official")) {
		return {
			status: "supported-unpatched",
			disposition: "supported-unpatched",
		};
	}
	return {
		status: "damaged",
		disposition: "damaged",
		reasonCode: "package-invalid",
	};
}

async function writeConfig(filePath, value) {
	const temporary = `${filePath}.prewalk-migrate-${process.pid}`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
		mode: 0o600,
	});
	await rename(temporary, filePath);
}

export async function migrateInstallation({ manifest, paths = defaultAgentPaths() }) {
	let config;
	try {
		config = sanitizeLegacyConfig(JSON.parse(await readFile(paths.configPath, "utf8")));
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	if (config) await writeConfig(paths.configPath, config);

	const knownPackageSources = new Set(uniqueStrings(manifest.legacy?.packageSources));
	const removedPackageSources = [];
	const unidentifiedPackageSources = [];
	if (paths.settingsPath) {
		try {
			const settings = JSON.parse(await readFile(paths.settingsPath, "utf8"));
			if (Array.isArray(settings.packages)) {
				const packages = [];
				for (const source of settings.packages) {
					if (typeof source === "string" && knownPackageSources.has(source)) {
						removedPackageSources.push(source);
					} else {
						packages.push(source);
						if (typeof source === "string" && /prewalk/i.test(source))
							unidentifiedPackageSources.push(source);
					}
				}
				if (removedPackageSources.length > 0) {
					await writeConfig(paths.settingsPath, { ...settings, packages });
				}
			}
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
	}

	const knownHashes = uniqueStrings(manifest.legacy?.looseExtensionSha256);
	const artifacts = uniqueStrings([
		...(paths.legacyArtifacts ?? []),
		...(manifest.legacy?.looseExtensionPaths ?? []),
	]);
	const artifactResult = await migrateLegacyArtifacts({
		artifacts,
		knownHashes,
	});
	const needsReview = artifactResult.preserved.length > 0 || unidentifiedPackageSources.length > 0;
	return {
		status: needsReview ? "migration-review-required" : "migrated",
		disposition: needsReview ? "migration-review-required" : "migrated",
		configPreserved: Boolean(config),
		removed: artifactResult.removed,
		preserved: artifactResult.preserved,
		removedPackageSources,
		unidentifiedPackageSources,
	};
}

export async function uninstallInstallation({
	manifest,
	installation,
	adapters,
	patch,
	commitOfficial = commitOfficialCandidate,
	restoreFromSource = restoreOfficialFromSource,
}) {
	const retainedOfficial = siblingPath(installation.packagePath, ".prewalk-backup");
	let result;
	if (
		(await adapters.exists(retainedOfficial)) &&
		(await adapters.validatePackage(retainedOfficial, "official-backup"))
	) {
		result = await commitOfficial({
			manifest,
			installation,
			candidatePath: retainedOfficial,
			ownerId: "retained-official-backup",
			adapters,
		});
	} else {
		if (await adapters.exists(retainedOfficial)) {
			throw new UpdaterError(
				`Retained backup is not verified official Pi 0.82.1: ${retainedOfficial}`,
				"recovery-required",
			);
		}
		result = await restoreFromSource({
			manifest,
			installation,
			patch,
			adapters,
		});
	}
	if (result.status !== "restored") return result;
	const patchedBackup = siblingPath(installation.packagePath, ".prewalk-patched-backup");
	if (await adapters.exists(patchedBackup)) await adapters.removeOwned(patchedBackup);
	await adapters.attestation.clear();
	return result;
}

function recoveryPaths(installation) {
	return [
		installation.packagePath,
		siblingPath(installation.packagePath, ".prewalk-backup"),
		siblingPath(installation.packagePath, ".prewalk-patched-backup"),
		`${installation.packagePath}.prewalk-journal.json`,
	];
}

export async function executeCliMode({
	mode,
	manifest,
	installation,
	adapters,
	patch,
	runRecoveredAction = defaultRunRecoveredAction,
	services = {},
}) {
	if (mode === "update") {
		return runUpdater({ manifest, installation, patch, adapters });
	}
	const outcome = await runRecoveredAction({
		manifest,
		installation,
		adapters,
		action: async () => {
			if (mode === "status") return classifyInstallation({ manifest, installation, adapters });
			if (mode === "migrate") {
				return (services.migrate ?? migrateInstallation)({
					manifest,
					installation,
					adapters,
				});
			}
			if (mode === "uninstall") {
				return (services.uninstall ?? uninstallInstallation)({
					manifest,
					installation,
					adapters,
					patch,
				});
			}
			if (mode === "recovery-report")
				return {
					status: "clean",
					disposition: "clean",
					retainedPaths: recoveryPaths(installation),
				};
			throw new UpdaterError(`Unsupported action mode: ${mode}`, "usage");
		},
	});
	if (outcome.recovery) return outcome.recovery;
	return outcome.value;
}

function humanReport(result) {
	const lines = [`Prewalk Pi updater: ${result.status}`];
	if (result.reasonCode) lines.push(`Reason: ${result.reasonCode}`);
	if (result.manifestId) lines.push(`Manifest: ${result.manifestId}`);
	if (result.removed?.length)
		lines.push(`Removed known legacy artifacts: ${result.removed.join(", ")}`);
	if (result.preserved?.length)
		lines.push(`Preserved ambiguous artifacts: ${result.preserved.join(", ")}`);
	if (result.unidentifiedPackageSources?.length)
		lines.push(
			`Unidentified Prewalk package sources require review: ${result.unidentifiedPackageSources.join(", ")}`,
		);
	if (result.retainedPaths?.length)
		lines.push(`Recovery paths: ${result.retainedPaths.join(", ")}`);
	return `${lines.join("\n")}\n`;
}

export async function runCli({
	argv = process.argv.slice(2),
	stdout = process.stdout,
	stderr = process.stderr,
	executablePath,
	envPath = process.env.PATH,
	platform = process.platform,
	arch = process.arch,
	packageRoot = PACKAGE_ROOT,
} = {}) {
	let args;
	let installation;
	try {
		args = parseCliArgs(argv);
		if (args.mode === "help") {
			stdout.write(HELP);
			return 0;
		}
		installation = await detectPiInstallation({
			executablePath,
			envPath,
			platform,
			arch,
		});
		const manifestDocument = JSON.parse(
			await readFile(path.join(packageRoot, "updater/supported-versions.json"), "utf8"),
		);
		const manifest = manifestDocument.versions["0.82.1"];
		const patch = {
			path: manifest.patch.path,
			contents: await readFile(path.join(packageRoot, manifest.patch.path), "utf8"),
		};
		const adapters = createNodeAdapters({
			installation,
			packageRoot,
			manifest,
		});
		const result = await executeCliMode({
			mode: args.mode,
			manifest,
			installation,
			adapters,
			patch,
		});
		const output = args.json
			? `${JSON.stringify({ ...result, ...(result.status === "recovery-required" ? { retainedPaths: recoveryPaths(installation) } : {}) })}\n`
			: humanReport({
					...result,
					...(result.status === "recovery-required"
						? { retainedPaths: recoveryPaths(installation) }
						: {}),
				});
		([
			"refused",
			"recovery-required",
			"unsupported",
			"damaged",
			"migration-review-required",
		].includes(result.status)
			? stderr
			: stdout
		).write(output);
		return [
			"refused",
			"recovery-required",
			"unsupported",
			"damaged",
			"migration-review-required",
		].includes(result.status)
			? 1
			: 0;
	} catch (error) {
		const status =
			error instanceof UpdaterError && error.code === "recovery-required"
				? "recovery-required"
				: error instanceof UpdaterError && error.code === "unsupported-installation"
					? "unsupported"
					: "refused";
		const result = {
			status,
			disposition: "unchanged",
			reasonCode: error instanceof UpdaterError ? error.code : "unexpected-error",
			...(installation ? { retainedPaths: recoveryPaths(installation) } : {}),
		};
		stderr.write(args?.json ? `${JSON.stringify(result)}\n` : humanReport(result));
		return 1;
	}
}

const invokedPath = process.argv[1]
	? await realpath(process.argv[1]).catch(() => path.resolve(process.argv[1]))
	: undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	process.exitCode = await runCli();
}
