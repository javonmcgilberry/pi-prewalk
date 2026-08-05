import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { parseConfig } from "../src/core.js";

const root = resolve(import.meta.dirname, "..");

async function text(path: string): Promise<string> {
	return readFile(resolve(root, path), "utf8");
}

async function sourceFiles(directory: string): Promise<string[]> {
	const absoluteDirectory = resolve(root, directory);
	if (!existsSync(absoluteDirectory)) return [];

	const entries = await readdir(absoluteDirectory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) return sourceFiles(path);
			return /\.(?:mjs|ts)$/.test(entry.name) ? [path] : [];
		}),
	);
	return nested.flat();
}

function findProductionCasts(path: string, source: string): string[] {
	const scriptKind = path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
	const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
	const casts: string[] = [];

	function visit(node: ts.Node): void {
		if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
			const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
			casts.push(`${path}:${position.line + 1}`);
		}
		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return casts;
}

describe("shipped package contract", () => {
	it("describes and packages the fixed stock-Pi extension and canaries", async () => {
		const pkg = JSON.parse(await text("package.json")) as {
			description: string;
			bin?: Record<string, string>;
			files: string[];
			scripts: Record<string, string>;
			dependencies: Record<string, string>;
			peerDependencies?: Record<string, string>;
			devDependencies: Record<string, string>;
			pi: { extensions: string[] };
		};

		expect(pkg.description.toLowerCase()).toContain("same-session");
		expect(pkg.description).toContain("planner-to-executor");
		expect(pkg.description).toContain("stock Pi");
		expect(pkg.description.toLowerCase()).not.toContain("restart");
		expect(pkg.bin).toBeUndefined();
		expect(pkg.pi.extensions).toEqual(["./extensions/prewalk.ts"]);
		expect(await readdir(resolve(root, "extensions"))).toEqual(["prewalk.ts"]);
		expect(existsSync(resolve(root, "benchmark/extensions/benchmark-tools.ts"))).toBe(true);
		expect(existsSync(resolve(root, "benchmark/extensions/benchmark-attestation.ts"))).toBe(true);
		expect(pkg.files).toEqual(
			expect.arrayContaining([
				"benchmark",
				"extensions",
				"src",
				"scripts",
				"docs/README.md",
				"docs/analytics.md",
				"README.md",
				"LICENSE",
				"prewalk.example.json",
			]),
		);
		expect(pkg.files).not.toContain("updater");
		const packedAnalyticsFiles = await Promise.all(
			[
				"src/analytics.ts",
				"src/analytics-store.ts",
				"src/analytics-report.ts",
				"src/analytics-subagents.ts",
			].map(async (file) => existsSync(resolve(root, file))),
		);
		expect(packedAnalyticsFiles).toEqual([true, true, true, true]);
		expect(pkg.dependencies.tar).toBeUndefined();
		expect(pkg.dependencies["@howaboua/pi-codex-conversion"]).toBeUndefined();
		expect(pkg.dependencies["pi-subagents"]).toBeUndefined();
		expect(pkg.peerDependencies?.["@howaboua/pi-codex-conversion"]).toBeUndefined();
		expect(pkg.devDependencies).toMatchObject({
			"@biomejs/biome": "2.3.5",
			"@earendil-works/pi-agent-core": "0.82.1",
			"@earendil-works/pi-ai": "0.82.1",
			"@earendil-works/pi-coding-agent": "0.82.1",
			"@earendil-works/pi-tui": "0.82.1",
			"@howaboua/pi-codex-conversion": "3.0.3",
		});
		expect(pkg.scripts).toMatchObject({
			lint: "biome check .",
			"smoke:rpc": "node scripts/smoke-rpc.mjs",
			"canary:provider": "node scripts/canary-provider.mjs",
		});
	});

	it("compiles against published Pi without patched path aliases", async () => {
		const tsconfig = JSON.parse(await text("tsconfig.json")) as {
			compilerOptions: { baseUrl?: string; paths?: Record<string, string[]> };
		};
		expect(tsconfig.compilerOptions.baseUrl).toBeUndefined();
		expect(tsconfig.compilerOptions.paths).toBeUndefined();
		expect(JSON.stringify(tsconfig)).not.toContain("earendil-works-pi");
	});

	it("ships a strict same-provider planner and executor configuration", async () => {
		const example = JSON.parse(await text("prewalk.example.json"));
		expect(parseConfig(example)).toEqual(example);
		for (const key of ["target", "thinkingLevel", "crossProviderPairs", "provider"]) {
			expect(() => parseConfig({ ...example, [key]: "unsupported" })).toThrow(
				`Unknown Prewalk config field: ${key}.`,
			);
		}
	});

	it("contains no updater, patched API, private Pi import, or sibling checkout path", async () => {
		expect(existsSync(resolve(root, "updater"))).toBe(false);

		const paths = await Promise.all(
			["extensions", "src", "scripts"].map((directory) => sourceFiles(directory)),
		);
		const sources = await Promise.all(
			paths.flat().map(async (path) => `${path}\n${await text(path)}`),
		);
		const combined = sources.join("\n");
		for (const prohibited of [
			"setModelTemporary",
			"prewalk_checkpoint",
			"prewalk-update-pi",
			"earendil-works-pi",
		]) {
			expect(combined).not.toContain(prohibited);
		}
		expect(combined).not.toMatch(
			/from\s+["']@earendil-works\/pi-[^"']+\/(?:dist|src|lib|internal)(?:\/|["'])/,
		);
	});

	it("contains no production TypeScript casts", async () => {
		const paths = await Promise.all(
			["extensions", "src", "scripts"].map((directory) => sourceFiles(directory)),
		);
		const casts = (
			await Promise.all(
				paths
					.flat()
					.filter((path) => path.endsWith(".ts"))
					.map(async (path) => findProductionCasts(path, await text(path))),
			)
		).flat();

		expect(casts).toEqual([]);
	});
});
