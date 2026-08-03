import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { actionableStderr, buildRpcLaunchArgs, RpcProcess } from "./rpc-support.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "prewalk-rpc-"));
const agentDir = path.join(temporaryRoot, "agent");
const sessionPath = path.join(temporaryRoot, "session.jsonl");
const settingsPath = path.join(agentDir, "settings.json");
const prewalkPath = path.join(packageRoot, "extensions", "prewalk.ts");
const plannerModel = "anthropic/claude-opus-4-6";
const executorModel = "anthropic/claude-sonnet-4-6";
const piExecutable =
	process.env.PREWALK_PI_EXECUTABLE ??
	path.join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

try {
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	await writeFile(
		path.join(agentDir, "prewalk.json"),
		`${JSON.stringify({
			executor: {
				provider: "anthropic",
				model: "claude-sonnet-4-6",
				reasoning: "low",
			},
			analytics: {
				enabled: true,
				catalogFallbackEnabled: false,
				recentReceiptCount: 10,
				schemaVersion: 1,
			},
		})}\n`,
		{ mode: 0o600 },
	);
	await writeFile(
		path.join(agentDir, "auth.json"),
		`${JSON.stringify({
			anthropic: { type: "api_key", key: "rpc-smoke-token" },
		})}\n`,
		{ mode: 0o600 },
	);
	await writeFile(
		settingsPath,
		`${JSON.stringify({
			defaultProvider: "anthropic",
			defaultModel: "claude-opus-4-6",
			defaultThinkingLevel: "high",
			packages: [],
		})}\n`,
		{ mode: 0o600 },
	);
	const settingsBefore = await readFile(settingsPath);
	await writeFile(
		sessionPath,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			cwd: packageRoot,
		})}\n`,
		{ mode: 0o600 },
	);
	const args = buildRpcLaunchArgs({
		extensionPath: prewalkPath,
		extraExtensions: [],
		sessionPath,
		model: plannerModel,
		thinking: "high",
	});
	const rpc = new RpcProcess({
		executable: piExecutable,
		args,
		cwd: packageRoot,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
	});
	try {
		const state = (await rpc.send({ type: "get_state" })).data;
		assert(
			`${state.model?.provider}/${state.model?.id}` === plannerModel,
			"RPC smoke did not retain the configured planner as Pi's selected model.",
		);
		await rpc.send({ type: "prompt", message: "/prewalk status" });
		await rpc.send({ type: "prompt", message: "/prewalk cancel" });
		await rpc.send({ type: "prompt", message: "/reload" });
		const reloaded = (await rpc.send({ type: "get_state" })).data;
		assert(
			`${reloaded.model?.provider}/${reloaded.model?.id}` === plannerModel,
			"RPC reload changed Pi's selected model.",
		);
	} finally {
		await rpc.close();
	}
	const errors = actionableStderr(rpc.stderr);
	assert(errors.length === 0, `Pi wrote actionable stderr: ${errors.join(" | ")}`);
	assert(
		(await readFile(settingsPath)).equals(settingsBefore),
		"RPC smoke changed settings.json.",
	);
	console.log(
		JSON.stringify({
			ok: true,
			pi: "0.82.1",
			conversionExtension: "not-loaded",
			plannerModel,
			executorModel,
			selectedModel: plannerModel,
			analytics: "local-only",
			providerRequests: 0,
			settingsStable: true,
		}),
	);
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
