import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseConfig } from "../src/core.js";

const root = resolve(import.meta.dirname, "..");

async function text(path: string): Promise<string> {
	return readFile(resolve(root, path), "utf8");
}

describe("shipped package contract", () => {
	it("describes and packages the same-process extension, updater, and canaries", async () => {
		const pkg = JSON.parse(await text("package.json")) as {
			description: string;
			bin: Record<string, string>;
			files: string[];
			scripts: Record<string, string>;
		};

		expect(pkg.description).toContain("same-session");
		expect(pkg.description.toLowerCase()).not.toContain("restart");
		expect(pkg.bin).toEqual({
			"prewalk-update-pi": "./updater/cli.mjs",
		});
		expect(pkg.files).toEqual(
			expect.arrayContaining([
				"extensions",
				"src",
				"scripts",
				"updater",
				"README.md",
				"LICENSE",
				"prewalk.example.json",
			]),
		);
		expect(pkg.scripts).toMatchObject({
			"smoke:rpc": "node scripts/smoke-rpc.mjs",
			"canary:provider": "node scripts/canary-provider.mjs",
		});
	});

	it("documents the same-process lifecycle and safety boundaries", async () => {
		const readme = await text("README.md");
		for (const expected of [
			"first successful built-in `edit` or `write`",
			"read-only or no-change work finishes normally",
			"`turn_end` hook",
			"current `AgentSession`",
			"The handoff itself does not change Pi's saved provider",
			"complete configured authentication",
			"Cross-provider consent is bound to hashes",
			"safely extracts",
			"per-installation lock",
			"phase journal",
			"Release-only provider canary",
			"never credentials, full transcript",
		]) {
			expect(readme).toContain(expected);
		}
	});

	it("keeps runtime and operator documentation free of abandoned restart controls", async () => {
		const shipped = await Promise.all([
			text("README.md"),
			text("package.json"),
			text("prewalk.example.json"),
			text("extensions/prewalk.ts"),
			text("src/core.ts"),
			text("scripts/smoke-rpc.mjs"),
			text("scripts/canary-provider.mjs"),
		]);
		const combined = shipped.join("\n");

		const staleControls = [
			["--prewalk", "-handoff"].join(""),
			["/prewalk", " handoff"].join(""),
			["/prewalk", " exit"].join(""),
			["restart", " command"].join(""),
			["session", " restart"].join(""),
		];
		for (const stale of staleControls) {
			expect(combined.toLowerCase()).not.toContain(stale);
		}
	});

	it("ships a strict valid configuration example", async () => {
		const example = JSON.parse(await text("prewalk.example.json"));
		expect(parseConfig(example)).toEqual(example);
	});

	it("documents exact updater support and fail-closed recovery in CLI help", () => {
		const result = spawnSync(process.execPath, [resolve(root, "updater/cli.mjs"), "help"], {
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("0.82.1");
		expect(result.stdout).toContain("darwin/arm64");
		expect(result.stdout).toContain("npm-global");
		expect(result.stdout).toContain("per-installation lock");
		expect(result.stdout).toContain("durable");
		expect(result.stdout).toContain("safely extracts");
		expect(result.stdout).toContain("never\nruns the provider canary");
	});
});
