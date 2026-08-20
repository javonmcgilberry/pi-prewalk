import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import prewalkExtension from "../../extensions/prewalk.js";
import { DEFAULT_EXECUTOR, PLANNER_MODEL_ID } from "../../src/orchestration/coordinator.js";

function model(): Model<"openai-codex-responses"> {
	return {
		id: PLANNER_MODEL_ID,
		name: PLANNER_MODEL_ID,
		api: "openai-codex-responses",
		provider: "fixture",
		baseUrl: "https://fixture.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 128_000,
	};
}

function response(
	selected: Model<"openai-codex-responses">,
): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "fixture response" }],
		api: selected.api,
		provider: selected.provider,
		model: selected.id,
		usage: {
			input: 2,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end();
	});
	return stream;
}

let root: string;
let agentDir: string;
let workDir: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "prewalk-autoresearch-composition-"));
	agentDir = path.join(root, "agent");
	workDir = path.join(root, "work");
	await Promise.all([mkdir(agentDir), mkdir(workDir)]);
	await writeFile(
		path.join(agentDir, "prewalk.json"),
		`${JSON.stringify({ executor: DEFAULT_EXECUTOR })}\n`,
	);
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(async () => {
	delete process.env.PI_CODING_AGENT_DIR;
	await rm(root, { recursive: true, force: true });
});

describe("Prewalk and Autoresearch composition", () => {
	it("does not admit an Autoresearch-shaped extension message into automatic Prewalk", async () => {
		const planner = model();
		let providerCalls = 0;
		const provider: ExtensionFactory = (pi) => {
			pi.registerProvider("fixture", {
				api: "openai-codex-responses",
				baseUrl: "https://fixture.invalid",
				apiKey: "fixture-token",
				models: [planner],
				streamSimple: (selected) => {
					providerCalls += 1;
					return response(selected as Model<"openai-codex-responses">);
				},
			});
		};
		const autoresearchFixture: ExtensionFactory = (pi) => {
			pi.registerCommand("autoresearch-fixture", {
				description: "Emit one Autoresearch-shaped follow-up message.",
				handler: async () => {
					await pi.sendUserMessage("Build an end-to-end feature across multiple concerns.", {
						deliverAs: "followUp",
					});
				},
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
				{ name: "provider", factory: provider },
				{ name: "prewalk", factory: prewalkExtension },
				{ name: "autoresearch-fixture", factory: autoresearchFixture },
			],
		});
		await loader.reload();
		const runtime = await ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"),
			modelsPath: null,
		});
		const sessionManager = SessionManager.inMemory(workDir);
		const { session } = await createAgentSession({
			cwd: workDir,
			agentDir,
			modelRuntime: runtime,
			model: planner,
			thinkingLevel: "low",
			resourceLoader: loader,
			settingsManager: settings,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
		await session.bindExtensions({});

		await session.prompt("/prewalk auto");
		await session.waitForIdle();
		await session.prompt("/autoresearch-fixture");
		await session.waitForIdle();

		const entries = JSON.stringify(sessionManager.getEntries());
		expect(providerCalls).toBe(1);
		expect(entries).not.toContain("prewalk_assess");
		expect(entries).not.toContain("Assess whether substantial implementation work remains");
		session.dispose();
	});
});
