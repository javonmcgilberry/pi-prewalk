import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { create as createTar } from "tar";
import { describe, expect, it, vi } from "vitest";

import {
	classifyInstallation,
	executeCliMode,
	migrateInstallation,
	parseCliArgs,
	runCli,
	sanitizeLegacyConfig,
	uninstallInstallation,
} from "../updater/cli.mjs";
import {
	acquireProcessLock,
	createNodeAdapters,
	detectPiInstallation,
	extractTarArchive,
	hashPackageTree,
	listTarArchive,
	migrateLegacyArtifacts,
} from "../updater/node-adapters.mjs";
import { runRecoveredAction } from "../updater/update.mjs";

const LIVE = "/global/lib/node_modules/@earendil-works/pi-coding-agent";

function manifest(): Record<string, any> {
	return {
		schemaVersion: 1,
		id: "pi-coding-agent-0.82.1-darwin-arm64",
		packageName: "@earendil-works/pi-coding-agent",
		version: "0.82.1",
		releaseCommit: "b4f293684bba718d59cc1157679bcf6157b3a7f5",
		platform: "darwin",
		arch: "arm64",
		manager: "npm",
		topology: "npm-global",
		installation: {
			packageJson: "package.json",
			entrypoint: "dist/cli.js",
			globalBin: "pi",
			globalBinTarget: "../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
		},
		gates: {
			test: [
				{ id: "npm-ci", argv: ["npm", "ci"] },
				{
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
			],
			build: [
				{
					id: "offline-build",
					argv: ["npm", "run", "build:offline"],
				},
			],
			pack: [
				{
					id: "pack-coding-agent",
					argv: ["npm", "pack", "--workspace=@earendil-works/pi-coding-agent", "--json"],
				},
			],
			install: [
				{
					id: "install-candidate",
					argv: [
						"npm",
						"install",
						"--global",
						"--prefix",
						"<staging-prefix>",
						"<packed-tarball>",
					],
				},
			],
			candidate: [
				{
					id: "candidate-version",
					argv: ["<node>", "<candidate-entrypoint>", "--version"],
				},
				{
					id: "candidate-rpc",
					argv: ["rpc:get_state", "<candidate-entrypoint>"],
				},
			],
		},
		attestationSchemaVersion: 1,
		patch: { sha256: "patch-sha" },
	};
}

function installation(overrides: Record<string, unknown> = {}) {
	return {
		packagePath: LIVE,
		executablePath: "/global/bin/pi",
		packageName: "@earendil-works/pi-coding-agent",
		version: "0.82.1",
		platform: "darwin",
		arch: "arm64",
		manager: "npm",
		topology: "npm-global",
		...overrides,
	};
}

function orchestrationFixture(
	options: { recovery?: { status: string } | null; status?: string } = {},
) {
	const operations: string[] = [];
	const adapters = {
		attestation: {
			read: vi.fn(async () =>
				options.status === "patched"
					? {
							schemaVersion: 1,
							manifestId: manifest().id,
							patchSha256: "patch-sha",
							releaseCommit: manifest().releaseCommit,
							packageTreeSha256: "a".repeat(64),
						}
					: undefined,
			),
		},
		validatePackage: vi.fn(async (_path: string, role: string) => {
			operations.push(`validate:${role}`);
			return options.status !== "damaged";
		}),
	};
	const runRecoveredAction = vi.fn(async ({ action }: { action: () => Promise<unknown> }) => {
		operations.push("recovery");
		if (options.recovery) return { recovery: options.recovery };
		return { recovery: null, value: await action() };
	});
	return { adapters, operations, runRecoveredAction };
}

describe("updater CLI contract", () => {
	it("publishes the updater executable through the package bin", async () => {
		const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
		expect(packageJson.bin).toEqual({
			"prewalk-update-pi": "./updater/cli.mjs",
		});
	});

	it("reports an unsupported detected version after lock/recovery preflight", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-cli-unsupported-"));
		const prefix = path.join(root, "prefix");
		const packageRoot = path.join(prefix, "lib/node_modules/@earendil-works/pi-coding-agent");
		const executable = path.join(prefix, "bin/pi");
		await mkdir(path.join(packageRoot, "dist"), { recursive: true });
		await mkdir(path.dirname(executable), { recursive: true });
		await writeFile(
			path.join(packageRoot, "package.json"),
			JSON.stringify({
				name: "@earendil-works/pi-coding-agent",
				version: "9.9.9",
			}),
		);
		await writeFile(path.join(packageRoot, "dist/cli.js"), "#!/usr/bin/env node\n");
		await symlink("../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js", executable);
		let stderr = "";
		const exitCode = await runCli({
			argv: ["status", "--json"],
			executablePath: executable,
			platform: "darwin",
			arch: "arm64",
			packageRoot: path.resolve("."),
			stdout: { write: () => true },
			stderr: {
				write: (value: string) => {
					stderr += value;
					return true;
				},
			},
		});
		expect(exitCode).toBe(1);
		expect(JSON.parse(stderr).status).toBe("unsupported");
		await expect(lstat(`${await realpath(packageRoot)}.prewalk.lock`)).rejects.toThrow();
	});

	it("parses the supported modes and rejects unknown flags", () => {
		expect(parseCliArgs(["update", "--json"])).toEqual({
			mode: "update",
			json: true,
		});
		expect(parseCliArgs(["restore"])).toEqual({
			mode: "uninstall",
			json: false,
		});
		expect(parseCliArgs(["recovery-report"])).toEqual({
			mode: "recovery-report",
			json: false,
		});
		expect(() => parseCliArgs(["update", "--latest"])).toThrow(/Unknown option/);
	});

	it.each(["status", "migrate", "uninstall", "recovery-report"] as const)(
		"runs recovery before %s action",
		async (mode) => {
			const fixture = orchestrationFixture({ status: "patched" });
			await executeCliMode({
				mode,
				manifest: manifest(),
				installation: installation(),
				adapters: fixture.adapters,
				runRecoveredAction: fixture.runRecoveredAction,
				services: {
					migrate: async () => fixture.operations.push("migrate"),
					uninstall: async () => fixture.operations.push("uninstall"),
				},
			});
			expect(fixture.operations[0]).toBe("recovery");
		},
	);

	it("stops after recovery instead of executing the requested action", async () => {
		const fixture = orchestrationFixture({ recovery: { status: "recovered" } });
		const migrate = vi.fn();
		const result = await executeCliMode({
			mode: "migrate",
			manifest: manifest(),
			installation: installation(),
			adapters: fixture.adapters,
			runRecoveredAction: fixture.runRecoveredAction,
			services: { migrate, uninstall: vi.fn() },
		});
		expect(result.status).toBe("recovered");
		expect(migrate).not.toHaveBeenCalled();
	});

	it.each([
		["patched", "supported-patched"],
		["unpatched", "supported-unpatched"],
		["damaged", "damaged"],
	] as const)("classifies %s installations", async (fixtureStatus, expected) => {
		const fixture = orchestrationFixture({ status: fixtureStatus });
		const result = await classifyInstallation({
			manifest: manifest(),
			installation: installation(),
			adapters: fixture.adapters,
		});
		expect(result.status).toBe(expected);
	});

	it("restores a verified retained official backup and removes only the patched rollback", async () => {
		const officialBackup =
			"/global/lib/node_modules/@earendil-works/.pi-coding-agent.prewalk-backup";
		const patchedBackup =
			"/global/lib/node_modules/@earendil-works/.pi-coding-agent.prewalk-patched-backup";
		const files = new Set([officialBackup, patchedBackup]);
		const commitOfficial = vi.fn(async () => ({ status: "restored" }));
		const removeOwned = vi.fn(async (candidate: string) => files.delete(candidate));
		const result = await uninstallInstallation({
			manifest: manifest(),
			installation: installation(),
			patch: { path: "patch", contents: "patch" },
			adapters: {
				exists: async (candidate: string) => files.has(candidate),
				validatePackage: async (candidate: string, role: string) =>
					candidate === officialBackup && role === "official-backup",
				removeOwned,
				attestation: { clear: vi.fn() },
			},
			commitOfficial,
			restoreFromSource: vi.fn(),
		});
		expect(result.status).toBe("restored");
		expect(commitOfficial).toHaveBeenCalledWith(
			expect.objectContaining({ candidatePath: officialBackup }),
		);
		expect(removeOwned).toHaveBeenCalledWith(patchedBackup);
	});

	it("rebuilds verified official source when no retained backup exists", async () => {
		const restoreFromSource = vi.fn(async () => ({ status: "restored" }));
		const result = await uninstallInstallation({
			manifest: manifest(),
			installation: installation(),
			patch: { path: "patch", contents: "patch" },
			adapters: {
				exists: async () => false,
				validatePackage: vi.fn(),
				removeOwned: vi.fn(),
				attestation: { clear: vi.fn() },
			},
			commitOfficial: vi.fn(),
			restoreFromSource,
		});
		expect(result.status).toBe("restored");
		expect(restoreFromSource).toHaveBeenCalledOnce();
	});

	it("refuses an unverifiable retained backup without replacing the live package", async () => {
		const retained = "/global/lib/node_modules/@earendil-works/.pi-coding-agent.prewalk-backup";
		const commitOfficial = vi.fn();
		await expect(
			uninstallInstallation({
				manifest: manifest(),
				installation: installation(),
				patch: { path: "patch", contents: "patch" },
				adapters: {
					exists: async (candidate: string) => candidate === retained,
					validatePackage: async () => false,
					removeOwned: vi.fn(),
					attestation: { clear: vi.fn() },
				},
				commitOfficial,
				restoreFromSource: vi.fn(),
			}),
		).rejects.toThrow(/not verified official/);
		expect(commitOfficial).not.toHaveBeenCalled();
	});

	it("migration preserves valid config, drops restart state, and leaves ambiguous files", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-config-migrate-"));
		const configPath = path.join(root, "prewalk.json");
		const settingsPath = path.join(root, "settings.json");
		const ambiguous = path.join(root, "prewalk.ts");
		const pair = `${"a".repeat(64)}->${"b".repeat(64)}`;
		await writeFile(
			configPath,
			JSON.stringify({
				enabled: true,
				target: "openai-codex/gpt-5.6-luna",
				thinkingLevel: "low",
				crossProviderPairs: [pair],
				runId: "drop",
				restartToken: "drop",
				sessionFile: "/private/session.jsonl",
				proof: "drop",
			}),
		);
		await writeFile(ambiguous, "user-owned extension\n");
		await writeFile(
			settingsPath,
			JSON.stringify({ packages: ["known:restart-prewalk", "keep:other"] }),
		);
		const result = await migrateInstallation({
			manifest: {
				...manifest(),
				legacy: {
					looseExtensionSha256: [],
					packageSources: ["known:restart-prewalk"],
				},
			},
			paths: { configPath, settingsPath, legacyArtifacts: [ambiguous] },
		});
		expect(result.status).toBe("migration-review-required");
		expect(result.configPreserved).toBe(true);
		expect(result.preserved).toEqual([ambiguous]);
		expect(result.removedPackageSources).toEqual(["known:restart-prewalk"]);
		expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
			packages: ["keep:other"],
		});
		expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
			enabled: true,
			target: "openai-codex/gpt-5.6-luna",
			thinkingLevel: "low",
			crossProviderPairs: [pair],
		});
	});

	it("discovers but preserves unidentified Prewalk package sources", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-config-discover-"));
		try {
			const settingsPath = path.join(root, "settings.json");
			await writeFile(
				settingsPath,
				JSON.stringify({ packages: ["local:unknown-prewalk-restart", "keep:other"] }),
			);
			const result = await migrateInstallation({
				manifest: { ...manifest(), legacy: {} },
				paths: {
					configPath: path.join(root, "missing.json"),
					settingsPath,
					legacyArtifacts: [],
				},
			});
			expect(result.status).toBe("migration-review-required");
			expect(result.unidentifiedPackageSources).toEqual(["local:unknown-prewalk-restart"]);
			expect(JSON.parse(await readFile(settingsPath, "utf8")).packages).toEqual([
				"local:unknown-prewalk-restart",
				"keep:other",
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("sanitizes legacy config to supported durable fields", () => {
		const pair = `${"a".repeat(64)}->${"b".repeat(64)}`;
		expect(
			sanitizeLegacyConfig({
				enabled: true,
				target: "openai-codex/gpt-5.6-luna",
				thinkingLevel: "low",
				crossProviderPairs: [pair, pair, "provider-only->consent"],
				runId: "discard",
				sessionFile: "/secret/session.jsonl",
				proof: "discard",
			}),
		).toEqual({
			enabled: true,
			target: "openai-codex/gpt-5.6-luna",
			thinkingLevel: "low",
			crossProviderPairs: [pair],
		});
	});
});

describe("real updater adapters", () => {
	it("detects and proves the npm-global executable topology", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-detect-"));
		const prefix = path.join(root, "prefix");
		const packageRoot = path.join(prefix, "lib/node_modules/@earendil-works/pi-coding-agent");
		await mkdir(path.join(packageRoot, "dist"), { recursive: true });
		await mkdir(path.join(prefix, "bin"), { recursive: true });
		await writeFile(
			path.join(packageRoot, "package.json"),
			JSON.stringify({
				name: "@earendil-works/pi-coding-agent",
				version: "0.82.1",
			}),
		);
		await writeFile(path.join(packageRoot, "dist/cli.js"), "#!/usr/bin/env node\n");
		await symlink(
			"../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
			path.join(prefix, "bin/pi"),
		);

		const result = await detectPiInstallation({
			executablePath: path.join(prefix, "bin/pi"),
			platform: "darwin",
			arch: "arm64",
		});
		expect(result.packagePath).toBe(await realpath(packageRoot));
		expect(result.topology).toBe("npm-global");
	});

	it("rejects an executable outside the supported npm-global topology", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-detect-bad-"));
		const executable = path.join(root, "pi");
		await writeFile(executable, "#!/usr/bin/env node\n");
		await expect(
			detectPiInstallation({
				executablePath: executable,
				platform: "darwin",
				arch: "arm64",
			}),
		).rejects.toThrow(/npm-global/);
	});

	it("classifies modified official package files as damaged", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-official-hash-"));
		const packageRoot = path.join(root, "lib/node_modules/@earendil-works/pi-coding-agent");
		await mkdir(path.join(packageRoot, "dist/core/extensions"), {
			recursive: true,
		});
		await writeFile(
			path.join(packageRoot, "package.json"),
			JSON.stringify({
				name: "@earendil-works/pi-coding-agent",
				version: "0.82.1",
			}),
		);
		await writeFile(path.join(packageRoot, "dist/cli.js"), "official cli\n");
		await writeFile(
			path.join(packageRoot, "dist/core/extensions/types.d.ts"),
			"export interface ExtensionAPI {}\n",
		);
		const reviewed = createHash("sha256").update("official cli\n").digest("hex");
		const reviewedManifest = manifest();
		reviewedManifest.installation.officialPackageFiles = {
			"dist/cli.js": reviewed,
		};
		const adapters = createNodeAdapters({
			installation: { ...installation(), packagePath: packageRoot },
			manifest: reviewedManifest,
		});
		expect(await adapters.validatePackage(packageRoot, "official")).toBe(true);
		await writeFile(path.join(packageRoot, "dist/cli.js"), "modified cli\n");
		expect(await adapters.validatePackage(packageRoot, "official")).toBe(false);
	});

	it("uses owner-only journal and lock files", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-adapters-"));
		const packageRoot = path.join(root, "lib/node_modules/@earendil-works/pi-coding-agent");
		await mkdir(packageRoot, { recursive: true });
		const adapters = createNodeAdapters({
			installation: { ...installation(), packagePath: packageRoot },
			packageRoot: path.resolve("prewalk"),
			manifest: manifest(),
		});
		const lockPath = `${packageRoot}.prewalk.lock`;
		const release = await adapters.lock.acquire(lockPath);
		expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
		await expect(adapters.lock.acquire(lockPath)).rejects.toThrow(/lock/i);
		await release();
		const journalPath = `${packageRoot}.prewalk-journal.json`;
		await adapters.journal.write(journalPath, { phase: "prepared" });
		expect((await stat(journalPath)).mode & 0o777).toBe(0o600);
	});

	it("reclaims a lock left by an actually terminated updater process", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-stale-lock-"));
		try {
			const lockPath = path.join(root, "updater.lock");
			const moduleUrl = new URL("../updater/node-adapters.mjs", import.meta.url).href;
			const child = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					`import { acquireProcessLock } from ${JSON.stringify(moduleUrl)}; await acquireProcessLock(${JSON.stringify(lockPath)}); process.kill(process.pid, 'SIGKILL');`,
				],
				{ encoding: "utf8", timeout: 5_000 },
			);
			expect(child.signal).toBe("SIGKILL");
			expect(await readFile(lockPath, "utf8")).toContain("pid");
			const contenders = await Promise.allSettled([
				acquireProcessLock(lockPath),
				acquireProcessLock(lockPath),
			]);
			const winners = contenders.filter(
				(result): result is PromiseFulfilledResult<() => Promise<void>> =>
					result.status === "fulfilled",
			);
			expect(winners).toHaveLength(1);
			expect(contenders.filter((result) => result.status === "rejected")).toHaveLength(1);
			await winners[0].value();
			await expect(lstat(lockPath)).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("recovers when a terminated reclaimer leaves an orphaned claim", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-orphaned-reclaimer-"));
		try {
			const lockPath = path.join(root, "updater.lock");
			await writeFile(
				lockPath,
				`${JSON.stringify({ pid: 2_147_483_647, nonce: "dead-owner", createdAt: new Date(0).toISOString() })}\n`,
				{ mode: 0o600 },
			);
			const moduleUrl = new URL("../updater/node-adapters.mjs", import.meta.url).href;
			const child = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					`import { acquireProcessLock } from ${JSON.stringify(moduleUrl)}; await acquireProcessLock(${JSON.stringify(lockPath)}, { beforeStaleUnlink: async () => process.kill(process.pid, 'SIGKILL') });`,
				],
				{ encoding: "utf8", timeout: 5_000 },
			);
			expect(child.signal).toBe("SIGKILL");
			expect((await readdir(root)).some((entry) => entry.includes(".reclaim-"))).toBe(true);

			const release = await acquireProcessLock(lockPath);
			expect(JSON.parse(await readFile(lockPath, "utf8")).pid).toBe(process.pid);
			expect((await readdir(root)).some((entry) => entry.includes(".reclaim-"))).toBe(false);
			await release();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("serializes stale-lock reclamation without unlinking the replacement owner", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-lock-aba-"));
		try {
			const lockPath = path.join(root, "updater.lock");
			await writeFile(
				lockPath,
				`${JSON.stringify({ pid: 2_147_483_647, nonce: "dead-owner", createdAt: new Date(0).toISOString() })}\n`,
				{ mode: 0o600 },
			);
			let unblock!: () => void;
			const blocked = new Promise<void>((resolve) => {
				unblock = resolve;
			});
			let claimed!: () => void;
			const claimReached = new Promise<void>((resolve) => {
				claimed = resolve;
			});
			const first = acquireProcessLock(lockPath, {
				beforeStaleUnlink: async () => {
					claimed();
					await blocked;
				},
			});
			await claimReached;
			await expect(acquireProcessLock(lockPath)).rejects.toThrow(/held|reclaim/i);
			expect(JSON.parse(await readFile(lockPath, "utf8")).nonce).toBe("dead-owner");
			unblock();
			const release = await first;
			const replacement = JSON.parse(await readFile(lockPath, "utf8"));
			expect(replacement.nonce).not.toBe("dead-owner");
			await expect(acquireProcessLock(lockPath)).rejects.toThrow(/held/i);
			expect(JSON.parse(await readFile(lockPath, "utf8")).nonce).toBe(replacement.nonce);
			await release();
			await expect(lstat(lockPath)).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("recovers a journal after the live package rename leaves the pi link dangling", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-dangling-recovery-"));
		try {
			const prefix = path.join(await realpath(root), "prefix");
			const livePath = path.join(prefix, "lib/node_modules/@earendil-works/pi-coding-agent");
			const backupPath = `${livePath}.prewalk-backup`;
			const candidatePath = path.join(
				path.dirname(livePath),
				".pi-coding-agent.prewalk-candidate",
			);
			const executable = path.join(prefix, "bin/pi");
			await mkdir(path.join(livePath, "dist/core/extensions"), { recursive: true });
			await mkdir(path.dirname(executable), { recursive: true });
			const packageJson = `${JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.82.1" })}\n`;
			await writeFile(path.join(livePath, "package.json"), packageJson);
			await writeFile(path.join(livePath, "dist/cli.js"), "official cli\n");
			await writeFile(
				path.join(livePath, "dist/core/extensions/types.d.ts"),
				"export interface ExtensionAPI {}\n",
			);
			await symlink(
				"../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
				executable,
			);
			const treeSha256 = await hashPackageTree(livePath);
			const document = JSON.parse(
				await readFile(path.resolve("updater/supported-versions.json"), "utf8"),
			);
			const reviewedManifest = structuredClone(document.versions["0.82.1"]);
			reviewedManifest.installation.officialPackageFiles = {
				"package.json": createHash("sha256").update(packageJson).digest("hex"),
				"dist/cli.js": createHash("sha256").update("official cli\n").digest("hex"),
			};
			reviewedManifest.installation.officialPackageTreeSha256 = treeSha256;
			await rename(livePath, backupPath);
			await writeFile(
				`${livePath}.prewalk-journal.json`,
				`${JSON.stringify({
					schemaVersion: 1,
					manifestId: reviewedManifest.id,
					ownerId: "crashed-owner",
					phase: "backup-active",
					target: "patched",
					backupTarget: "official",
					candidateTreeSha256: "a".repeat(64),
					livePath,
					backupPath,
					candidatePath,
				})}\n`,
				{ mode: 0o600 },
			);
			const detected = await detectPiInstallation({
				executablePath: executable,
				platform: "darwin",
				arch: "arm64",
			});
			expect(detected.packagePath).toBe(livePath);
			const adapters = createNodeAdapters({
				installation: detected,
				manifest: reviewedManifest,
			});
			const result = await runRecoveredAction({
				manifest: reviewedManifest,
				installation: { ...detected },
				adapters,
				action: async () => {
					throw new Error("action must not run before recovery");
				},
			});
			expect(result.recovery?.status).toBe("recovered");
			expect(await realpath(executable)).toBe(path.join(livePath, "dist/cli.js"));
			await expect(lstat(`${livePath}.prewalk-journal.json`)).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("invalidates patched attestation when an installed byte is tampered", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-patched-hash-"));
		try {
			const packageRoot = path.join(root, "lib/node_modules/@earendil-works/pi-coding-agent");
			await mkdir(path.join(packageRoot, "dist/core/extensions"), { recursive: true });
			await writeFile(
				path.join(packageRoot, "package.json"),
				JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.82.1" }),
			);
			await writeFile(path.join(packageRoot, "dist/cli.js"), "patched cli\n");
			await writeFile(
				path.join(packageRoot, "dist/core/extensions/types.d.ts"),
				"setSessionModelAndThinkingLevel(): Promise<void>;\n",
			);
			const dependencyPath = path.join(packageRoot, "node_modules/dependency/index.js");
			await mkdir(path.dirname(dependencyPath), { recursive: true });
			await writeFile(dependencyPath, "export const value = 'verified';\n");
			const reviewedManifest = manifest();
			const packageTreeSha256 = await hashPackageTree(packageRoot);
			const adapters = createNodeAdapters({
				installation: { ...installation(), packagePath: packageRoot },
				manifest: reviewedManifest,
			});
			await adapters.attestation.write({
				schemaVersion: 1,
				manifestId: reviewedManifest.id,
				patchSha256: reviewedManifest.patch.sha256,
				releaseCommit: reviewedManifest.releaseCommit,
				packageTreeSha256,
			});
			expect(
				(
					await classifyInstallation({
						manifest: reviewedManifest,
						installation: { ...installation(), packagePath: packageRoot },
						adapters,
					})
				).status,
			).toBe("supported-patched");
			await writeFile(dependencyPath, "export const value = 'TAMPERED';\n");
			expect(
				(
					await classifyInstallation({
						manifest: reviewedManifest,
						installation: { ...installation(), packagePath: packageRoot },
						adapters,
					})
				).status,
			).toBe("damaged");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("lists and extracts a validated tarball into a fresh contained root", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-archive-valid-"));
		const source = path.join(root, "source");
		const destination = path.join(root, "destination");
		await mkdir(source);
		await writeFile(path.join(source, "file.txt"), "safe archive\n");
		const chunks: Buffer[] = [];
		const pack = createTar({ gzip: true, cwd: source }, ["file.txt"]);
		for await (const chunk of pack) chunks.push(Buffer.from(chunk));
		const bytes = Buffer.concat(chunks);
		const entries = await listTarArchive(bytes);
		await extractTarArchive({ bytes, destination, entries });
		expect(await readFile(path.join(destination, "file.txt"), "utf8")).toBe("safe archive\n");
	});

	it("applies reviewed path stripping without weakening containment", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-archive-strip-"));
		const source = path.join(root, "source");
		const destination = path.join(root, "destination");
		await mkdir(path.join(source, "archive-root"), { recursive: true });
		await writeFile(path.join(source, "archive-root/file.txt"), "stripped safely\n");
		const chunks: Buffer[] = [];
		const pack = createTar({ gzip: true, cwd: source }, ["archive-root/file.txt"]);
		for await (const chunk of pack) chunks.push(Buffer.from(chunk));
		const bytes = Buffer.concat(chunks);
		const entries = await listTarArchive(bytes);
		await extractTarArchive({
			bytes,
			destination,
			entries,
			stripComponents: 1,
		});
		expect(await readFile(path.join(destination, "file.txt"), "utf8")).toBe("stripped safely\n");
	});

	it("rejects archive entries that escape the staging root before extraction", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-archive-"));
		const outside = path.join(root, "outside.txt");
		await expect(
			extractTarArchive({
				bytes: Buffer.from("not-a-real-archive"),
				destination: path.join(root, "stage"),
				entries: [{ path: "../outside.txt", type: "file" }],
				stripComponents: 0,
			}),
		).rejects.toThrow(/unsafe|containment|archive/i);
		await expect(lstat(outside)).rejects.toThrow();
	});

	it("removes only known-hash legacy artifacts and preserves modified files", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-migrate-"));
		const known = path.join(root, "known.ts");
		const modified = path.join(root, "modified.ts");
		await writeFile(known, "known restart extension\n");
		await writeFile(modified, "user modified extension\n");
		const knownHash = createHash("sha256").update("known restart extension\n").digest("hex");
		const result = await migrateLegacyArtifacts({
			artifacts: [known, modified],
			knownHashes: [knownHash],
		});
		expect(result.removed).toEqual([known]);
		expect(result.preserved).toEqual([modified]);
		await expect(readFile(known)).rejects.toThrow();
		expect(await readFile(modified, "utf8")).toContain("user modified");
	});
});
