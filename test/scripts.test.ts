import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildEvidenceSummary,
	CANARY_CONFIRMATION,
	containsCanaryHiddenGuidance,
	parseCanaryArgs,
	pruneEvidence,
	stageOpenAICodexCredential,
	validateCanaryOptions,
	writeEvidence,
} from "../scripts/canary-support.mjs";
import { buildRpcLaunchArgs, parseModelRef, RpcProcess } from "../scripts/rpc-support.mjs";

const digest = "a".repeat(64);
const canaryScript = path.resolve("scripts/canary-provider.mjs");

function waitForExit(child: ReturnType<typeof spawn>) {
	return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }>(
		(resolve) => {
			let stdout = "";
			child.stdout?.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			child.once("exit", (code, signal) => resolve({ code, signal, stdout }));
		},
	);
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for child-process state.");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function evidence() {
	return buildEvidenceSummary({
		now: new Date("2026-07-30T00:00:00.000Z"),
		retentionMs: 60_000,
		outcome: "passed",
		requestModels: ["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-luna"],
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: 0.02,
		},
		status: "completed",
		trigger: "edit",
		settingsBefore: digest,
		settingsAfter: digest,
		assertions: ["selected-sol", "luna-observed"],
	});
}

describe("RPC smoke support", () => {
	it("builds a conversion-first multi-extension launch", () => {
		expect(parseModelRef("openai-codex/gpt-5.6-sol")).toEqual({
			provider: "openai-codex",
			id: "gpt-5.6-sol",
		});
		expect(
			buildRpcLaunchArgs({
				extensionPath: "/tmp/conversion.js",
				extraExtensions: ["/tmp/prewalk.ts"],
				sessionPath: "/tmp/session.jsonl",
				model: "openai-codex/gpt-5.6-sol",
				thinking: "high",
			}),
		).toEqual([
			"--mode",
			"rpc",
			"--session",
			"/tmp/session.jsonl",
			"--model",
			"openai-codex/gpt-5.6-sol",
			"--thinking",
			"high",
			"-e",
			"/tmp/conversion.js",
			"-e",
			"/tmp/prewalk.ts",
		]);
	});

	it("bounds shutdown when an RPC child ignores stdin and SIGTERM", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-rpc-close-"));
		try {
			const script = path.join(root, "ignore-term.mjs");
			await writeFile(
				script,
				'process.on("SIGTERM", () => {}); process.stdin.resume(); setInterval(() => {}, 1000);',
			);
			const rpc = new RpcProcess({
				executable: script,
				args: [],
				cwd: root,
				env: process.env,
			});
			const started = Date.now();
			await rpc.close();
			expect(Date.now() - started).toBeLessThan(6_000);
			expect(rpc.child.signalCode).toBe("SIGKILL");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 10_000);
});

describe("provider canary contract", () => {
	it("detects exact hidden planning and continuation guidance in provider payloads", () => {
		const prompts = ["hidden plan prompt", "hidden continuation prompt"];
		expect(
			containsCanaryHiddenGuidance({ messages: [{ content: "hidden plan prompt" }] }, prompts),
		).toBe(true);
		expect(
			containsCanaryHiddenGuidance(
				{ messages: [{ content: "public task and executor checklist" }] },
				prompts,
			),
		).toBe(false);
	});

	it("requires explicit cost consent and an absolute auth source", () => {
		const options = parseCanaryArgs([]);
		expect(() => validateCanaryOptions(options)).toThrow(/explicit provider-cost/);
		options.confirmation = CANARY_CONFIRMATION;
		expect(() => validateCanaryOptions(options)).toThrow(/absolute --auth-file/);
		options.authFile = "/tmp/auth.json";
		expect(validateCanaryOptions(options)).toBe(options);
	});

	it("stages only the openai-codex credential in an owner-only file", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-credential-"));
		try {
			const source = path.join(root, "source.json");
			const target = path.join(root, "target.json");
			await writeFile(
				source,
				JSON.stringify({
					"openai-codex": {
						type: "oauth",
						access: "access",
						refresh: "refresh",
						expires: 1,
					},
					anthropic: { type: "api_key", key: "other-secret" },
				}),
			);
			await stageOpenAICodexCredential(source, target);
			const staged = JSON.parse(await readFile(target, "utf8"));
			expect(Object.keys(staged)).toEqual(["openai-codex"]);
			expect((await stat(target)).mode & 0o777).toBe(0o600);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("builds allowlisted redacted evidence", () => {
		const summary = evidence();
		expect(summary.expiresAt).toBe("2026-07-30T00:01:00.000Z");
		expect(JSON.stringify(summary)).not.toMatch(
			/(transcript|credential|authorization|\/Users\/)/i,
		);
		expect(Object.keys(summary).sort()).toEqual([
			"assertions",
			"createdAt",
			"expiresAt",
			"outcome",
			"requestModels",
			"schemaVersion",
			"settingsAfter",
			"settingsBefore",
			"status",
			"trigger",
			"usage",
		]);
	});

	it("rejects symlinked evidence directories", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-evidence-link-"));
		try {
			const victim = path.join(root, "victim");
			const evidenceDir = path.join(root, "evidence");
			await mkdir(victim);
			await symlink(victim, evidenceDir);
			await expect(writeEvidence(evidenceDir, evidence())).rejects.toThrow(/not a symlink/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("writes owner-only evidence and prunes only expired records", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-evidence-"));
		try {
			const filePath = await writeEvidence(root, evidence());
			expect((await stat(root)).mode & 0o777).toBe(0o700);
			expect((await stat(filePath)).mode & 0o777).toBe(0o600);
			const keepPath = path.join(root, "notes.txt");
			await writeFile(keepPath, "keep");
			expect(await pruneEvidence(root, new Date("2026-07-30T00:02:00.000Z"))).toEqual([
				filePath,
			]);
			expect(await readFile(keepPath, "utf8")).toBe("keep");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("writes redacted evidence for setup failures and exits nonzero", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-canary-failure-"));
		try {
			const authFile = path.join(root, "auth.json");
			const evidenceDir = path.join(root, "evidence");
			await writeFile(authFile, "{}\n");
			const child = spawn(
				process.execPath,
				[
					canaryScript,
					"--confirm-provider-cost",
					CANARY_CONFIRMATION,
					"--auth-file",
					authFile,
					"--evidence-dir",
					evidenceDir,
				],
				{ cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"] },
			);
			const result = await waitForExit(child);
			expect(result.code).toBe(1);
			const output = JSON.parse(result.stdout.trim());
			expect(output).toMatchObject({
				ok: false,
				reasonCode: "canary-runtime-failed",
			});
			const summary = JSON.parse(await readFile(output.evidence, "utf8"));
			expect(summary).toMatchObject({
				outcome: "failed",
				status: "failed:canary-runtime-failed",
			});
			expect(JSON.stringify(summary)).not.toMatch(
				/(credential|authorization|access[_-]?token|refresh[_-]?token|\/Users\/|\/tmp\/)/i,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("never prints raw provider stderr", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-canary-stderr-"));
		try {
			const authFile = path.join(root, "auth.json");
			const evidenceDir = path.join(root, "evidence");
			const failingPi = path.join(root, "failing-pi.mjs");
			await writeFile(
				authFile,
				`${JSON.stringify({
					"openai-codex": {
						type: "oauth",
						access: "test-access",
						refresh: "test-refresh",
						expires: Date.now() + 60_000,
					},
				})}\n`,
			);
			await writeFile(
				failingPi,
				'console.error("error access_token=super-secret"); process.exit(1);\n',
			);
			const child = spawn(
				process.execPath,
				[
					canaryScript,
					"--confirm-provider-cost",
					CANARY_CONFIRMATION,
					"--auth-file",
					authFile,
					"--evidence-dir",
					evidenceDir,
					"--pi",
					failingPi,
				],
				{ cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"] },
			);
			let stderr = "";
			child.stderr?.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			const result = await waitForExit(child);
			expect(result.code).toBe(1);
			expect(`${result.stdout}\n${stderr}`).not.toContain("super-secret");
			expect(JSON.parse(result.stdout.trim()).reasonCode).toBe("pi-actionable-stderr");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("removes staged credentials and writes failure evidence on SIGTERM", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-canary-signal-"));
		const before = new Set(
			(await readdir(tmpdir())).filter((entry) => entry.startsWith("prewalk-canary-")),
		);
		let child: ReturnType<typeof spawn> | undefined;
		try {
			const authFile = path.join(root, "auth.json");
			const evidenceDir = path.join(root, "evidence");
			const hangingPi = path.join(root, "hanging-pi.mjs");
			await writeFile(
				authFile,
				`${JSON.stringify({
					"openai-codex": {
						type: "oauth",
						access: "test-access",
						refresh: "test-refresh",
						expires: Date.now() + 60_000,
					},
				})}\n`,
			);
			await writeFile(hangingPi, "process.stdin.resume(); setInterval(() => {}, 1000);\n");
			child = spawn(
				process.execPath,
				[
					canaryScript,
					"--confirm-provider-cost",
					CANARY_CONFIRMATION,
					"--auth-file",
					authFile,
					"--evidence-dir",
					evidenceDir,
					"--pi",
					hangingPi,
					"--timeout-ms",
					"30000",
				],
				{ cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"] },
			);
			const exit = waitForExit(child);
			let temporaryName = "";
			await waitUntil(async () => {
				const candidates = (await readdir(tmpdir())).filter(
					(entry) => entry.startsWith("prewalk-canary-") && !before.has(entry),
				);
				for (const candidate of candidates) {
					try {
						await stat(path.join(tmpdir(), candidate, "agent", "auth.json"));
						temporaryName = candidate;
						return true;
					} catch {}
				}
				return false;
			});
			child.kill("SIGTERM");
			const result = await exit;
			expect(result.signal, JSON.stringify(result)).toBe("SIGTERM");
			await expect(stat(path.join(tmpdir(), temporaryName))).rejects.toThrow();
			const evidenceFiles = await readdir(evidenceDir);
			expect(evidenceFiles).toHaveLength(1);
			const summary = JSON.parse(
				await readFile(path.join(evidenceDir, evidenceFiles[0] ?? ""), "utf8"),
			);
			expect(summary).toMatchObject({
				outcome: "failed",
				status: "failed:signal-sigterm",
			});
		} finally {
			child?.kill("SIGKILL");
			await rm(root, { recursive: true, force: true });
		}
	}, 15_000);
});
