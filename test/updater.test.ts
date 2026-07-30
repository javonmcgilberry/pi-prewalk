import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createNodeAdapters } from "../updater/node-adapters.mjs";
import {
	extractPatchPaths,
	InjectedCrashError,
	restoreOfficialFromSource,
	runRecoveredAction,
	runUpdater,
	UpdaterError,
	validateArchiveEntries,
} from "../updater/update.mjs";

const RELEASE_COMMIT = "b4f293684bba718d59cc1157679bcf6157b3a7f5";
const SOURCE_URL = `https://codeload.github.com/earendil-works/pi/tar.gz/${RELEASE_COMMIT}`;
const SOURCE_ROOT = `pi-${RELEASE_COMMIT}`;
const LIVE = "/global/lib/node_modules/@earendil-works/pi-coding-agent";
const CANDIDATE = "/global/lib/node_modules/@earendil-works/.pi-coding-agent.prewalk-candidate";
const BACKUP = "/global/lib/node_modules/@earendil-works/.pi-coding-agent.prewalk-backup";
const JOURNAL = `${LIVE}.prewalk-journal.json`;
const PATCHED_TREE = "a".repeat(64);

function manifest() {
	return {
		schemaVersion: 1,
		id: "pi-coding-agent-0.82.1-darwin-arm64",
		packageName: "@earendil-works/pi-coding-agent",
		version: "0.82.1",
		releaseCommit: RELEASE_COMMIT,
		platform: "darwin",
		arch: "arm64",
		manager: "npm",
		topology: "npm-global",
		sourceArchive: {
			url: SOURCE_URL,
			sha256: "source-sha",
			root: SOURCE_ROOT,
			stripComponents: 1,
		},
		modelDataPackage: {
			url: "npm-url",
			sha256: "npm-sha",
			integrity: "sha512-fixture",
			root: "package/dist/providers/data",
			targetRoot: "packages/ai/src/providers/data",
			files: { "provider.json": "model-data-sha" },
		},
		sourceFiles: {
			"packages/coding-agent/src/core/agent-session.ts": {
				before: "before-sha",
				after: "after-sha",
			},
		},
		patch: {
			path: "updater/patches/pi.patch",
			sha256: "patch-sha",
			allowedPaths: ["packages/coding-agent/src/core/agent-session.ts"],
		},
		gates: {
			test: [{ id: "focused-test", argv: ["fixture", "test"] }],
			build: [{ id: "offline-build", argv: ["fixture", "build"] }],
			pack: [{ id: "pack", argv: ["fixture", "pack"] }],
			install: [{ id: "staged-install", argv: ["fixture", "install"] }],
			candidate: [{ id: "candidate-rpc", argv: ["fixture", "rpc"] }],
		},
		attestationSchemaVersion: 1,
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

interface FixtureOptions {
	attested?: boolean;
	failAt?: string;
	gateFailure?: string;
	invalidCandidateAfterSwap?: boolean;
	invalidCandidateBeforeSwap?: boolean;
	integrityValid?: boolean;
	lockFailure?: boolean;
	sameFilesystem?: boolean;
	archiveEntries?: Record<
		string,
		ReadonlyArray<{ path: string; type?: string; linkPath?: string }>
	>;
	hashOverrides?: Record<string, string>;
	journal?: unknown;
}

function fixture(options: FixtureOptions = {}) {
	const operations: string[] = [];
	const files = new Set([LIVE, CANDIDATE]);
	let journal = options.journal;
	let attestation = options.attested
		? {
				schemaVersion: 1,
				manifestId: manifest().id,
				patchSha256: manifest().patch.sha256,
				releaseCommit: manifest().releaseCommit,
				packageTreeSha256: PATCHED_TREE,
			}
		: undefined;
	let applied = false;
	let failAt = options.failAt;
	let failConsumed = false;

	const failpoint = (name: string) => {
		operations.push(`failpoint:${name}`);
		if (name === failAt && !failConsumed) {
			failConsumed = true;
			throw new InjectedCrashError(name);
		}
	};

	const adapters = {
		lock: {
			acquire: async (path: string) => {
				operations.push(`lock:${path}`);
				if (options.lockFailure) throw new UpdaterError("locked", "lock-held");
				return async () => operations.push("lock:release");
			},
		},
		journal: {
			read: async (path: string) => {
				operations.push(`journal:read:${path}`);
				return journal;
			},
			write: async (_path: string, value: unknown) => {
				journal = structuredClone(value);
				operations.push(`journal:write:${(value as { phase: string }).phase}`);
			},
			clear: async () => {
				journal = undefined;
				operations.push("journal:clear");
			},
		},
		fsyncFile: async () => operations.push("fsync:file"),
		fsyncDir: async () => operations.push("fsync:dir"),
		fetch: async (url: string) => {
			operations.push(`fetch:${url}`);
			return url === SOURCE_URL ? "source-bytes" : "npm-bytes";
		},
		hashBytes: async (value: string) => {
			const key = value.startsWith("diff --git ") ? "patch-bytes" : value;
			const defaults: Record<string, string> = {
				"source-bytes": "source-sha",
				"npm-bytes": "npm-sha",
				"patch-bytes": "patch-sha",
			};
			return options.hashOverrides?.[key] ?? defaults[key] ?? `sha:${key}`;
		},
		verifyIntegrity: async (_value: string, expected: string) =>
			(options.integrityValid ?? true) && expected === "sha512-fixture",
		archive: {
			list: async (value: string) =>
				options.archiveEntries?.[value] ?? [
					{
						path: value === "source-bytes" ? `${SOURCE_ROOT}/file` : "package/file",
						type: "file",
					},
				],
			extract: async (value: string, root: string) =>
				operations.push(`extract:${value}:${root}`),
		},
		createStaging: async () => {
			operations.push("staging:create");
			return {
				ownerId: "owner-1",
				root: "/stage/owner-1",
				sourceRoot: "/stage/owner-1/source",
				npmRoot: "/stage/owner-1/npm",
				candidatePath: CANDIDATE,
			};
		},
		cleanupOwnedStaging: async (owner: string) =>
			operations.push(`staging:cleanup-owned:${owner}`),
		hashFile: async (path: string) => {
			if (path.endsWith("provider.json"))
				return options.hashOverrides?.modelData ?? "model-data-sha";
			if (path.endsWith("agent-session.ts"))
				return applied
					? (options.hashOverrides?.afterSource ?? "after-sha")
					: (options.hashOverrides?.beforeSource ?? "before-sha");
			return `file:${path}`;
		},
		copyFile: async (from: string, to: string) => operations.push(`copy:${from}:${to}`),
		applyPatch: async (_root: string, _patch: string) => {
			operations.push("patch:apply");
			applied = true;
		},
		runGate: async (group: string, gate: { id: string; argv: string[] }) => {
			operations.push(`gate:${group}:${gate.id}`);
			if (options.gateFailure === `${group}:${gate.id}`)
				throw new UpdaterError("gate failed", "gate-failed");
		},
		hashPackageTree: async () => PATCHED_TREE,
		validatePackage: async (path: string, role: string) => {
			operations.push(`validate:${role}:${path}`);
			if (role === "active" && options.invalidCandidateAfterSwap && path === LIVE) return false;
			if (role === "candidate" && options.invalidCandidateBeforeSwap) return false;
			return files.has(path);
		},
		sameFilesystem: async () => options.sameFilesystem ?? true,
		exists: async (path: string) => files.has(path),
		rename: async (from: string, to: string) => {
			operations.push(`rename:${from}:${to}`);
			if (!files.has(from)) throw new Error(`missing ${from}`);
			files.delete(from);
			files.add(to);
		},
		removeOwned: async (path: string) => {
			operations.push(`remove:${path}`);
			files.delete(path);
		},
		attestation: {
			read: async () => attestation,
			write: async (value: unknown) => {
				attestation = structuredClone(value) as typeof attestation;
				operations.push("attestation:write");
			},
			clear: async () => {
				attestation = undefined;
				operations.push("attestation:clear");
			},
		},
		failpoint,
		now: () => "2026-07-29T00:00:00.000Z",
	};

	return {
		adapters,
		operations,
		files,
		get journal() {
			return journal;
		},
		setFailAt(value: string | undefined) {
			failAt = value;
			failConsumed = false;
		},
	};
}

const patch = {
	path: "updater/patches/pi.patch",
	contents:
		"diff --git a/packages/coding-agent/src/core/agent-session.ts b/packages/coding-agent/src/core/agent-session.ts\n",
};

describe("archive containment", () => {
	it.each([
		[[{ path: "/absolute", type: "file" }]],
		[[{ path: "../escape", type: "file" }]],
		[[{ path: "C:\\escape", type: "file" }]],
		[[{ path: "safe/link", type: "symlink", linkPath: "../../escape" }]],
		[[{ path: "safe/link", type: "hardlink", linkPath: "/escape" }]],
	])("rejects absolute, traversal, or escaping archive entries", (entries) => {
		expect(() => validateArchiveEntries(entries)).toThrow(UpdaterError);
	});

	it("accepts contained files and links", () => {
		expect(
			validateArchiveEntries([
				{ path: "package/file", type: "file" },
				{ path: "package/link", type: "symlink", linkPath: "file" },
			]),
		).toHaveLength(2);
	});

	it("rejects a link that escapes only after stripping the archive root", () => {
		expect(() =>
			validateArchiveEntries(
				[
					{
						path: "package/link",
						type: "symlink",
						linkPath: "../outside-after-strip",
					},
				],
				1,
			),
		).toThrow(UpdaterError);
	});
});

describe("manifest-driven updater", () => {
	it("stages and commits verified official source without applying the patch", async () => {
		const f = fixture({ attested: true });
		const result = await restoreOfficialFromSource({
			manifest: manifest(),
			installation: installation(),
			patch,
			adapters: f.adapters,
		});
		expect(result.status).toBe("restored");
		expect(f.operations).not.toContain("patch:apply");
		expect(f.operations).toContain("attestation:clear");
	});

	it("holds the installation lock through recovery inspection and a non-update action", async () => {
		const f = fixture();
		const result = await runRecoveredAction({
			manifest: manifest(),
			installation: installation(),
			adapters: f.adapters,
			action: async () => {
				f.operations.push("action:status");
				return "done";
			},
		});
		expect(result).toEqual({ recovery: null, value: "done" });
		expect(f.operations.slice(0, 3)).toEqual([
			`lock:${LIVE}.prewalk.lock`,
			`journal:read:${JOURNAL}`,
			"action:status",
		]);
		expect(f.operations.at(-1)).toBe("lock:release");
	});

	it("recovers and stops before a non-update action", async () => {
		const f = fixture({
			journal: {
				schemaVersion: 1,
				manifestId: manifest().id,
				ownerId: "owner-1",
				phase: "prepared",
				target: "patched",
				backupTarget: "official",
				candidateTreeSha256: PATCHED_TREE,
				livePath: LIVE,
				backupPath: BACKUP,
				candidatePath: CANDIDATE,
			},
		});
		const action = vi.fn();
		const result = await runRecoveredAction({
			manifest: manifest(),
			installation: installation(),
			adapters: f.adapters,
			action,
		});
		expect(result.recovery?.status).toBe("recovered");
		expect(action).not.toHaveBeenCalled();
	});

	it("has no import-time side effects", () => {
		const moduleUrl = new URL("../updater/update.mjs", import.meta.url).href;
		const imported = spawnSync(
			process.execPath,
			["--input-type=module", "--eval", `import(${JSON.stringify(moduleUrl)})`],
			{
				encoding: "utf8",
				timeout: 5_000,
			},
		);
		expect(imported.status).toBe(0);
		expect(imported.stdout).toBe("");
		expect(imported.stderr).toBe("");
	});

	it("validates, stages, and commits only after candidate validation", async () => {
		const state = fixture();
		const result = await runUpdater({
			manifest: manifest(),
			installation: installation(),
			patch,
			adapters: state.adapters,
		});
		expect(result.status).toBe("updated");
		const candidateValidated = state.operations.indexOf(`validate:candidate:${CANDIDATE}`);
		const liveRename = state.operations.indexOf(`rename:${LIVE}:${BACKUP}`);
		expect(candidateValidated).toBeGreaterThan(-1);
		expect(liveRename).toBeGreaterThan(candidateValidated);
		expect(state.files.has(LIVE)).toBe(true);
		expect(state.files.has(BACKUP)).toBe(true);
		expect(state.journal).toBeUndefined();
	});

	it("returns a verified no-op for a matching attestation", async () => {
		const state = fixture({ attested: true });
		const result = await runUpdater({
			manifest: manifest(),
			installation: installation(),
			patch,
			adapters: state.adapters,
		});
		expect(result.status).toBe("noop");
		expect(state.operations.some((entry) => entry.startsWith("fetch:"))).toBe(false);
	});

	it.each([
		["packageName", "other"],
		["version", "0.83.0"],
		["platform", "linux"],
		["arch", "x64"],
		["manager", "bun"],
		["topology", "unknown"],
	])("refuses an unsupported %s before staging", async (field, value) => {
		const state = fixture();
		const result = await runUpdater({
			manifest: manifest(),
			installation: installation({ [field]: value }),
			patch,
			adapters: state.adapters,
		});
		expect(result.status).toBe("refused");
		expect(state.operations).not.toContain("staging:create");
	});

	it("rejects a source URL or declared archive root not derived from the pinned commit", async () => {
		for (const sourceArchive of [
			{ ...manifest().sourceArchive, url: `${SOURCE_URL}-other` },
			{ ...manifest().sourceArchive, root: "pi-wrong" },
		]) {
			const changedManifest = manifest();
			changedManifest.sourceArchive = sourceArchive;
			const state = fixture();
			const result = await runUpdater({
				manifest: changedManifest,
				installation: installation(),
				patch,
				adapters: state.adapters,
			});
			expect(result).toMatchObject({
				status: "refused",
				reasonCode: "source-provenance-mismatch",
			});
			expect(state.operations).not.toContain("staging:create");
		}
	});

	it.each([
		["source-bytes", "wrong-source"],
		["npm-bytes", "wrong-npm"],
		["patch-bytes", "wrong-patch"],
		["modelData", "wrong-model-data"],
	])("refuses a mismatched provenance digest for %s", async (key, digest) => {
		const state = fixture({ hashOverrides: { [key]: digest } });
		const result = await runUpdater({
			manifest: manifest(),
			installation: installation(),
			patch,
			adapters: state.adapters,
		});
		expect(result.status).toBe("refused");
		expect(state.operations.some((entry) => entry.startsWith(`rename:${LIVE}:`))).toBe(false);
	});

	it.each([
		[
			"release archive root",
			{
				archiveEntries: {
					"source-bytes": [{ path: "pi-wrong/file", type: "file" }],
				},
			},
		],
		["npm integrity", { integrityValid: false }],
		["pre-patch source shape", { hashOverrides: { beforeSource: "wrong" } }],
		["post-patch source shape", { hashOverrides: { afterSource: "wrong" } }],
		["candidate validation", { invalidCandidateBeforeSwap: true }],
		["same-filesystem topology", { sameFilesystem: false }],
	] as const)("refuses a mismatched %s before live mutation", async (_label, options) => {
		const state = fixture(options);
		const result = await runUpdater({
			manifest: manifest(),
			installation: installation(),
			patch,
			adapters: state.adapters,
		});
		expect(result.status).toBe("refused");
		expect(state.operations.some((entry) => entry.startsWith(`rename:${LIVE}:`))).toBe(false);
	});

	it("refuses a patch whose changed paths differ from the manifest allowlist", async () => {
		const state = fixture();
		const mismatchedManifest = manifest();
		mismatchedManifest.patch.allowedPaths = ["packages/coding-agent/src/other.ts"];
		const result = await runUpdater({
			manifest: mismatchedManifest,
			installation: installation(),
			patch,
			adapters: state.adapters,
		});
		expect(result).toMatchObject({
			status: "refused",
			reasonCode: "patch-scope-mismatch",
		});
		expect(state.operations).not.toContain("patch:apply");
	});

	it("rejects hostile source and npm archive fixtures before extraction", async () => {
		for (const [bytes, fixtureName] of [
			["source-bytes", "hostile-source.json"],
			["npm-bytes", "hostile-npm.json"],
		] as const) {
			const entries = JSON.parse(
				await readFile(
					new URL(`./fixtures/updater/archives/${fixtureName}`, import.meta.url),
					"utf8",
				),
			) as Array<{ path: string; type?: string; linkPath?: string }>;
			const state = fixture({ archiveEntries: { [bytes]: entries } });
			const result = await runUpdater({
				manifest: manifest(),
				installation: installation(),
				patch,
				adapters: state.adapters,
			});
			expect(result.status).toBe("refused");
			expect(state.operations.some((entry) => entry.startsWith(`extract:${bytes}`))).toBe(false);
		}
	});

	it.each([
		"test:focused-test",
		"build:offline-build",
		"pack:pack",
		"install:staged-install",
		"candidate:candidate-rpc",
	])("leaves the live install untouched when %s fails", async (gateFailure) => {
		const state = fixture({ gateFailure });
		const result = await runUpdater({
			manifest: manifest(),
			installation: installation(),
			patch,
			adapters: state.adapters,
		});
		expect(result.status).toBe("refused");
		expect(state.files.has(LIVE)).toBe(true);
		expect(state.operations.some((entry) => entry.startsWith(`rename:${LIVE}:`))).toBe(false);
	});

	it("rolls back a handled post-swap validation failure", async () => {
		const state = fixture({ invalidCandidateAfterSwap: true });
		const result = await runUpdater({
			manifest: manifest(),
			installation: installation(),
			patch,
			adapters: state.adapters,
		});
		expect(result.status).toBe("rolled-back");
		expect(state.files.has(LIVE)).toBe(true);
		expect(state.journal).toBeUndefined();
		expect(state.operations).toContain("attestation:clear");
	});

	it("acquires the lock before journal inspection", async () => {
		const state = fixture({ attested: true });
		await runUpdater({
			manifest: manifest(),
			installation: installation(),
			patch,
			adapters: state.adapters,
		});
		expect(state.operations[0]).toMatch(/^lock:/);
		expect(state.operations[1]).toBe(`journal:read:${JOURNAL}`);
	});

	it("serializes concurrent recovery before journal inspection", async () => {
		const state = fixture({
			lockFailure: true,
			journal: {
				schemaVersion: 1,
				manifestId: manifest().id,
				ownerId: "owner-1",
				phase: "prepared",
				target: "patched",
				backupTarget: "official",
				candidateTreeSha256: PATCHED_TREE,
				livePath: LIVE,
				backupPath: BACKUP,
				candidatePath: CANDIDATE,
			},
		});
		const result = await runUpdater({
			manifest: manifest(),
			installation: installation(),
			patch,
			adapters: state.adapters,
		});
		expect(result.status).toBe("refused");
		expect(state.operations.some((entry) => entry.startsWith("journal:read"))).toBe(false);
	});

	it.each([
		"journal-write:prepared",
		"journal-fsync:prepared",
		"rename:live-to-backup",
		"journal-write:backup-active",
		"journal-fsync:backup-active",
		"rename:candidate-to-live",
		"journal-write:candidate-active",
		"journal-fsync:candidate-active",
	])("recovers after an abrupt failure at %s", async (failAt) => {
		const state = fixture({ failAt });
		await expect(
			runUpdater({
				manifest: manifest(),
				installation: installation(),
				patch,
				adapters: state.adapters,
			}),
		).rejects.toBeInstanceOf(InjectedCrashError);
		state.setFailAt(undefined);
		const result = await runUpdater({
			manifest: manifest(),
			installation: installation(),
			patch,
			adapters: state.adapters,
		});
		expect(result.status).toBe("recovered");
		expect(state.files.has(LIVE)).toBe(true);
		expect(state.journal).toBeUndefined();
	});

	it.each(["journal-clear", "journal-clear-fsync"])(
		"returns a verified no-op after a crash at %s",
		async (failAt) => {
			const state = fixture({ failAt });
			await expect(
				runUpdater({
					manifest: manifest(),
					installation: installation(),
					patch,
					adapters: state.adapters,
				}),
			).rejects.toBeInstanceOf(InjectedCrashError);
			state.setFailAt(undefined);
			const result = await runUpdater({
				manifest: manifest(),
				installation: installation(),
				patch,
				adapters: state.adapters,
			});
			expect(result.status).toBe("noop");
			expect(state.files.has(LIVE)).toBe(true);
			expect(state.journal).toBeUndefined();
		},
	);

	it("blocks on a corrupt or foreign journal without renaming", async () => {
		const state = fixture({
			journal: { schemaVersion: 99, livePath: "/other" },
		});
		const result = await runUpdater({
			manifest: manifest(),
			installation: installation(),
			patch,
			adapters: state.adapters,
		});
		expect(result.status).toBe("recovery-required");
		expect(state.operations.some((entry) => entry.startsWith("rename:"))).toBe(false);
	});

	it("cleans only updater-owned stale staging after the manifest gate", async () => {
		const state = fixture();
		await runUpdater({
			manifest: manifest(),
			installation: installation(),
			patch,
			adapters: state.adapters,
		});
		expect(state.operations).toContain(`staging:cleanup-owned:${manifest().id}`);
	});

	it("rejects gate argv drift against the independently reviewed descriptors", async () => {
		const document = JSON.parse(
			await readFile(new URL("../updater/supported-versions.json", import.meta.url), "utf8"),
		);
		const supported = document.versions["0.82.1"];
		const changedArgv = structuredClone(supported);
		changedArgv.gates.test[0].argv = ["npm", "--version"];
		expect(() =>
			createNodeAdapters({
				installation: { packagePath: "/tmp/live" },
				manifest: changedArgv,
			}),
		).toThrow(/not reviewed/);
		const missingGate = structuredClone(supported);
		missingGate.gates.test.pop();
		expect(() =>
			createNodeAdapters({
				installation: { packagePath: "/tmp/live" },
				manifest: missingGate,
			}),
		).toThrow(/not reviewed/);

		const root = await mkdtemp(path.join(tmpdir(), "prewalk-gate-drift-"));
		try {
			const adapters = createNodeAdapters({
				installation: { packagePath: path.join(root, "live") },
				manifest: supported,
			});
			const staging = await adapters.createStaging();
			await expect(
				adapters.runGate("test", { id: "npm-ci", argv: ["npm", "--version"] }, staging),
			).rejects.toMatchObject({ code: "manifest-invalid" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("returns a redacted report without installation paths or credentials", async () => {
		const state = fixture();
		const result = await runUpdater({
			manifest: manifest(),
			installation: installation(),
			patch,
			adapters: state.adapters,
		});
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("/global/");
		expect(serialized).not.toMatch(/token|api[_-]?key|credential/i);
		expect(result).toMatchObject({
			manifestId: manifest().id,
			releaseCommit: manifest().releaseCommit,
		});
	});
});

describe("reviewed patch asset", () => {
	it("is bound by the 0.82.1 manifest and contains only reviewed host paths", async () => {
		const patchPath = new URL(
			"../updater/patches/pi-coding-agent-0.82.1-b4f293684bba718d59cc1157679bcf6157b3a7f5.patch",
			import.meta.url,
		);
		const manifestDocument = JSON.parse(
			await readFile(new URL("../updater/supported-versions.json", import.meta.url), "utf8"),
		) as { versions: Record<string, ReturnType<typeof manifest>> };
		const supported = manifestDocument.versions["0.82.1"];
		const contents = await readFile(patchPath, "utf8");
		const paths = extractPatchPaths(contents);
		expect(supported).toMatchObject({
			packageName: "@earendil-works/pi-coding-agent",
			version: "0.82.1",
			releaseCommit: "b4f293684bba718d59cc1157679bcf6157b3a7f5",
			platform: "darwin",
			arch: "arm64",
			manager: "npm",
			topology: "npm-global",
		});
		expect(supported.sourceArchive).toMatchObject({
			url: SOURCE_URL,
			root: SOURCE_ROOT,
		});
		expect(supported.gates.test).toEqual(
			expect.arrayContaining([
				{ id: "npm-ci", argv: ["npm", "ci"] },
				{
					id: "focused-tests",
					argv: expect.arrayContaining([
						"npm",
						"test",
						"test/suite/agent-session-model-extension.test.ts",
					]),
				},
			]),
		);
		expect(createHash("sha256").update(contents).digest("hex")).toBe(supported.patch.sha256);
		expect(paths).toEqual(supported.patch.allowedPaths);
		expect(paths).toEqual([
			"packages/coding-agent/docs/extensions.md",
			"packages/coding-agent/src/core/agent-session.ts",
			"packages/coding-agent/src/core/extensions/index.ts",
			"packages/coding-agent/src/core/extensions/loader.ts",
			"packages/coding-agent/src/core/extensions/runner.ts",
			"packages/coding-agent/src/core/extensions/types.ts",
			"packages/coding-agent/src/core/model-registry.ts",
			"packages/coding-agent/src/core/model-runtime.ts",
			"packages/coding-agent/src/core/provider-composer.ts",
			"packages/coding-agent/src/index.ts",
			"packages/coding-agent/test/extensions-runner.test.ts",
			"packages/coding-agent/test/suite/agent-session-model-extension.test.ts",
		]);
		expect(Object.keys(supported.sourceFiles)).toEqual(paths);
		expect(Object.keys(supported.modelDataPackage.files).length).toBeGreaterThan(30);
	});
});
