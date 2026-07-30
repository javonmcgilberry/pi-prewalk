import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { actionableStderr, buildRpcLaunchArgs, RpcProcess } from "./rpc-support.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const defaultPi = path.resolve(
	packageRoot,
	"..",
	"earendil-works-pi",
	"packages",
	"coding-agent",
	"dist",
	"cli.js",
);
const piExecutable = path.resolve(process.env.PREWALK_PI_EXECUTABLE || defaultPi);
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "prewalk-rpc-"));
const temporaryAgentDir = path.join(temporaryRoot, "agent");
const extensionPath = path.join(temporaryRoot, "smoke-extension.mjs");
const firstSessionPath = path.join(temporaryRoot, "session.jsonl");
const freshSessionPath = path.join(temporaryRoot, "fresh-session.jsonl");
const settingsPath = path.join(temporaryAgentDir, "settings.json");
const planner = "prewalk-smoke/planner";
const target = "prewalk-smoke/target";
const targetThinking = "high";

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function writeSession(filePath, id) {
	await writeFile(
		filePath,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: packageRoot })}\n`,
		{ mode: 0o600 },
	);
}

function smokeExtensionSource() {
	return `
let providerRequests = 0;
const model = (id, name) => ({
  id, name, reasoning: true, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000, maxTokens: 4_096,
});
export default function smokeExtension(pi) {
  pi.registerProvider("prewalk-smoke", {
    name: "Prewalk smoke (no network)",
    baseUrl: "http://127.0.0.1:1/prewalk-smoke",
    apiKey: "prewalk-smoke-not-a-secret",
    api: "openai-completions",
    streamImplementationId: "prewalk-smoke-stream@1",
    models: [model("planner", "Smoke planner"), model("target", "Smoke target")],
    streamSimple() {
      providerRequests += 1;
      throw new Error("PREWALK_SMOKE_PROVIDER_REQUEST");
    },
  });
  pi.registerCommand("prewalk-smoke-switch", {
    description: "Exercise the public session-only switch without a provider request",
    handler: async (_args, ctx) => {
      const target = ctx.modelRegistry.find("prewalk-smoke", "target");
      if (!target) throw new Error("Smoke target is unavailable");
      await pi.setSessionModelAndThinkingLevel(target, "high");
    },
  });
  pi.registerCommand("prewalk-smoke-assert-no-request", {
    description: "Fail if the smoke provider was called",
    handler: async () => {
      if (providerRequests !== 0) throw new Error("PREWALK_SMOKE_PROVIDER_REQUEST");
    },
  });
}
`;
}

async function startRpc(sessionPath) {
	const args = buildRpcLaunchArgs({
		extensionPath,
		sessionPath,
		model: planner,
		thinking: "off",
	});
	return new RpcProcess({
		executable: piExecutable,
		args,
		cwd: packageRoot,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: temporaryAgentDir,
			PREWALK_SMOKE_ISOLATED: "1",
		},
		timeoutMs: 30_000,
	});
}

async function state(rpc) {
	return (await rpc.send({ type: "get_state" })).data;
}

async function selectionEntryCount(filePath) {
	const entries = (await readFile(filePath, "utf8"))
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	return entries.filter(
		(entry) => entry.type === "model_change" || entry.type === "thinking_level_change",
	).length;
}

async function run() {
	await access(piExecutable);
	await mkdir(temporaryAgentDir, { recursive: true, mode: 0o700 });
	await writeFile(
		settingsPath,
		`${JSON.stringify({ defaultProvider: "prewalk-smoke", defaultModel: "planner", defaultThinkingLevel: "off", packages: [] }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	const settingsBefore = await readFile(settingsPath);
	await writeFile(extensionPath, smokeExtensionSource(), { mode: 0o600 });
	const firstSessionId = randomUUID();
	await writeSession(firstSessionPath, firstSessionId);

	const rpc = await startRpc(firstSessionPath);
	let selectionEntriesBefore = 0;
	try {
		const before = await state(rpc);
		assert(before.sessionId === firstSessionId, "Initial RPC opened a different session.");
		assert(
			`${before.model?.provider}/${before.model?.id}` === planner,
			"Initial RPC did not use the planner model.",
		);
		selectionEntriesBefore = await selectionEntryCount(firstSessionPath);
		const pid = rpc.child.pid;
		await rpc.send({ type: "prompt", message: "/prewalk-smoke-switch" });
		const switched = await state(rpc);
		assert(rpc.child.pid === pid, "Session switch changed the Pi process.");
		assert(switched.sessionId === firstSessionId, "Session switch changed the session ID.");
		assert(
			`${switched.model?.provider}/${switched.model?.id}` === target,
			"Session switch did not select the target.",
		);
		assert(
			switched.thinkingLevel === targetThinking,
			"Session switch did not select target thinking.",
		);
		await rpc.send({
			type: "prompt",
			message: "/prewalk-smoke-assert-no-request",
		});

		await rpc.send({ type: "prompt", message: "/reload" });
		const reloaded = await state(rpc);
		assert(reloaded.sessionId === firstSessionId, "Extension reload replaced the session.");
		assert(
			`${reloaded.model?.provider}/${reloaded.model?.id}` === target,
			"Extension reload did not retain the live target.",
		);
		assert(
			reloaded.thinkingLevel === targetThinking,
			"Extension reload did not retain target thinking.",
		);

		await rpc.send({ type: "new_session" });
		const replacement = await state(rpc);
		assert(
			replacement.sessionId !== firstSessionId,
			"Replacement session reused the switched session ID.",
		);
		assert(
			`${replacement.model?.provider}/${replacement.model?.id}` === planner,
			"Replacement session did not reconstruct ordinary planner selection.",
		);
		assert(
			replacement.thinkingLevel === "off",
			"Replacement session did not reconstruct ordinary thinking.",
		);
	} finally {
		await rpc.close();
	}

	assert(
		(await selectionEntryCount(firstSessionPath)) === selectionEntriesBefore,
		"Transient switch added model/thinking entries.",
	);
	assert(
		(await readFile(settingsPath)).equals(settingsBefore),
		"Deterministic smoke changed settings.json.",
	);
	const firstErrors = actionableStderr(rpc.stderr);
	assert(firstErrors.length === 0, `Pi wrote actionable stderr: ${firstErrors.join(" | ")}`);

	const freshSessionId = randomUUID();
	await writeSession(freshSessionPath, freshSessionId);
	const freshRpc = await startRpc(freshSessionPath);
	try {
		const fresh = await state(freshRpc);
		assert(fresh.sessionId === freshSessionId, "Fresh process opened a different session.");
		assert(
			`${fresh.model?.provider}/${fresh.model?.id}` === planner,
			"Fresh process did not use ordinary planner selection.",
		);
		assert(fresh.thinkingLevel === "off", "Fresh process did not use ordinary thinking.");
		await freshRpc.send({
			type: "prompt",
			message: "/prewalk-smoke-assert-no-request",
		});
	} finally {
		await freshRpc.close();
	}
	const freshErrors = actionableStderr(freshRpc.stderr);
	assert(freshErrors.length === 0, `Fresh Pi wrote actionable stderr: ${freshErrors.join(" | ")}`);
	assert(
		(await readFile(settingsPath)).equals(settingsBefore),
		"Fresh process changed settings.json.",
	);

	console.log(
		"Deterministic RPC smoke passed: no provider request, one-process live switch, reload retention, replacement/fresh isolation, no persisted selection, byte-identical settings.",
	);
}

try {
	await run();
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
