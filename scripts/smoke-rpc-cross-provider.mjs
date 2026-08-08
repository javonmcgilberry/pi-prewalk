/**
 * Cross-provider Prewalk smoke test.
 *
 * Launches a real Pi RPC process with the real extension and arms a run whose
 * planner and executor sit on different providers and different Pi APIs. No
 * provider credentials are used and no model request is issued: arming only
 * needs registry metadata and a configured auth entry.
 *
 * Asserts against the audit trail rather than stderr. A refused arm never
 * reaches stderr, so a stderr-only check reports success for a broken build.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { actionableStderr, buildRpcLaunchArgs, RpcProcess } from "./rpc-support.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "prewalk-xprov-"));
const agentDir = path.join(temporaryRoot, "agent");
const sessionPath = path.join(temporaryRoot, "session.jsonl");
const settingsPath = path.join(agentDir, "settings.json");
const prewalkPath = path.join(packageRoot, "extensions", "prewalk.ts");

// anthropic-messages (1,000,000) to google-generative-ai (1,048,576): a
// different provider, a different API, and an executor that clears the context
// floor. Both authenticate with a plain key, so no token refresh is involved.
const plannerProvider = "anthropic";
const plannerId = "claude-opus-4-6";
const executorProvider = "google";
const executorId = "gemini-3.5-flash";
const plannerModel = `${plannerProvider}/${plannerId}`;
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
			executor: { provider: executorProvider, model: executorId, reasoning: "low" },
			executorFallbacks: [
				{ provider: "anthropic", model: "claude-sonnet-4-6", reasoning: "low" },
			],
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
			anthropic: { type: "api_key", key: "xprov-smoke-anthropic" },
			google: { type: "api_key", key: "xprov-smoke-google" },
		})}\n`,
		{ mode: 0o600 },
	);
	await writeFile(
		settingsPath,
		`${JSON.stringify({
			defaultProvider: plannerProvider,
			defaultModel: plannerId,
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

	const rpc = new RpcProcess({
		executable: piExecutable,
		args: buildRpcLaunchArgs({
			extensionPath: prewalkPath,
			extraExtensions: [],
			sessionPath,
			model: plannerModel,
			thinking: "high",
		}),
		cwd: packageRoot,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
	});
	try {
		const state = (await rpc.send({ type: "get_state" })).data;
		assert(
			`${state.model?.provider}/${state.model?.id}` === plannerModel,
			`Planner not selected: ${state.model?.provider}/${state.model?.id}`,
		);
		// Arming runs planner validation, the executor chain, and overlay install.
		await rpc.send({ type: "prompt", message: "/prewalk run" });
		const after = (await rpc.send({ type: "get_state" })).data;
		assert(
			`${after.model?.provider}/${after.model?.id}` === plannerModel,
			"Arming changed Pi's selected model; Prewalk must leave the planner selected.",
		);
	} finally {
		await rpc.close();
	}

	const errors = actionableStderr(rpc.stderr);
	assert(errors.length === 0, `Pi wrote actionable stderr: ${errors.join(" | ")}`);
	assert((await readFile(settingsPath)).equals(settingsBefore), "Smoke changed settings.json.");

	const audits = [];
	for (const line of (await readFile(sessionPath, "utf8")).split("\n").filter(Boolean)) {
		try {
			const entry = JSON.parse(line);
			if (entry?.customType === "prewalk-audit" && entry.data) audits.push(entry.data);
		} catch {
			// Session files carry non-audit lines too.
		}
	}
	const events = audits.map((record) => record.event);
	const armed = audits.find((record) => record.event === "armed");
	assert(armed !== undefined, `Prewalk never armed. Events seen: ${events.join(", ") || "none"}`);
	assert(armed.reasonCode === undefined, `Prewalk armed with a failure: ${armed.reasonCode}`);
	assert(
		armed.executor?.provider === executorProvider && armed.executor?.model === executorId,
		`Prewalk chose ${armed.executor?.provider}/${armed.executor?.model}, expected ${executorProvider}/${executorId}`,
	);
	assert(
		armed.planner?.provider === plannerProvider && armed.planner?.model === plannerId,
		`Prewalk recorded planner ${armed.planner?.provider}/${armed.planner?.model}`,
	);
	const failed = audits.filter((record) => record.event === "failed");
	assert(failed.length === 0, `Prewalk failed: ${failed.map((f) => f.reasonCode).join(", ")}`);

	console.log(
		JSON.stringify({
			ok: true,
			plannerModel,
			plannerApi: "anthropic-messages",
			executorModel: `${executorProvider}/${executorId}`,
			executorApi: "google-generative-ai",
			crossProvider: true,
			crossApi: true,
			auditEvents: events,
			selectedModelUnchanged: true,
			settingsStable: true,
			providerRequests: 0,
		}),
	);
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
