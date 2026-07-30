import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildEvidenceSummary,
	CANARY_CONFIRMATION,
	parseCanaryArgs,
	pruneEvidence,
	validateCanaryOptions,
	writeEvidence,
} from "../scripts/canary-support.mjs";
import { buildRpcLaunchArgs, parseModelRef } from "../scripts/rpc-support.mjs";
import {
	containsHiddenGuidance,
	HIDDEN_GUIDANCE_SENTINEL,
	isThinkingLevel,
	THINKING_LEVELS,
} from "../src/protocol.mjs";
import { normalizeBaseUrl, recipientFingerprint } from "../src/recipient-identity.mjs";

describe("RPC smoke support", () => {
	it("parses explicit model references and builds only the supported live-session RPC launch", () => {
		expect(parseModelRef("prewalk-smoke/planner")).toEqual({
			provider: "prewalk-smoke",
			id: "planner",
		});
		expect(() => parseModelRef("planner")).toThrow(/provider\/model/);
		expect(
			buildRpcLaunchArgs({
				extensionPath: "/tmp/extension.mjs",
				sessionPath: "/tmp/session.jsonl",
				model: "prewalk-smoke/planner",
				thinking: "off",
			}),
		).toEqual([
			"--mode",
			"rpc",
			"--session",
			"/tmp/session.jsonl",
			"--model",
			"prewalk-smoke/planner",
			"--thinking",
			"off",
			"-e",
			"/tmp/extension.mjs",
		]);
	});
});

describe("shared handoff protocol", () => {
	it("keeps thinking levels and effective recipient fingerprints byte-stable", () => {
		expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		expect(THINKING_LEVELS.every(isThinkingLevel)).toBe(true);
		expect(isThinkingLevel("extreme")).toBe(false);
		expect(normalizeBaseUrl("https://user:secret@provider.example/v1///?z=2&a=1#x")).toBe(
			"https://provider.example/v1?a=1&z=2",
		);
		const selected = {
			provider: "provider-a",
			id: "target",
			api: "openai-completions",
			baseUrl: "https://model.example/v1///?b=2&a=1#fragment",
		};
		const registry = (streamImplementationId: string | undefined) => ({
			getRecipientDescriptor: () => ({
				provider: selected.provider,
				providerBaseUrl: "https://user:secret@provider.example/v1///?z=2&a=1#x",
				modelBaseUrl: selected.baseUrl,
				api: selected.api,
				model: selected.id,
				streamImplementationId,
			}),
		});
		const first = recipientFingerprint(registry("stream@1"), selected);
		const second = recipientFingerprint(registry("stream@2"), selected);
		expect(first).toMatch(/^[a-f0-9]{64}$/);
		expect(second).toMatch(/^[a-f0-9]{64}$/);
		expect(second).not.toBe(first);
		expect(
			recipientFingerprint(registry(undefined), selected, {
				requireStreamIdentity: true,
			}),
		).toBeUndefined();
	});
});

describe("provider canary guards", () => {
	it("allows the persisted checkpoint while rejecting the context-only sentinel", () => {
		expect(
			containsHiddenGuidance({
				role: "toolResult",
				content: "Prewalk checkpoint accepted. Handoff checklist: 1. implement",
			}),
		).toBe(false);
		expect(
			containsHiddenGuidance({
				payload: [{ role: "user", content: `${HIDDEN_GUIDANCE_SENTINEL}\nplanning` }],
			}),
		).toBe(true);
	});

	it("rejects missing opt-in, target, and exact cross-provider consent before runtime", () => {
		const base = parseCanaryArgs([
			"--planner",
			"provider-a/planner",
			"--target",
			"provider-b/target",
		]);
		expect(() => validateCanaryOptions(base)).toThrow(/explicit provider-cost opt-in/);
		base.confirmation = CANARY_CONFIRMATION;
		expect(() => validateCanaryOptions(base)).toThrow(/recipient consent/);
		base.consent = `${"a".repeat(64)}->${"b".repeat(64)}`;
		expect(validateCanaryOptions(base)).toMatchObject({
			planner: { provider: "provider-a", id: "planner" },
			target: { provider: "provider-b", id: "target" },
		});
	});

	it("ships a static guard that consumes owner-only scenario data and shared identity", async () => {
		const providerSource = await readFile(
			new URL("../scripts/canary-provider.mjs", import.meta.url),
			"utf8",
		);
		const guardSource = await readFile(
			new URL("../scripts/canary-guard.mjs", import.meta.url),
			"utf8",
		);
		expect(providerSource).not.toContain("guardExtensionSource");
		expect(providerSource).toContain("PREWALK_CANARY_SCENARIO");
		expect(providerSource).toContain("{ mode: 0o600 }");
		expect(guardSource).toContain("recipientFingerprint");
		expect(guardSource).toContain('pi.on("before_provider_request"');
		expect(guardSource).toContain("finalTargetPayloadGuidanceFree");
		expect(guardSource).toContain("scenario.targetProvider");
		expect(guardSource).toContain("scenarioStat.mode & 0o077");
	});

	it("builds redacted evidence without transcript, settings, credentials, or host paths", () => {
		const summary = buildEvidenceSummary({
			now: new Date("2026-07-29T00:00:00.000Z"),
			retentionMs: 60_000,
			outcome: "passed",
			planner: { provider: "provider-a", id: "planner" },
			target: { provider: "provider-b", id: "target" },
			requestModels: ["provider-a/planner", "provider-b/target"],
			requestCount: 2,
			checkpointCount: 1,
			mutationCount: 1,
			assertions: ["same-session", "hidden-guidance-absent"],
		});
		const serialized = JSON.stringify(summary);
		expect(serialized).not.toContain("transcript");
		expect(serialized).not.toContain("settings");
		expect(serialized).not.toContain("credential");
		expect(serialized).not.toContain("/Users/");
		expect(summary.expiresAt).toBe("2026-07-29T00:01:00.000Z");
	});

	it("rejects symlinked evidence directories before cleanup or write", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-evidence-link-test-"));
		try {
			const victim = path.join(root, "victim");
			const evidence = path.join(root, "evidence");
			await mkdir(victim);
			await writeFile(
				path.join(victim, "prewalk-canary-victim.json"),
				JSON.stringify({ schemaVersion: 1, expiresAt: "2000-01-01T00:00:00.000Z" }),
			);
			await symlink(victim, evidence);
			await expect(pruneEvidence(evidence)).rejects.toThrow(/not a symlink/);
			const summary = buildEvidenceSummary({
				now: new Date("2026-07-29T00:00:00.000Z"),
				retentionMs: 1_000,
				outcome: "failed",
				planner: { provider: "a", id: "p" },
				target: { provider: "a", id: "t" },
				requestModels: [],
				requestCount: 0,
				checkpointCount: 0,
				mutationCount: 0,
				assertions: [],
			});
			await expect(writeEvidence(evidence, summary)).rejects.toThrow(/not a symlink/);
			expect(await readFile(path.join(victim, "prewalk-canary-victim.json"), "utf8")).toContain(
				"expiresAt",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("writes owner-only evidence and prunes only expired evidence", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "prewalk-evidence-test-"));
		try {
			const summary = buildEvidenceSummary({
				now: new Date("2026-07-29T00:00:00.000Z"),
				retentionMs: 1_000,
				outcome: "passed",
				planner: { provider: "provider-a", id: "planner" },
				target: { provider: "provider-a", id: "target" },
				requestModels: ["provider-a/planner", "provider-a/target"],
				requestCount: 2,
				checkpointCount: 1,
				mutationCount: 1,
				assertions: ["same-session", "settings-byte-identical"],
			});
			const filePath = await writeEvidence(root, summary);
			expect((await stat(root)).mode & 0o777).toBe(0o700);
			expect((await stat(filePath)).mode & 0o777).toBe(0o600);
			expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(summary);
			const keepPath = path.join(root, "notes.txt");
			await writeFile(keepPath, "keep");
			const removed = await pruneEvidence(root, new Date("2026-07-29T00:00:02.000Z"));
			expect(removed).toEqual([filePath]);
			expect(await readFile(keepPath, "utf8")).toBe("keep");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
