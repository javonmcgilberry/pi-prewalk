import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	type ProviderConfig,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import prewalkExtension from "../extensions/prewalk.js";
// @ts-expect-error The published extension artifact does not ship declarations.
import codexConversion from "../node_modules/@howaboua/pi-codex-conversion/dist/index.js";
import { DEFAULT_EXECUTOR, PLANNER_MODEL_ID } from "../src/core.js";

let temporaryRoot: string | undefined;

afterEach(async () => {
	delete process.env.PI_CODING_AGENT_DIR;
	if (temporaryRoot) {
		await rm(temporaryRoot, { recursive: true, force: true });
		temporaryRoot = undefined;
	}
});

describe("installed Codex conversion composition", () => {
	it("loads conversion 3.0.3 first and wraps its public stream without a request", async () => {
		temporaryRoot = await mkdtemp(path.join(tmpdir(), "prewalk-conversion-"));
		const agentDir = path.join(temporaryRoot, "agent");
		const workDir = path.join(temporaryRoot, "work");
		await Promise.all([
			mkdir(agentDir, { recursive: true }),
			mkdir(workDir, { recursive: true }),
		]);
		await writeFile(
			path.join(agentDir, "prewalk.json"),
			`${JSON.stringify({
				enabled: true,
				executor: DEFAULT_EXECUTOR,
			})}\n`,
		);
		await writeFile(
			path.join(agentDir, "auth.json"),
			`${JSON.stringify({
				"openai-codex": {
					type: "oauth",
					access: "integration-token",
					refresh: "integration-refresh",
					expires: Date.now() + 60_000,
				},
			})}\n`,
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;

		let conversionConfig: ProviderConfig | undefined;
		const probe: ExtensionFactory = (pi) => {
			pi.on("session_start", (_event, ctx) => {
				conversionConfig = ctx.modelRegistry.getRegisteredProviderConfig("openai-codex");
			});
		};
		const settings = SettingsManager.create(workDir, agentDir);
		const loader = new DefaultResourceLoader({
			cwd: workDir,
			agentDir,
			settingsManager: settings,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				{ name: "codex-conversion", factory: codexConversion },
				{ name: "conversion-probe", factory: probe },
				{ name: "prewalk", factory: prewalkExtension },
			],
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);

		const runtime = await ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"),
			modelsPath: null,
		});
		const planner = runtime.getModel("openai-codex", PLANNER_MODEL_ID);
		expect(planner).toBeDefined();
		if (!planner) return;
		const sessionManager = SessionManager.inMemory(workDir);
		const { session } = await createAgentSession({
			cwd: workDir,
			agentDir,
			modelRuntime: runtime,
			model: planner,
			resourceLoader: loader,
			settingsManager: settings,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});

		await session.bindExtensions({});

		const wrapped = runtime.getRegisteredProviderConfig("openai-codex");
		expect(conversionConfig?.api).toBe("openai-codex-responses");
		expect(conversionConfig?.streamSimple).toBeTypeOf("function");
		expect(wrapped?.streamSimple).toBeTypeOf("function");
		expect(wrapped?.streamSimple).not.toBe(conversionConfig?.streamSimple);
		expect(session.model?.id).toBe(PLANNER_MODEL_ID);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "message")).toEqual([]);
	});
});
