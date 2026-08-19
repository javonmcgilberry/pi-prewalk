import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { parseConfig } from "../../src/config/prewalk-config.js";

const root = resolve(import.meta.dirname, "../..");

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

/**
 * Finds type assertions in production source.
 *
 * The rule targets assertions that overrule the type checker — `value as Foo`
 * and the equivalent `<Foo>value` — because production code is supposed to
 * narrow unknown input with guards instead of asserting a shape it never
 * verified.
 *
 * Const assertions (`as const`) are explicitly allowed. They assert no shape
 * and silence no error; they only ask for the narrowest literal type and add
 * `readonly`, which makes inference stricter rather than weaker.
 */
function findTypeAssertions(path: string, source: string): string[] {
	const scriptKind = path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
	const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
	const assertions: string[] = [];

	function visit(node: ts.Node): void {
		const asserted = ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
		if (asserted && !ts.isConstTypeReference(node.type)) {
			const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
			assertions.push(`${path}:${position.line + 1}`);
		}
		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return assertions;
}

describe("shipped package contract", () => {
	it("describes and packages the fixed stock-Pi extension and canaries", async () => {
		const pkg = JSON.parse(await text("package.json")) as {
			description: string;
			bin?: Record<string, string>;
			files: string[];
			scripts: Record<string, string>;
			dependencies?: Record<string, string>;
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
				"docs/architecture/repository-structure.md",
				"README.md",
				"LICENSE",
				"prewalk.example.json",
			]),
		);
		expect(pkg.files).not.toContain("updater");
		const packedAnalyticsFiles = await Promise.all(
			[
				"src/analytics/index.ts",
				"src/analytics/store.ts",
				"src/analytics/report.ts",
				"src/analytics/subagents.ts",
			].map(async (file) => existsSync(resolve(root, file))),
		);
		expect(packedAnalyticsFiles).toEqual([true, true, true, true]);
		expect(pkg.dependencies ?? {}).toEqual({});
		expect(pkg.peerDependencies).toEqual({
			"@earendil-works/pi-agent-core": "*",
			"@earendil-works/pi-ai": "*",
			"@earendil-works/pi-coding-agent": "*",
			"@earendil-works/pi-tui": "*",
			typebox: "*",
		});
		expect(pkg.devDependencies).toMatchObject({
			"@biomejs/biome": "2.3.5",
			"@earendil-works/pi-agent-core": "0.84.2",
			"@earendil-works/pi-ai": "0.84.2",
			"@earendil-works/pi-coding-agent": "0.84.2",
			"@earendil-works/pi-tui": "0.84.2",
			"@howaboua/pi-codex-conversion": "3.0.10",
			typebox: "1.3.8",
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

	it("verifies the actual packed artifact, not only the files allowlist", () => {
		const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
			cwd: root,
			encoding: "utf8",
		});
		const files = (JSON.parse(output)[0]?.files ?? []).map(
			(entry: { path: string }) => entry.path,
		);
		expect(files).toEqual(
			expect.arrayContaining([
				"extensions/prewalk.ts",
				"benchmark/extensions/benchmark-tools.ts",
				"benchmark/extensions/benchmark-attestation.ts",
				"src/orchestration/coordinator.ts",
				"prompts/prewalk-plan.md",
				"prompts/prewalk-recover.md",
				"README.md",
			]),
		);
		expect(files.some((file: string) => file.startsWith("test/"))).toBe(false);
		expect(files.some((file: string) => file.startsWith("docs/plans/"))).toBe(false);
	});

	it("ships a strict executor configuration that rejects unknown fields", async () => {
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

	it("narrows production input with guards instead of type assertions", async () => {
		const paths = await Promise.all(
			["extensions", "src", "scripts"].map((directory) => sourceFiles(directory)),
		);
		const assertions = (
			await Promise.all(
				paths
					.flat()
					.filter((path) => path.endsWith(".ts"))
					.map(async (path) => findTypeAssertions(path, await text(path))),
			)
		).flat();

		expect(
			assertions,
			`Production code must narrow unknown input with a type guard rather than assert its type. Replace the assertion at each location below, or move the code into a test. Const assertions (\`as const\`) are allowed and are not reported here.\n${assertions.join("\n")}`,
		).toEqual([]);
	});
});
