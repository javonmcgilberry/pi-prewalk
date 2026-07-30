import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	buildEvidenceSummary,
	parseCanaryArgs,
	pruneEvidence,
	stageOpenAICodexCredential,
	validateCanaryOptions,
	writeEvidence,
} from "./canary-support.mjs";
import { actionableStderr, buildRpcLaunchArgs, RpcProcess } from "./rpc-support.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const options = validateCanaryOptions(parseCanaryArgs(process.argv.slice(2)));
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "prewalk-canary-"));
const agentDir = path.join(temporaryRoot, "agent");
const workDir = path.join(temporaryRoot, "work");
const fixturePath = path.join(workDir, "fixture.txt");
const settingsPath = path.join(agentDir, "settings.json");
const sessionPath = path.join(temporaryRoot, "session.jsonl");
const scenarioPath = path.join(temporaryRoot, "scenario.json");
const markerPath = path.join(temporaryRoot, "provider-payload-marker.json");
const evidenceDir = options.evidenceDir ?? path.join(packageRoot, "benchmark", "results");
const piExecutable =
	options.piExecutable ??
	path.join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const conversionPath = path.join(
	packageRoot,
	"node_modules",
	"@howaboua",
	"pi-codex-conversion",
	"dist",
	"index.js",
);
const prewalkPath = path.join(packageRoot, "extensions", "prewalk.ts");
const guardPath = path.join(packageRoot, "scripts", "canary-guard.mjs");

function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

const FAILURE_CODES = new Set([
	"selected-model-changed",
	"sol-not-observed",
	"luna-not-observed",
	"mutation-failed",
	"handoff-incomplete",
	"pi-actionable-stderr",
	"settings-changed",
	"hidden-guidance-observed",
]);

function failureCode(error) {
	return error instanceof Error && FAILURE_CODES.has(error.message)
		? error.message
		: "canary-runtime-failed";
}

function sumUsage(messages) {
	const total = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	};
	for (const message of messages) {
		if (message?.role !== "assistant" || !message.usage) continue;
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
			total[key] += message.usage[key] ?? 0;
		}
		total.cost += message.usage.cost?.total ?? 0;
	}
	return total;
}

let outcome = "failed";
let requestModels = [];
let usage = {};
let status = "failed";
let trigger;
let settingsBefore = digest("");
let settingsAfter = digest("");
const assertions = [];
let rpc;
let cleanupPromise;
let failureReason;
let evidencePromise;
let receivedSignal;

function cleanup() {
	cleanupPromise ??= (async () => {
		try {
			await rpc?.close();
		} finally {
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	})();
	return cleanupPromise;
}

function persistEvidence() {
	evidencePromise ??= (async () => {
		await pruneEvidence(evidenceDir);
		return writeEvidence(
			evidenceDir,
			buildEvidenceSummary({
				retentionMs: options.retentionMs,
				outcome,
				requestModels,
				usage,
				status,
				trigger,
				settingsBefore,
				settingsAfter,
				assertions,
			}),
		);
	})();
	return evidencePromise;
}

const signalHandlers = new Map();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	const handler = () => {
		if (receivedSignal) return;
		receivedSignal = signal;
		failureReason = `signal-${signal.toLowerCase()}`;
		status = `failed:${failureReason}`;
		rpc?.child.kill("SIGTERM");
	};
	signalHandlers.set(signal, handler);
	process.on(signal, handler);
}

function throwIfSignalled() {
	if (receivedSignal) throw new Error(failureReason);
}

try {
	await Promise.all([
		mkdir(agentDir, { recursive: true, mode: 0o700 }),
		mkdir(workDir, { recursive: true, mode: 0o700 }),
	]);
	throwIfSignalled();
	await stageOpenAICodexCredential(options.authFile, path.join(agentDir, "auth.json"));
	throwIfSignalled();
	await writeFile(path.join(agentDir, "prewalk.json"), '{"enabled":true}\n', {
		mode: 0o600,
	});
	await writeFile(fixturePath, "before\n", { mode: 0o600 });
	await writeFile(
		settingsPath,
		`${JSON.stringify({
			defaultProvider: "openai-codex",
			defaultModel: "gpt-5.6-sol",
			defaultThinkingLevel: "high",
			packages: [],
		})}\n`,
		{ mode: 0o600 },
	);
	await writeFile(scenarioPath, `${JSON.stringify({ cwd: workDir, fixturePath, markerPath })}\n`, {
		mode: 0o600,
	});
	await writeFile(
		sessionPath,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			cwd: workDir,
		})}\n`,
		{ mode: 0o600 },
	);
	throwIfSignalled();
	const beforeBytes = await readFile(settingsPath);
	settingsBefore = digest(beforeBytes);
	rpc = new RpcProcess({
		executable: piExecutable,
		args: buildRpcLaunchArgs({
			extensionPath: conversionPath,
			extraExtensions: [guardPath, prewalkPath],
			sessionPath,
			model: "openai-codex/gpt-5.6-sol",
			thinking: "high",
		}),
		cwd: workDir,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PREWALK_CANARY_SCENARIO: scenarioPath,
		},
		timeoutMs: options.timeoutMs,
	});
	throwIfSignalled();
	try {
		const startIndex = rpc.events.length;
		await rpc.send({
			type: "prompt",
			message:
				"Change fixture.txt from exactly `before` to exactly `after`. Use the todo tool for the plan, then one edit or write mutation, and finish the verification.",
		});
		await rpc.waitFor((event) => event.type === "agent_settled", options.timeoutMs, startIndex);
		const [messagesResponse, entriesResponse, stateResponse] = await Promise.all([
			rpc.send({ type: "get_messages" }),
			rpc.send({ type: "get_entries" }),
			rpc.send({ type: "get_state" }),
		]);
		const messages = messagesResponse.data.messages;
		const entries = entriesResponse.data.entries;
		const state = stateResponse.data;
		requestModels = messages
			.filter((message) => message?.role === "assistant")
			.map((message) => `${message.provider}/${message.model}`);
		usage = sumUsage(messages);
		const audits = entries.filter(
			(entry) => entry?.type === "custom" && entry.customType === "prewalk-audit",
		);
		const latest = audits.at(-1)?.data;
		status = latest?.phase ?? "failed";
		trigger = latest?.trigger?.toolName;
		assert(
			`${state.model?.provider}/${state.model?.id}` === "openai-codex/gpt-5.6-sol",
			"selected-model-changed",
		);
		assert(requestModels.includes("openai-codex/gpt-5.6-sol"), "sol-not-observed");
		assert(requestModels.includes("openai-codex/gpt-5.6-luna"), "luna-not-observed");
		const payloadMarker = JSON.parse(await readFile(markerPath, "utf8"));
		assert(
			payloadMarker.targetPayloadCount >= 1 && payloadMarker.lunaPayloadGuidanceFree === true,
			"hidden-guidance-observed",
		);
		assert((await readFile(fixturePath, "utf8")) === "after\n", "mutation-failed");
		assert(status === "completed", "handoff-incomplete");
		assertions.push(
			"selected-sol",
			"sol-observed",
			"luna-observed",
			"luna-payload-guidance-free",
			"bounded-mutation",
			"handoff-completed",
		);
		outcome = "passed";
	} finally {
		await rpc.close();
		const errors = actionableStderr(rpc.stderr);
		rpc = undefined;
		assert(errors.length === 0, "pi-actionable-stderr");
	}
	const afterBytes = await readFile(settingsPath);
	settingsAfter = digest(afterBytes);
	assert(settingsAfter === settingsBefore, "settings-changed");
	assertions.push("settings-byte-identical");
} catch (error) {
	if (!failureReason?.startsWith("signal-")) {
		failureReason = failureCode(error);
		status = `failed:${failureReason}`;
	}
	try {
		settingsAfter = digest(await readFile(settingsPath));
	} catch {
		settingsAfter = digest("");
	}
} finally {
	for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
	await cleanup();
}

const evidencePath = await persistEvidence();
console.log(
	JSON.stringify({
		ok: outcome === "passed",
		evidence: evidencePath,
		...(failureReason ? { reasonCode: failureReason } : {}),
	}),
);
if (receivedSignal) {
	process.kill(process.pid, receivedSignal);
} else if (failureReason) {
	process.exitCode = 1;
}
