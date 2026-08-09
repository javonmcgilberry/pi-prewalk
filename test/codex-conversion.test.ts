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
import { afterEach, describe, expect, it, vi } from "vitest";
import prewalkExtension from "../extensions/prewalk.js";
// @ts-expect-error The published extension artifact does not ship declarations.
import codexConversion from "../node_modules/@howaboua/pi-codex-conversion/dist/index.js";
import { DEFAULT_EXECUTOR, PLANNER_MODEL_ID } from "../src/core.js";

let temporaryRoot: string | undefined;

afterEach(async () => {
	vi.unstubAllGlobals();
	delete process.env.PI_CODING_AGENT_DIR;
	if (temporaryRoot) {
		await rm(temporaryRoot, { recursive: true, force: true });
		temporaryRoot = undefined;
	}
});

describe("installed Codex conversion composition", () => {
	// biome-ignore format: keep the existing composition fixture diff small
	it.each(["conversion-first", "prewalk-first"] as const)(
		"composes Prewalk with the installed conversion in %s order",
		async (order) => {
		const accessToken = `e30.${Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-test" } }),
		).toString("base64url")}.signature`;
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
				executor: DEFAULT_EXECUTOR,
			})}\n`,
		);
		await writeFile(
			path.join(agentDir, "auth.json"),
			`${JSON.stringify({
				"openai-codex": {
					type: "oauth",
					access: accessToken,
					refresh: "integration-refresh",
					expires: Date.now() + 60_000,
				},
			})}\n`,
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;

		let conversionApi: ProviderConfig["api"] | undefined;
		let conversionStream: ProviderConfig["streamSimple"] | undefined;
		const probe: ExtensionFactory = (pi) => {
			pi.on("session_start", (_event, ctx) => {
				const registered = ctx.modelRegistry.getRegisteredProviderConfig("openai-codex");
				conversionApi = registered?.api;
				conversionStream = registered?.streamSimple;
				vi.spyOn(ctx.modelRegistry, "getApiKeyAndHeaders").mockResolvedValue({
					ok: true,
					apiKey: accessToken,
				});
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
			extensionFactories:
				order === "conversion-first"
					? [
							{ name: "codex-conversion", factory: codexConversion },
							{ name: "conversion-probe", factory: probe },
							{ name: "prewalk", factory: prewalkExtension },
						]
					: [
							{ name: "prewalk", factory: prewalkExtension },
							{ name: "codex-conversion", factory: codexConversion },
							{ name: "conversion-probe", factory: probe },
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
		expect(session.getActiveToolNames()).toContain("prewalk_todo");
		await session.prompt("/prewalk run");
		await session.waitForIdle();
		expect(session.getActiveToolNames()).toContain("prewalk_todo");

		const wrapped = runtime.getRegisteredProviderConfig("openai-codex");
		expect(conversionApi).toBe("openai-codex-responses");
		expect(conversionStream).toBeTypeOf("function");
		expect(wrapped?.streamSimple).toBeTypeOf("function");
		expect(wrapped?.streamSimple).not.toBe(conversionStream);
		const terminal = {
			type: "response.completed",
			response: {
				id: "response-test",
				status: "completed",
				model: planner.id,
				output: [
					{
						id: "message-test",
						type: "message",
						status: "completed",
						role: "assistant",
						content: [{ type: "output_text", text: "Converted response.", annotations: [] }],
					},
				],
				usage: {
					input_tokens: 1,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens: 1,
					output_tokens_details: { reasoning_tokens: 0 },
					total_tokens: 2,
				},
			},
		};
		const fetchMock = vi.fn(
			async () =>
				new Response(
					`${[
						{
							type: "response.output_item.done",
							output_index: 0,
							item: terminal.response.output[0],
						},
						terminal,
					]
						.map((event) => `data: ${JSON.stringify(event)}\n\n`)
						.join("")}`,
					{
						status: 200,
						headers: { "content-type": "text/event-stream" },
					},
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const converted = await wrapped
			?.streamSimple?.(
				planner,
				{
					systemPrompt: "system",
					messages: [{ role: "user", content: "Test conversion", timestamp: Date.now() }],
					tools: [],
				},
				{ apiKey: accessToken, transport: "sse" },
			)
			.result();
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(converted?.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "text", text: "Converted response." }),
			]),
		);
		expect(session.model?.id).toBe(PLANNER_MODEL_ID);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "message")).toEqual([]);
		},
	);
});
