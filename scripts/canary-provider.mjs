import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	buildCanaryPrewalkConfig,
	buildEvidenceSummary,
	CANARY_TOOL_ALLOWLIST,
	canaryAuditState,
	evaluateCanaryPayloadMarker,
	parseCanaryArgs,
	pruneEvidence,
	stageProviderCredentials,
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
const prewalkPath = path.join(packageRoot, "extensions", "prewalk.ts");
const guardPath = path.join(packageRoot, "scripts", "canary-guard.mjs");
const plannerRef = `${options.planner.provider}/${options.planner.model}`;
const executorRef = `${options.executor.provider}/${options.executor.model}`;

function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

const FAILURE_CODES = new Set([
	"selected-model-changed",
	"planner-not-observed",
	"executor-not-observed",
	"prewalk-not-armed",
	"mutation-failed",
	"handoff-incomplete",
	"pi-actionable-stderr",
	"settings-changed",
	"hidden-guidance-observed",
	"target-payload-not-observed",
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

async function waitForHandoff(rpc, executor, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let mutationSteered = false;
	while (Date.now() < deadline) {
		const [messagesResponse, entriesResponse] = await Promise.all([
			rpc.send({ type: "get_messages" }),
			rpc.send({ type: "get_entries" }),
		]);
		const messages = messagesResponse.data.messages;
		const entries = entriesResponse.data.entries;
		requestModels = messages
			.filter((message) => message?.role === "assistant")
			.map((message) => `${message.provider}/${message.model}`);
		usage = sumUsage(messages);
		const audit = canaryAuditState(entries);
		auditEvents = audit.events;
		if (audit.state === "failed") throw new Error("handoff-incomplete");
		if (audit.state === "ready" && !mutationSteered) {
			mutationSteered = true;
			await rpc.send({
				type: "prompt",
				message:
					"The todo gate is complete. Do not call prewalk_todo again. Use edit or write now to change fixture.txt from exactly `before` to exactly `after`, and change nothing else.",
				streamingBehavior: "steer",
			});
		}
		if (
			audit.state === "completed" &&
			messages.some(
				(message) =>
					message?.role === "assistant" && `${message.provider}/${message.model}` === executor,
			)
		) {
			return { messages, entries };
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("handoff-incomplete");
}

let outcome = "failed";
let requestModels = [];
let usage = {};
let status = "failed";
let trigger;
let settingsBefore = digest("");
let settingsAfter = digest("");
const assertions = [];
let auditEvents = [];
let toolEvents = [];
let payloadGuidancePaths = [];
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
				auditEvents,
				toolEvents,
				payloadGuidancePaths,
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
	await stageProviderCredentials(options.authFile, path.join(agentDir, "auth.json"), [
		options.planner.provider,
		options.executor.provider,
	]);
	throwIfSignalled();
	await writeFile(
		path.join(agentDir, "prewalk.json"),
		`${JSON.stringify(buildCanaryPrewalkConfig(options.executor, options.executorThinking))}\n`,
		{ mode: 0o600 },
	);
	await writeFile(fixturePath, "before\n", { mode: 0o600 });
	await writeFile(
		settingsPath,
		`${JSON.stringify({
			defaultProvider: options.planner.provider,
			defaultModel: options.planner.model,
			defaultThinkingLevel: options.plannerThinking,
			packages: [],
		})}\n`,
		{ mode: 0o600 },
	);
	await writeFile(
		scenarioPath,
		`${JSON.stringify({ cwd: workDir, fixturePath, markerPath, targetModel: options.executor.model })}\n`,
		{ mode: 0o600 },
	);
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
		args: [
			...buildRpcLaunchArgs({
				extensionPath: guardPath,
				extraExtensions: [...options.extensions, prewalkPath],
				sessionPath,
				model: plannerRef,
				thinking: options.plannerThinking,
			}),
			"--tools",
			CANARY_TOOL_ALLOWLIST,
		],
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
		await rpc.send({ type: "prompt", message: "/prewalk run" });
		const armedEntries = (await rpc.send({ type: "get_entries" })).data.entries;
		assert(
			armedEntries.some(
				(entry) =>
					entry?.type === "custom" &&
					entry.customType === "prewalk-audit" &&
					entry.data?.event === "armed",
			),
			"prewalk-not-armed",
		);
		await rpc.send({
			type: "prompt",
			message:
				"In this run, first call prewalk_todo once to initialize exactly one implementation item. Then change fixture.txt from exactly `before` to exactly `after` with one edit or write. Finish without changing any other file.",
		});
		const { messages, entries } = await waitForHandoff(rpc, executorRef, options.timeoutMs);
		const state = (await rpc.send({ type: "get_state" })).data;
		requestModels = messages
			.filter((message) => message?.role === "assistant")
			.map((message) => `${message.provider}/${message.model}`);
		usage = sumUsage(messages);
		const audits = entries.filter(
			(entry) => entry?.type === "custom" && entry.customType === "prewalk-audit",
		);
		auditEvents = audits
			.map((entry) => entry.data?.event)
			.filter((event) => typeof event === "string");
		const latest = audits.at(-1)?.data;
		status = latest?.phase ?? "failed";
		trigger = latest?.trigger?.toolName;
		assert(
			`${state.model?.provider}/${state.model?.id}` === plannerRef,
			"selected-model-changed",
		);
		assert(requestModels.includes(plannerRef), "planner-not-observed");
		assert(requestModels.includes(executorRef), "executor-not-observed");
		let payloadMarker;
		try {
			payloadMarker = JSON.parse(await readFile(markerPath, "utf8"));
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		const payloadEvidence = evaluateCanaryPayloadMarker(payloadMarker, options.payloadInspection);
		toolEvents = Array.isArray(payloadMarker?.toolEvents) ? payloadMarker.toolEvents : [];
		payloadGuidancePaths = Array.isArray(payloadMarker?.payloadGuidancePaths)
			? payloadMarker.payloadGuidancePaths
			: [];
		assert(payloadEvidence.ok, payloadEvidence.reasonCode);
		assert(["after", "after\n"].includes(await readFile(fixturePath, "utf8")), "mutation-failed");
		assert(status === "completed", "handoff-incomplete");
		assertions.push(
			"selected-planner",
			"planner-observed",
			"executor-observed",
			payloadEvidence.assertion,
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
	try {
		const marker = JSON.parse(await readFile(markerPath, "utf8"));
		toolEvents = Array.isArray(marker.toolEvents) ? marker.toolEvents : [];
		payloadGuidancePaths = Array.isArray(marker.payloadGuidancePaths)
			? marker.payloadGuidancePaths
			: [];
	} catch {
		toolEvents = [];
		payloadGuidancePaths = [];
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
