import path from "node:path";

const JOURNAL_SCHEMA_VERSION = 1;
const PHASES = new Set(["prepared", "backup-active", "candidate-active"]);
const TARGETS = new Set(["patched", "official"]);
const GATE_ORDER = ["test", "build", "pack", "install", "candidate"];
const SOURCE_ARCHIVE_BASE_URL = "https://codeload.github.com/earendil-works/pi/tar.gz/";

export class UpdaterError extends Error {
	constructor(message, code = "refused", details) {
		super(message);
		this.name = "UpdaterError";
		this.code = code;
		this.details = details;
	}
}

export class InjectedCrashError extends Error {
	constructor(failpoint) {
		super(`Injected updater crash at ${failpoint}`);
		this.name = "InjectedCrashError";
		this.failpoint = failpoint;
	}
}

function assert(condition, message, code = "manifest-invalid") {
	if (!condition) throw new UpdaterError(message, code);
}

function normalizeArchivePath(value) {
	assert(
		typeof value === "string" && value.length > 0,
		"Archive entry path is missing.",
		"archive-unsafe",
	);
	assert(
		!/^[A-Za-z]:[\\/]/.test(value),
		`Archive entry uses a drive path: ${value}`,
		"archive-unsafe",
	);
	const slashPath = value.replaceAll("\\", "/");
	assert(
		!path.posix.isAbsolute(slashPath),
		`Archive entry is absolute: ${value}`,
		"archive-unsafe",
	);
	const normalized = path.posix.normalize(slashPath);
	assert(
		normalized !== "." && normalized !== ".." && !normalized.startsWith("../"),
		`Archive entry escapes staging: ${value}`,
		"archive-unsafe",
	);
	return normalized;
}

function strippedArchivePath(normalized, stripComponents) {
	assert(
		Number.isInteger(stripComponents) && stripComponents >= 0,
		"Archive strip-components value is invalid.",
		"archive-unsafe",
	);
	const parts = normalized.split("/");
	return parts.length <= stripComponents ? undefined : parts.slice(stripComponents).join("/");
}

export function validateArchiveEntries(entries, stripComponents = 0) {
	assert(Array.isArray(entries), "Archive entry list is invalid.", "archive-unsafe");
	return entries.map((entry) => {
		assert(entry && typeof entry === "object", "Archive entry is invalid.", "archive-unsafe");
		const normalizedPath = normalizeArchivePath(entry.path);
		const effectivePath = strippedArchivePath(normalizedPath, stripComponents);
		const type = entry.type ?? "file";
		if ((type === "symlink" || type === "hardlink") && effectivePath) {
			assert(
				typeof entry.linkPath === "string",
				`Archive ${type} target is missing.`,
				"archive-unsafe",
			);
			assert(
				!/^[A-Za-z]:[\\/]/.test(entry.linkPath),
				`Archive ${type} uses a drive target.`,
				"archive-unsafe",
			);
			const slashTarget = entry.linkPath.replaceAll("\\", "/");
			assert(
				!path.posix.isAbsolute(slashTarget),
				`Archive ${type} target is absolute.`,
				"archive-unsafe",
			);
			const effectiveTarget =
				type === "hardlink"
					? strippedArchivePath(normalizeArchivePath(slashTarget), stripComponents)
					: slashTarget;
			assert(effectiveTarget, `Archive ${type} target is stripped away.`, "archive-unsafe");
			const base = type === "symlink" ? path.posix.dirname(effectivePath) : ".";
			const resolved = path.posix.normalize(path.posix.join(base, effectiveTarget));
			assert(
				resolved !== ".." && !resolved.startsWith("../"),
				`Archive ${type} target escapes staging after path stripping.`,
				"archive-unsafe",
			);
		}
		return { ...entry, path: normalizedPath };
	});
}

export function extractPatchPaths(contents) {
	assert(
		typeof contents === "string" && contents.length > 0,
		"Patch asset is empty.",
		"patch-invalid",
	);
	const result = [];
	for (const line of contents.split("\n")) {
		if (!line.startsWith("diff --git ")) continue;
		const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
		assert(match && match[1] === match[2], `Unsupported patch header: ${line}`, "patch-invalid");
		result.push(match[1]);
	}
	assert(result.length > 0, "Patch contains no file changes.", "patch-invalid");
	return [...new Set(result)].sort();
}

function sourceArchiveIdentity(releaseCommit) {
	assert(
		typeof releaseCommit === "string" && /^[a-f0-9]{40}$/.test(releaseCommit),
		"Release commit is invalid.",
	);
	return {
		url: `${SOURCE_ARCHIVE_BASE_URL}${releaseCommit}`,
		root: `pi-${releaseCommit}`,
	};
}

function validateManifest(manifest) {
	assert(manifest?.schemaVersion === 1, "Unsupported updater manifest schema.");
	for (const key of [
		"id",
		"packageName",
		"version",
		"releaseCommit",
		"platform",
		"arch",
		"manager",
		"topology",
	]) {
		assert(
			typeof manifest[key] === "string" && manifest[key].length > 0,
			`Manifest field ${key} is missing.`,
		);
	}
	assert(
		manifest.sourceArchive?.url && manifest.sourceArchive?.sha256 && manifest.sourceArchive?.root,
		"Source archive provenance is incomplete.",
	);
	const expectedSource = sourceArchiveIdentity(manifest.releaseCommit);
	assert(
		manifest.sourceArchive.url === expectedSource.url &&
			manifest.sourceArchive.root === expectedSource.root,
		"Source archive identity does not match the pinned release commit.",
		"source-provenance-mismatch",
	);
	assert(
		manifest.modelDataPackage?.url &&
			manifest.modelDataPackage?.sha256 &&
			manifest.modelDataPackage?.integrity &&
			manifest.modelDataPackage?.root &&
			manifest.modelDataPackage?.targetRoot &&
			manifest.modelDataPackage?.files,
		"Model-data package provenance is incomplete.",
	);
	assert(manifest.patch?.path && manifest.patch?.sha256, "Patch provenance is incomplete.");
	assert(
		Array.isArray(manifest.patch.allowedPaths) && manifest.patch.allowedPaths.length > 0,
		"Patch allowlist is empty.",
	);
	assert(
		manifest.sourceFiles && Object.keys(manifest.sourceFiles).length > 0,
		"Source-shape hashes are empty.",
	);
	for (const group of GATE_ORDER) {
		assert(Array.isArray(manifest.gates?.[group]), `Gate group ${group} is missing.`);
		for (const gate of manifest.gates[group]) {
			assert(
				gate &&
					typeof gate === "object" &&
					typeof gate.id === "string" &&
					gate.id.length > 0 &&
					Array.isArray(gate.argv) &&
					gate.argv.length > 0 &&
					gate.argv.every((argument) => typeof argument === "string"),
				`Gate descriptor in ${group} is invalid.`,
			);
		}
	}
	assert(manifest.attestationSchemaVersion === 1, "Unsupported attestation schema.");
	return manifest;
}

function validateInstallation(manifest, installation) {
	for (const field of ["packageName", "version", "platform", "arch", "manager", "topology"]) {
		assert(
			installation?.[field] === manifest[field],
			`Unsupported installation ${field}.`,
			"unsupported-installation",
		);
	}
	assert(
		typeof installation.packagePath === "string" && path.isAbsolute(installation.packagePath),
		"Package path is invalid.",
	);
	assert(
		typeof installation.executablePath === "string" &&
			path.isAbsolute(installation.executablePath),
		"Executable path is invalid.",
	);
}

function report(manifest, status, reasonCode) {
	return {
		status,
		disposition: status,
		manifestId: manifest?.id ?? "unknown",
		releaseCommit: manifest?.releaseCommit ?? "unknown",
		patchSha256: manifest?.patch?.sha256 ?? "unknown",
		...(reasonCode ? { reasonCode } : {}),
	};
}

function attestationFor(manifest, now, packageTreeSha256) {
	return {
		schemaVersion: manifest.attestationSchemaVersion,
		manifestId: manifest.id,
		patchSha256: manifest.patch.sha256,
		releaseCommit: manifest.releaseCommit,
		packageTreeSha256,
		updatedAt: now(),
	};
}

export function attestationMatches(value, manifest) {
	return (
		value?.schemaVersion === manifest.attestationSchemaVersion &&
		value?.manifestId === manifest.id &&
		value?.patchSha256 === manifest.patch.sha256 &&
		value?.releaseCommit === manifest.releaseCommit &&
		/^[a-f0-9]{64}$/.test(value?.packageTreeSha256 ?? "")
	);
}

export function siblingPath(livePath, suffix) {
	const parent = path.dirname(livePath);
	const base = path.basename(livePath).replace(/^@/, "").replaceAll("/", "-");
	return path.join(parent, `.${base}${suffix}`);
}

function pathInsideSiblingDirectory(livePath, candidate) {
	if (typeof candidate !== "string") return false;
	const parent = path.resolve(path.dirname(livePath));
	const resolved = path.resolve(candidate);
	return path.dirname(resolved) === parent && resolved !== path.resolve(livePath);
}

function validateJournal(value, manifest, installation) {
	assert(
		value && typeof value === "object",
		"Updater journal is unreadable.",
		"recovery-required",
	);
	assert(
		value.schemaVersion === JOURNAL_SCHEMA_VERSION,
		"Updater journal schema is unknown.",
		"recovery-required",
	);
	assert(
		value.manifestId === manifest.id,
		"Updater journal belongs to another manifest.",
		"recovery-required",
	);
	assert(
		value.livePath === installation.packagePath,
		"Updater journal belongs to another installation.",
		"recovery-required",
	);
	assert(PHASES.has(value.phase), "Updater journal phase is invalid.", "recovery-required");
	assert(
		value.target === undefined || TARGETS.has(value.target),
		"Updater journal target is invalid.",
		"recovery-required",
	);
	assert(
		TARGETS.has(value.backupTarget) &&
			(value.backupTarget !== "patched" ||
				/^[a-f0-9]{64}$/.test(value.backupTreeSha256 ?? "")) &&
			((value.target ?? "patched") !== "patched" ||
				/^[a-f0-9]{64}$/.test(value.candidateTreeSha256 ?? "")),
		"Updater journal package hashes are invalid.",
		"recovery-required",
	);
	assert(
		typeof value.ownerId === "string" && value.ownerId.length > 0,
		"Updater journal owner is missing.",
		"recovery-required",
	);
	assert(
		pathInsideSiblingDirectory(value.livePath, value.backupPath),
		"Updater backup path is unsafe.",
		"recovery-required",
	);
	assert(
		pathInsideSiblingDirectory(value.livePath, value.candidatePath),
		"Updater candidate path is unsafe.",
		"recovery-required",
	);
	return value;
}

async function clearJournal(adapters, journalPath) {
	await adapters.journal.clear(journalPath);
	adapters.failpoint("journal-clear");
	await adapters.fsyncDir(path.dirname(journalPath));
	adapters.failpoint("journal-clear-fsync");
}

async function writeJournal(adapters, journalPath, value) {
	await adapters.journal.write(journalPath, value);
	adapters.failpoint(`journal-write:${value.phase}`);
	await adapters.fsyncFile(journalPath);
	await adapters.fsyncDir(path.dirname(journalPath));
	adapters.failpoint(`journal-fsync:${value.phase}`);
}

async function syncAttestation(adapters, manifest, target, packageTreeSha256) {
	if (target === "official") await adapters.attestation.clear();
	else await adapters.attestation.write(attestationFor(manifest, adapters.now, packageTreeSha256));
}

async function restoreBackup(adapters, manifest, journal) {
	const liveExists = await adapters.exists(journal.livePath);
	const backupExists = await adapters.exists(journal.backupPath);
	assert(backupExists, "Recorded backup is missing.", "recovery-required");
	if (liveExists) {
		const failedPath = `${journal.candidatePath}.failed`;
		if (await adapters.exists(failedPath)) await adapters.removeOwned(failedPath);
		await adapters.rename(journal.livePath, failedPath);
	}
	await adapters.rename(journal.backupPath, journal.livePath);
	assert(
		await adapters.validatePackage(
			journal.livePath,
			journal.backupTarget === "patched" ? "attested" : "official",
			journal.backupTarget === "patched"
				? { expectedTreeSha256: journal.backupTreeSha256 }
				: undefined,
		),
		"Restored package did not validate.",
		"recovery-required",
	);
	await syncAttestation(adapters, manifest, journal.backupTarget, journal.backupTreeSha256);
}

async function recover(adapters, manifest, installation, journalPath, rawJournal) {
	const journal = validateJournal(rawJournal, manifest, installation);
	if (journal.phase === "candidate-active") {
		const target = journal.target ?? "patched";
		const role = target === "official" ? "official-active" : "active";
		if (
			(await adapters.exists(journal.livePath)) &&
			(await adapters.validatePackage(
				journal.livePath,
				role,
				target === "patched" ? { expectedTreeSha256: journal.candidateTreeSha256 } : undefined,
			))
		) {
			await syncAttestation(adapters, manifest, target, journal.candidateTreeSha256);
			await clearJournal(adapters, journalPath);
			return report(manifest, "recovered");
		}
		await restoreBackup(adapters, manifest, journal);
		await clearJournal(adapters, journalPath);
		return report(manifest, "recovered");
	}

	if (await adapters.exists(journal.backupPath)) {
		await restoreBackup(adapters, manifest, journal);
		await clearJournal(adapters, journalPath);
		return report(manifest, "recovered");
	}
	assert(
		(await adapters.exists(journal.livePath)) &&
			(await adapters.validatePackage(
				journal.livePath,
				journal.backupTarget === "patched" ? "attested" : "official",
				journal.backupTarget === "patched"
					? { expectedTreeSha256: journal.backupTreeSha256 }
					: undefined,
			)),
		"No recorded known-good package can be recovered.",
		"recovery-required",
	);
	await syncAttestation(adapters, manifest, journal.backupTarget, journal.backupTreeSha256);
	await clearJournal(adapters, journalPath);
	return report(manifest, "recovered");
}

async function verifyFileHashes(adapters, root, entries, field) {
	for (const [relativePath, hashes] of Object.entries(entries)) {
		const expected = typeof hashes === "string" ? hashes : hashes[field];
		assert(
			typeof expected === "string",
			`Missing ${field} hash for ${relativePath}.`,
			"source-shape-mismatch",
		);
		const actual = await adapters.hashFile(path.join(root, relativePath));
		assert(actual === expected, `Digest mismatch for ${relativePath}.`, "source-shape-mismatch");
	}
}

async function stageCandidate(adapters, manifest, patchAsset, target = "patched") {
	await adapters.cleanupOwnedStaging(manifest.id);
	const staging = await adapters.createStaging(manifest.id);
	assert(
		staging?.ownerId && staging.sourceRoot && staging.npmRoot && staging.candidatePath,
		"Staging adapter returned an invalid layout.",
	);

	const sourceBytes = await adapters.fetch(manifest.sourceArchive.url);
	assert(
		(await adapters.hashBytes(sourceBytes)) === manifest.sourceArchive.sha256,
		"Source archive digest mismatch.",
		"source-provenance-mismatch",
	);
	const sourceEntries = validateArchiveEntries(
		await adapters.archive.list(sourceBytes),
		manifest.sourceArchive.stripComponents ?? 0,
	);
	assert(
		sourceEntries.length > 0 &&
			sourceEntries.every(
				(entry) =>
					entry.path === manifest.sourceArchive.root ||
					entry.path.startsWith(`${manifest.sourceArchive.root}/`),
			),
		"Source archive root does not match the pinned release commit.",
		"source-provenance-mismatch",
	);
	await adapters.archive.extract(sourceBytes, staging.sourceRoot, {
		entries: sourceEntries,
		stripComponents: manifest.sourceArchive.stripComponents ?? 0,
	});
	await verifyFileHashes(adapters, staging.sourceRoot, manifest.sourceFiles, "before");

	const npmBytes = await adapters.fetch(manifest.modelDataPackage.url);
	assert(
		(await adapters.hashBytes(npmBytes)) === manifest.modelDataPackage.sha256,
		"Model-data package digest mismatch.",
		"source-provenance-mismatch",
	);
	assert(
		await adapters.verifyIntegrity(npmBytes, manifest.modelDataPackage.integrity),
		"Model-data package integrity mismatch.",
		"source-provenance-mismatch",
	);
	const npmEntries = validateArchiveEntries(
		await adapters.archive.list(npmBytes),
		manifest.modelDataPackage.stripComponents ?? 0,
	);
	await adapters.archive.extract(npmBytes, staging.npmRoot, {
		entries: npmEntries,
		stripComponents: manifest.modelDataPackage.stripComponents ?? 0,
	});
	for (const [relativePath, digest] of Object.entries(manifest.modelDataPackage.files)) {
		const from = path.join(staging.npmRoot, manifest.modelDataPackage.root, relativePath);
		const to = path.join(staging.sourceRoot, manifest.modelDataPackage.targetRoot, relativePath);
		await adapters.copyFile(from, to);
		assert(
			(await adapters.hashFile(to)) === digest,
			`Hydrated model data mismatch for ${relativePath}.`,
			"source-provenance-mismatch",
		);
	}

	assert(TARGETS.has(target), "Updater target is invalid.");
	assert(
		patchAsset?.path === manifest.patch.path,
		"Patch path does not match the manifest.",
		"patch-invalid",
	);
	assert(
		(await adapters.hashBytes(patchAsset.contents)) === manifest.patch.sha256,
		"Patch digest mismatch.",
		"patch-invalid",
	);
	const patchPaths = extractPatchPaths(patchAsset.contents);
	const allowedPaths = [...manifest.patch.allowedPaths].sort();
	assert(
		JSON.stringify(patchPaths) === JSON.stringify(allowedPaths),
		"Patch scope differs from the reviewed allowlist.",
		"patch-scope-mismatch",
	);
	if (target === "patched") {
		await adapters.applyPatch(staging.sourceRoot, patchAsset.contents);
		await verifyFileHashes(adapters, staging.sourceRoot, manifest.sourceFiles, "after");
	}

	for (const group of GATE_ORDER) {
		for (const gate of manifest.gates[group]) await adapters.runGate(group, gate, staging);
	}
	assert(
		path.resolve(staging.candidatePath) !== path.resolve(staging.sourceRoot),
		"Candidate path overlaps source staging.",
	);
	const packageTreeSha256 = await adapters.hashPackageTree(staging.candidatePath);
	assert(
		await adapters.validatePackage(
			staging.candidatePath,
			target === "official" ? "official-candidate" : "candidate",
			target === "patched" ? { expectedTreeSha256: packageTreeSha256 } : undefined,
		),
		"Staged candidate did not validate.",
		"candidate-invalid",
	);
	return { ...staging, packageTreeSha256 };
}

async function commitCandidate(
	adapters,
	manifest,
	installation,
	journalPath,
	staging,
	target = "patched",
) {
	assert(TARGETS.has(target), "Updater target is invalid.");
	const livePath = installation.packagePath;
	const backupPath = siblingPath(
		livePath,
		target === "official" ? ".prewalk-patched-backup" : ".prewalk-backup",
	);
	assert(
		pathInsideSiblingDirectory(livePath, staging.candidatePath),
		"Candidate is not beside the live package.",
		"topology-mismatch",
	);
	assert(
		await adapters.sameFilesystem(livePath, staging.candidatePath),
		"Candidate is not on the live package filesystem.",
		"topology-mismatch",
	);
	const currentAttestation = await adapters.attestation.read(livePath);
	const backupTarget = target === "official" ? "patched" : "official";
	const backupTreeSha256 =
		backupTarget === "patched" && attestationMatches(currentAttestation, manifest)
			? currentAttestation.packageTreeSha256
			: undefined;
	assert(
		await adapters.validatePackage(
			livePath,
			backupTarget === "patched" ? "attested" : "official",
			backupTarget === "patched" ? { expectedTreeSha256: backupTreeSha256 } : undefined,
		),
		"Current package is not a valid rollback source.",
		"live-invalid",
	);
	assert(
		!(await adapters.exists(backupPath)),
		"A previous updater backup already exists.",
		"recovery-required",
	);

	const journal = {
		schemaVersion: JOURNAL_SCHEMA_VERSION,
		manifestId: manifest.id,
		ownerId: staging.ownerId,
		phase: "prepared",
		target,
		backupTarget,
		backupTreeSha256,
		candidateTreeSha256: staging.packageTreeSha256,
		livePath,
		backupPath,
		candidatePath: staging.candidatePath,
	};
	await writeJournal(adapters, journalPath, journal);

	try {
		await adapters.rename(livePath, backupPath);
		adapters.failpoint("rename:live-to-backup");
		journal.phase = "backup-active";
		await writeJournal(adapters, journalPath, journal);

		await adapters.rename(staging.candidatePath, livePath);
		adapters.failpoint("rename:candidate-to-live");
		journal.phase = "candidate-active";
		await writeJournal(adapters, journalPath, journal);

		assert(
			await adapters.validatePackage(
				livePath,
				target === "official" ? "official-active" : "active",
				target === "patched" ? { expectedTreeSha256: staging.packageTreeSha256 } : undefined,
			),
			"Activated candidate did not validate.",
			"post-swap-invalid",
		);
		if (target === "official") await adapters.attestation.clear();
		else
			await adapters.attestation.write(
				attestationFor(manifest, adapters.now, staging.packageTreeSha256),
			);
		await clearJournal(adapters, journalPath);
		return report(manifest, target === "official" ? "restored" : "updated");
	} catch (error) {
		if (error instanceof InjectedCrashError) throw error;
		if (await adapters.exists(backupPath)) {
			await restoreBackup(adapters, manifest, journal);
			await clearJournal(adapters, journalPath);
			return report(
				manifest,
				"rolled-back",
				error instanceof UpdaterError ? error.code : "commit-failed",
			);
		}
		if (
			(await adapters.exists(livePath)) &&
			(await adapters.validatePackage(
				livePath,
				backupTarget === "patched" ? "attested" : "official",
				backupTarget === "patched" ? { expectedTreeSha256: backupTreeSha256 } : undefined,
			))
		) {
			await clearJournal(adapters, journalPath);
			return report(
				manifest,
				"refused",
				error instanceof UpdaterError ? error.code : "commit-failed",
			);
		}
		throw new UpdaterError(
			"Commit failed without a verifiable package.",
			"recovery-required",
			error,
		);
	}
}

export async function commitOfficialCandidate({
	manifest,
	installation,
	candidatePath,
	ownerId = "official-restore",
	adapters,
}) {
	const journalPath = `${installation.packagePath}.prewalk-journal.json`;
	return commitCandidate(
		adapters,
		manifest,
		installation,
		journalPath,
		{ candidatePath, ownerId },
		"official",
	);
}

export async function restoreOfficialFromSource({
	manifest,
	installation,
	patch: patchAsset,
	adapters,
}) {
	const staging = await stageCandidate(adapters, manifest, patchAsset, "official");
	const journalPath = `${installation.packagePath}.prewalk-journal.json`;
	return commitCandidate(adapters, manifest, installation, journalPath, staging, "official");
}

export async function runRecoveredAction({
	manifest: rawManifest,
	installation,
	adapters,
	action,
}) {
	const manifest = validateManifest(rawManifest);
	const lockPath = `${installation?.packagePath ?? "unknown"}.prewalk.lock`;
	let release;
	try {
		release = await adapters.lock.acquire(lockPath);
		const journalPath = `${installation.packagePath}.prewalk-journal.json`;
		const existingJournal = await adapters.journal.read(journalPath);
		if (existingJournal !== undefined && existingJournal !== null) {
			return {
				recovery: await recover(adapters, manifest, installation, journalPath, existingJournal),
			};
		}
		validateInstallation(manifest, installation);
		return {
			recovery: null,
			value: await action({ manifest, installation, adapters }),
		};
	} finally {
		if (release) await release();
	}
}

export async function runUpdater({
	manifest: rawManifest,
	installation,
	patch: patchAsset,
	adapters,
}) {
	let manifest;
	try {
		const result = await runRecoveredAction({
			manifest: rawManifest,
			installation,
			adapters,
			action: async (context) => {
				manifest = context.manifest;
				const existingAttestation = await adapters.attestation.read(installation.packagePath);
				if (attestationMatches(existingAttestation, context.manifest)) {
					assert(
						await adapters.validatePackage(installation.packagePath, "attested", {
							expectedTreeSha256: existingAttestation.packageTreeSha256,
						}),
						"Attested package failed validation.",
						"attestation-invalid",
					);
					return report(context.manifest, "noop");
				}

				const staging = await stageCandidate(adapters, context.manifest, patchAsset);
				return commitCandidate(
					adapters,
					context.manifest,
					installation,
					`${installation.packagePath}.prewalk-journal.json`,
					staging,
				);
			},
		});
		return result.recovery ?? result.value;
	} catch (error) {
		if (error instanceof InjectedCrashError) throw error;
		const status =
			error instanceof UpdaterError && error.code === "recovery-required"
				? "recovery-required"
				: "refused";
		return report(
			manifest ?? rawManifest,
			status,
			error instanceof UpdaterError ? error.code : "unexpected-error",
		);
	}
}
