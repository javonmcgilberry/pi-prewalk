import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	access,
	chmod,
	copyFile,
	link,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Parser, Unpack } from "tar";

import { UpdaterError, validateArchiveEntries } from "./update.mjs";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const SAFE_OWNED_NAME =
	/^\.(?:pi-coding-agent|earendil-works-pi-coding-agent)\.prewalk-(?:candidate|backup|patched-backup|stage-[A-Za-z0-9._-]+|prefix-[A-Za-z0-9._-]+)(?:\.failed)?$/;
const REVIEWED_GATES = {
	test: {
		"npm-ci": { id: "npm-ci", argv: ["npm", "ci"] },
		"focused-tests": {
			id: "focused-tests",
			argv: [
				"npm",
				"test",
				"--workspace=@earendil-works/pi-coding-agent",
				"--",
				"test/suite/agent-session-model-extension.test.ts",
				"test/extensions-runner.test.ts",
			],
		},
	},
	build: {
		"offline-build": {
			id: "offline-build",
			argv: ["npm", "run", "build:offline"],
		},
	},
	pack: {
		"pack-coding-agent": {
			id: "pack-coding-agent",
			argv: ["npm", "pack", "--workspace=@earendil-works/pi-coding-agent", "--json"],
		},
	},
	install: {
		"install-candidate": {
			id: "install-candidate",
			argv: ["npm", "install", "--global", "--prefix", "<staging-prefix>", "<packed-tarball>"],
		},
	},
	candidate: {
		"candidate-version": {
			id: "candidate-version",
			argv: ["<node>", "<candidate-entrypoint>", "--version"],
		},
		"candidate-rpc": {
			id: "candidate-rpc",
			argv: ["rpc:get_state", "<candidate-entrypoint>"],
		},
	},
};

function sameGateDescriptor(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function invalidGateDescriptor(group, id = "unknown") {
	return new UpdaterError(`Gate descriptor is not reviewed: ${group}:${id}`, "manifest-invalid");
}

function validateReviewedGateManifest(manifest) {
	const configuredGroups = Object.keys(manifest.gates ?? {}).sort();
	const reviewedGroups = Object.keys(REVIEWED_GATES).sort();
	if (!sameGateDescriptor(configuredGroups, reviewedGroups)) {
		throw invalidGateDescriptor("groups");
	}
	for (const group of reviewedGroups) {
		const reviewed = Object.values(REVIEWED_GATES[group]);
		if (!sameGateDescriptor(manifest.gates[group], reviewed)) {
			throw invalidGateDescriptor(group);
		}
	}
}

function validateReviewedGate(manifest, group, gate) {
	const configured = manifest.gates?.[group] ?? [];
	const reviewed = REVIEWED_GATES[group]?.[gate?.id];
	if (
		!configured.some((candidate) => sameGateDescriptor(candidate, gate)) ||
		!reviewed ||
		!sameGateDescriptor(reviewed, gate)
	) {
		throw invalidGateDescriptor(group, gate?.id);
	}
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function asBuffer(value) {
	return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export async function hashPackageTree(root) {
	const rows = [];
	async function walk(directory, relative = "") {
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
		for (const entry of entries) {
			const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
			const absolutePath = path.join(directory, entry.name);
			if (entry.isDirectory()) await walk(absolutePath, relativePath);
			else if (entry.isSymbolicLink())
				rows.push(`${relativePath}\0link\0${await readlink(absolutePath)}`);
			else if (entry.isFile())
				rows.push(`${relativePath}\0file\0${sha256(await readFile(absolutePath))}`);
		}
	}
	await walk(root);
	return sha256(rows.join("\n"));
}

function normalizeTarType(type) {
	switch (type) {
		case "Directory":
			return "directory";
		case "SymbolicLink":
			return "symlink";
		case "Link":
			return "hardlink";
		default:
			return "file";
	}
}

function normalizeEntry(entry) {
	return {
		path: entry.path,
		type: normalizeTarType(entry.type),
		...(entry.linkpath ? { linkPath: entry.linkpath } : {}),
	};
}

export function listTarArchive(bytes) {
	return new Promise((resolve, reject) => {
		const entries = [];
		const parser = new Parser({
			onReadEntry: (entry) => {
				entries.push(normalizeEntry(entry));
				entry.resume();
			},
		});
		parser.on("error", reject);
		parser.on("end", () => resolve(entries));
		parser.end(asBuffer(bytes));
	});
}

export async function extractTarArchive({ bytes, destination, entries, stripComponents = 0 }) {
	const validated = validateArchiveEntries(entries, stripComponents);
	const allowed = new Map(
		validated.map((entry) => [
			`${entry.path}\0${entry.type ?? "file"}\0${entry.linkPath ?? ""}`,
			(entry.count ?? 0) + 1,
		]),
	);
	const parent = path.dirname(destination);
	await mkdir(parent, { recursive: true, mode: 0o700 });
	try {
		await lstat(destination);
		throw new UpdaterError(
			`Archive destination already exists: ${destination}`,
			"archive-unsafe",
		);
	} catch (error) {
		if (error instanceof UpdaterError) throw error;
		if (error?.code !== "ENOENT") throw error;
	}
	await mkdir(destination, { mode: 0o700 });

	await new Promise((resolve, reject) => {
		let rejected;
		const unpack = new Unpack({
			cwd: destination,
			strip: stripComponents,
			preservePaths: false,
			strict: true,
			filter: (entryPath, entry) => {
				try {
					const normalized = normalizeEntry({ ...entry, path: entryPath });
					validateArchiveEntries([normalized], stripComponents);
					const key = `${normalized.path}\0${normalized.type ?? "file"}\0${normalized.linkPath ?? ""}`;
					const count = allowed.get(key) ?? 0;
					if (count < 1) {
						throw new UpdaterError(
							`Archive entry was not present in the validated list: ${entryPath}`,
							"archive-unsafe",
						);
					}
					allowed.set(key, count - 1);
					return true;
				} catch (error) {
					rejected = error;
					return false;
				}
			},
		});
		unpack.on("error", reject);
		unpack.on("close", () => {
			if (rejected) reject(rejected);
			else if ([...allowed.values()].some((count) => count !== 0)) {
				reject(
					new UpdaterError(
						"Archive contents differed from the validated entry list.",
						"archive-unsafe",
					),
				);
			} else resolve();
		});
		unpack.end(asBuffer(bytes));
	});
}

async function findExecutable(name, envPath = process.env.PATH ?? "") {
	for (const directory of envPath.split(path.delimiter)) {
		if (!directory) continue;
		const candidate = path.join(directory, name);
		try {
			await access(candidate);
			return candidate;
		} catch {
			// Continue searching PATH.
		}
	}
	throw new UpdaterError(`Could not find ${name} on PATH.`, "unsupported-installation");
}

export async function detectPiInstallation({
	executablePath,
	envPath,
	platform = process.platform,
	arch = process.arch,
} = {}) {
	const binPath = path.resolve(executablePath ?? (await findExecutable("pi", envPath)));
	let targetPath;
	let dangling = false;
	try {
		targetPath = await realpath(binPath);
	} catch (error) {
		try {
			const info = await lstat(binPath);
			if (!info.isSymbolicLink()) throw error;
			const linkTarget = await readlink(binPath);
			targetPath = path.resolve(path.dirname(binPath), linkTarget);
			dangling = true;
		} catch (linkError) {
			throw new UpdaterError(
				`Unable to resolve the pi executable: ${binPath}`,
				"unsupported-installation",
				linkError,
			);
		}
	}
	const suffix = path.join(PACKAGE_NAME, "dist", "cli.js");
	if (!targetPath.endsWith(suffix)) {
		throw new UpdaterError(
			`The pi executable is not in the supported npm-global topology: ${targetPath}`,
			"unsupported-installation",
		);
	}
	const rawPackagePath = targetPath.slice(0, -path.join("dist", "cli.js").length - 1);
	const packageSuffix = path.join("lib", "node_modules", PACKAGE_NAME);
	if (!rawPackagePath.endsWith(packageSuffix)) {
		throw new UpdaterError(
			`The pi package is not installed under an npm-global prefix: ${rawPackagePath}`,
			"unsupported-installation",
		);
	}
	const rawPrefix = rawPackagePath.slice(0, -packageSuffix.length).replace(/[\\/]$/, "");
	const prefix = await realpath(rawPrefix);
	const packagePath = path.join(prefix, packageSuffix);
	const expectedBin = path.join(prefix, "bin", "pi");
	const canonicalBinPath = path.join(
		await realpath(path.dirname(binPath)),
		path.basename(binPath),
	);
	if (canonicalBinPath !== expectedBin) {
		throw new UpdaterError(
			`The pi executable is not the supported npm-global bin link: ${binPath}`,
			"unsupported-installation",
		);
	}
	let metadataPath = packagePath;
	if (dangling) {
		const recoveryCandidates = [
			`${packagePath}.prewalk-backup`,
			`${packagePath}.prewalk-patched-backup`,
		];
		metadataPath = "";
		for (const candidate of recoveryCandidates) {
			try {
				const info = await lstat(candidate);
				if (info.isDirectory() && !info.isSymbolicLink()) {
					metadataPath = candidate;
					break;
				}
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
			}
		}
		if (!metadataPath)
			throw new UpdaterError(
				"Dangling pi link has no owned recovery backup.",
				"unsupported-installation",
			);
	}
	const packageJson = JSON.parse(await readFile(path.join(metadataPath, "package.json"), "utf8"));
	if (packageJson.name !== PACKAGE_NAME) {
		throw new UpdaterError(
			"The detected package identity is unsupported.",
			"unsupported-installation",
		);
	}
	return {
		packagePath,
		executablePath: binPath,
		packageName: packageJson.name,
		version: packageJson.version,
		platform,
		arch,
		manager: "npm",
		topology: "npm-global",
	};
}

function runProcess(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: { ...process.env, HUSKY: "0", ...options.env },
			stdio: options.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve({ stdout, stderr });
			else
				reject(
					new UpdaterError(
						`${command} ${args.join(" ")} failed (${code}): ${stderr.slice(-2_000)}`,
						"gate-failed",
					),
				);
		});
		if (options.input) child.stdin.end(options.input);
	});
}

async function rpcState(entrypoint, agentDir) {
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [entrypoint, "--mode", "rpc", "--no-session"], {
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(
				new UpdaterError(
					`Candidate RPC timed out: ${stderr.slice(-1_000)}`,
					"candidate-invalid",
				),
			);
		}, 20_000);
		const lines = readline.createInterface({ input: child.stdout });
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		lines.on("line", (line) => {
			try {
				const response = JSON.parse(line);
				if (response.type === "response" && response.command === "get_state") {
					clearTimeout(timer);
					child.kill();
					resolve(response.data);
				}
			} catch {
				// Ignore non-protocol startup output.
			}
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.stdin.write('{"type":"get_state"}\n');
	});
}

async function atomicJsonWrite(filePath, value) {
	await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporary, filePath);
	await chmod(filePath, 0o600);
}

function ownedSibling(packagePath, candidate) {
	return (
		path.dirname(path.resolve(candidate)) === path.dirname(path.resolve(packagePath)) &&
		SAFE_OWNED_NAME.test(path.basename(candidate))
	);
}

function lockOwnerAlive(owner) {
	if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return undefined;
	try {
		process.kill(owner.pid, 0);
		return true;
	} catch (error) {
		if (error?.code === "ESRCH") return false;
		if (error?.code === "EPERM") return true;
		return undefined;
	}
}

export async function acquireProcessLock(lockPath, hooks = {}) {
	const lockDirectory = path.dirname(lockPath);
	const claimPrefix = `${path.basename(lockPath)}.reclaim-`;
	await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
	const owner = {
		pid: process.pid,
		nonce: randomUUID(),
		createdAt: new Date().toISOString(),
	};
	const claimPath = path.join(lockDirectory, `${claimPrefix}${owner.pid}-${owner.nonce}`);
	const releaseClaim = () => rm(claimPath, { force: true });
	const removeDeadClaims = async () => {
		for (const entry of await readdir(lockDirectory)) {
			if (!entry.startsWith(claimPrefix)) continue;
			const pid = Number(entry.slice(claimPrefix.length).split("-", 1)[0]);
			if (lockOwnerAlive({ pid }) === false) {
				await rm(path.join(lockDirectory, entry), { force: true });
			}
		}
	};
	const sameInode = (left, right) => left.dev === right.dev && left.ino === right.ino;

	await removeDeadClaims();
	for (let attempt = 0; attempt < 8; attempt += 1) {
		let handle;
		try {
			handle = await open(lockPath, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify(owner)}\n`);
			await handle.sync();
			await handle.close();
			return async () => {
				try {
					const current = JSON.parse(await readFile(lockPath, "utf8"));
					if (current.nonce === owner.nonce) await rm(lockPath, { force: true });
				} catch (error) {
					if (error?.code !== "ENOENT") throw error;
				}
			};
		} catch (error) {
			await handle?.close().catch(() => {});
			if (error?.code !== "EEXIST") throw error;
		}

		try {
			await link(lockPath, claimPath);
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			throw error;
		}

		try {
			const staleOwner = JSON.parse(await readFile(claimPath, "utf8"));
			if (lockOwnerAlive(staleOwner) !== false)
				throw new UpdaterError(`Updater lock is held: ${lockPath}`, "lock-held");

			await removeDeadClaims();
			const claimed = await stat(claimPath);
			if (claimed.nlink !== 2) {
				await releaseClaim();
				await new Promise((resolve) => setTimeout(resolve, 5 + ((attempt * 7) % 13)));
				continue;
			}

			await hooks.beforeStaleUnlink?.();
			const [current, pinned] = await Promise.all([stat(lockPath), stat(claimPath)]);
			if (!sameInode(current, pinned) || pinned.nlink !== 2) {
				await releaseClaim();
				continue;
			}
			await rm(lockPath);
			await releaseClaim();
		} catch (error) {
			await releaseClaim();
			if (error?.code === "ENOENT") continue;
			throw error;
		}
	}
	await releaseClaim();
	throw new UpdaterError(`Updater lock is held: ${lockPath}`, "lock-held");
}

export function createNodeAdapters({
	installation,
	manifest,
	fetchImpl = globalThis.fetch,
	failpoint = () => {},
}) {
	validateReviewedGateManifest(manifest);
	const packageParent = path.dirname(installation.packagePath);
	const safeId = manifest.id.replace(/[^A-Za-z0-9._-]/g, "-");
	const attestationPath = `${installation.packagePath}.prewalk-attestation.json`;
	let staging;
	let packedTarball;

	async function validatePackage(packagePath, role, options = {}) {
		try {
			const metadata = JSON.parse(
				await readFile(path.join(packagePath, "package.json"), "utf8"),
			);
			if (metadata.name !== manifest.packageName || metadata.version !== manifest.version)
				return false;
			const entrypoint = path.join(packagePath, manifest.installation.entrypoint);
			await access(entrypoint);
			const declarationPath = path.join(packagePath, "dist/core/extensions/types.d.ts");
			let hasSessionApi = false;
			try {
				hasSessionApi = (await readFile(declarationPath, "utf8")).includes(
					"setSessionModelAndThinkingLevel",
				);
			} catch {
				const runtimePath = path.join(packagePath, "dist/core/agent-session.js");
				hasSessionApi = (await readFile(runtimePath, "utf8")).includes(
					"setSessionModelAndThinkingLevel",
				);
			}
			const packageTreeSha256 = await hashPackageTree(packagePath);
			if (["candidate", "active", "attested"].includes(role)) {
				return (
					hasSessionApi &&
					/^[a-f0-9]{64}$/.test(options.expectedTreeSha256 ?? "") &&
					packageTreeSha256 === options.expectedTreeSha256
				);
			}
			const officialFiles = manifest.installation.officialPackageFiles ?? {};
			let officialHashesMatch = Object.keys(officialFiles).length > 0;
			for (const [relativePath, expected] of Object.entries(officialFiles)) {
				if (sha256(await readFile(path.join(packagePath, relativePath))) !== expected) {
					officialHashesMatch = false;
					break;
				}
			}
			if (officialHashesMatch && manifest.installation.officialPackageTreeSha256) {
				officialHashesMatch =
					packageTreeSha256 === manifest.installation.officialPackageTreeSha256;
			}
			if (
				[
					"official",
					"official-backup",
					"official-candidate",
					"official-active",
					"restored",
				].includes(role)
			)
				return !hasSessionApi && officialHashesMatch;
			return false;
		} catch {
			return false;
		}
	}

	const adapters = {
		lock: {
			acquire: acquireProcessLock,
		},
		journal: {
			read: async (filePath) => {
				try {
					return JSON.parse(await readFile(filePath, "utf8"));
				} catch (error) {
					if (error?.code === "ENOENT") return undefined;
					throw new UpdaterError(
						`Updater journal is unreadable: ${filePath}`,
						"recovery-required",
						error,
					);
				}
			},
			write: atomicJsonWrite,
			clear: async (filePath) => rm(filePath, { force: true }),
		},
		fsyncFile: async (filePath) => {
			const handle = await open(filePath, "r");
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
		},
		fsyncDir: async (directory) => {
			const handle = await open(directory, "r");
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
		},
		fetch: async (url) => {
			const response = await fetchImpl(url, { redirect: "error" });
			if (!response.ok)
				throw new UpdaterError(
					`Fetch failed (${response.status}) for ${url}`,
					"source-fetch-failed",
				);
			return Buffer.from(await response.arrayBuffer());
		},
		hashBytes: async (value) => sha256(asBuffer(value)),
		hashFile: async (filePath) => sha256(await readFile(filePath)),
		verifyIntegrity: async (value, expected) => {
			const [algorithm, digest] = String(expected).split("-", 2);
			if (algorithm !== "sha512" || !digest) return false;
			return createHash("sha512").update(asBuffer(value)).digest("base64") === digest;
		},
		archive: {
			list: listTarArchive,
			extract: (bytes, destination, options) =>
				extractTarArchive({ bytes, destination, ...options }),
		},
		createStaging: async () => {
			const ownerId = randomUUID();
			const root = path.join(
				packageParent,
				`.pi-coding-agent.prewalk-stage-${safeId}-${ownerId}`,
			);
			const candidatePath = path.join(packageParent, ".pi-coding-agent.prewalk-candidate");
			const prefix = path.join(root, "prefix");
			for (const ownedPath of [root, candidatePath]) {
				try {
					await lstat(ownedPath);
					throw new UpdaterError(
						`Owned staging path already exists: ${ownedPath}`,
						"recovery-required",
					);
				} catch (error) {
					if (error instanceof UpdaterError) throw error;
					if (error?.code !== "ENOENT") throw error;
				}
			}
			await mkdir(root, { mode: 0o700 });
			await writeFile(
				path.join(root, ".prewalk-owner.json"),
				`${JSON.stringify({ manifestId: manifest.id, ownerId })}\n`,
				{ mode: 0o600 },
			);
			staging = {
				ownerId,
				root,
				sourceRoot: path.join(root, "source"),
				npmRoot: path.join(root, "npm"),
				candidatePath,
				prefix,
			};
			return staging;
		},
		cleanupOwnedStaging: async () => {
			let names = [];
			try {
				names = await readdir(packageParent);
			} catch {
				return;
			}
			const candidatePath = path.join(packageParent, ".pi-coding-agent.prewalk-candidate");
			try {
				const owner = JSON.parse(
					await readFile(path.join(candidatePath, ".prewalk-owner.json"), "utf8"),
				);
				if (owner.manifestId === manifest.id)
					await rm(candidatePath, { recursive: true, force: true });
			} catch {
				// An unmarked candidate is ambiguous and deliberately preserved.
			}
			for (const name of names) {
				if (!name.startsWith(`.pi-coding-agent.prewalk-stage-${safeId}-`)) continue;
				const candidate = path.join(packageParent, name);
				try {
					const owner = JSON.parse(
						await readFile(path.join(candidate, ".prewalk-owner.json"), "utf8"),
					);
					if (owner.manifestId === manifest.id)
						await rm(candidate, { recursive: true, force: true });
				} catch {
					// Ambiguous staging is deliberately preserved.
				}
			}
		},
		copyFile: async (from, to) => {
			await mkdir(path.dirname(to), { recursive: true });
			await copyFile(from, to);
		},
		applyPatch: async (sourceRoot, contents) => {
			await runProcess("git", ["apply", "--check", "-"], {
				cwd: sourceRoot,
				input: contents,
			});
			await runProcess("git", ["apply", "-"], {
				cwd: sourceRoot,
				input: contents,
			});
		},
		runGate: async (group, gate, currentStaging) => {
			if (!staging || currentStaging.ownerId !== staging.ownerId)
				throw new UpdaterError("Unknown staging owner.", "recovery-required");
			validateReviewedGate(manifest, group, gate);

			const resolveArgument = (argument) => {
				if (argument === "<node>") return process.execPath;
				if (argument === "<staging-prefix>") return staging.prefix;
				if (argument === "<packed-tarball>") {
					if (!packedTarball)
						throw new UpdaterError("Pack gate did not produce an archive.", "gate-failed");
					return packedTarball;
				}
				if (argument === "<candidate-entrypoint>") {
					return path.join(staging.candidatePath, manifest.installation.entrypoint);
				}
				return argument;
			};
			const argv = gate.argv.map(resolveArgument);

			if (gate.id === "npm-ci" || gate.id === "focused-tests" || gate.id === "offline-build") {
				await runProcess(argv[0], argv.slice(1), { cwd: staging.sourceRoot });
			} else if (gate.id === "pack-coding-agent") {
				const result = await runProcess(argv[0], argv.slice(1), {
					cwd: staging.sourceRoot,
				});
				const packed = JSON.parse(result.stdout);
				packedTarball = path.join(staging.sourceRoot, packed[0].filename);
			} else if (gate.id === "install-candidate") {
				await runProcess(argv[0], argv.slice(1), { cwd: staging.sourceRoot });
				const installed = path.join(staging.prefix, "lib/node_modules", manifest.packageName);
				await rename(installed, staging.candidatePath);
				await writeFile(
					path.join(staging.candidatePath, ".prewalk-owner.json"),
					`${JSON.stringify({ manifestId: manifest.id, ownerId: staging.ownerId })}\n`,
					{ mode: 0o600 },
				);
			} else if (gate.id === "candidate-version") {
				await runProcess(argv[0], argv.slice(1));
			} else if (gate.id === "candidate-rpc") {
				await rpcState(argv[1], path.join(staging.root, "rpc-agent"));
				await rm(path.join(staging.candidatePath, ".prewalk-owner.json"), {
					force: true,
				});
			} else {
				throw new UpdaterError(
					`Unsupported manifest gate: ${group}:${gate.id}`,
					"manifest-invalid",
				);
			}
		},
		validatePackage,
		hashPackageTree,
		sameFilesystem: async (left, right) => {
			const [a, b] = await Promise.all([stat(path.dirname(left)), stat(path.dirname(right))]);
			return a.dev === b.dev;
		},
		exists: async (candidate) => {
			try {
				await lstat(candidate);
				return true;
			} catch (error) {
				if (error?.code === "ENOENT") return false;
				throw error;
			}
		},
		rename,
		removeOwned: async (candidate) => {
			if (!ownedSibling(installation.packagePath, candidate))
				throw new UpdaterError(
					`Refusing to remove unowned path: ${candidate}`,
					"recovery-required",
				);
			await rm(candidate, { recursive: true, force: true });
		},
		attestation: {
			read: async () => {
				try {
					return JSON.parse(await readFile(attestationPath, "utf8"));
				} catch (error) {
					if (error?.code === "ENOENT") return undefined;
					throw error;
				}
			},
			write: async (value) => atomicJsonWrite(attestationPath, value),
			clear: async () => rm(attestationPath, { force: true }),
		},
		failpoint,
		now: () => new Date().toISOString(),
	};
	return adapters;
}

export async function migrateLegacyArtifacts({ artifacts, knownHashes }) {
	const hashes = new Set(knownHashes);
	const removed = [];
	const preserved = [];
	for (const artifact of artifacts) {
		try {
			const info = await lstat(artifact);
			if (!info.isFile() || info.isSymbolicLink()) {
				preserved.push(artifact);
				continue;
			}
			const digest = sha256(await readFile(artifact));
			if (!hashes.has(digest)) {
				preserved.push(artifact);
				continue;
			}
			await rm(artifact);
			removed.push(artifact);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
	}
	return { removed, preserved };
}

export function defaultAgentPaths(env = process.env) {
	const agentDir = env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
	return {
		agentDir,
		configPath: path.join(agentDir, "prewalk.json"),
		settingsPath: path.join(agentDir, "settings.json"),
		legacyArtifacts: [path.join(agentDir, "extensions", "prewalk.ts")],
	};
}
