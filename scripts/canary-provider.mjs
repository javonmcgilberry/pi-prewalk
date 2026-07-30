import { randomUUID } from "node:crypto";
import {
	access,
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { containsHiddenGuidance } from "../src/protocol.mjs";
import {
	buildEvidenceSummary,
	parseCanaryArgs,
	pruneEvidence,
	validateCanaryOptions,
	writeEvidence,
} from "./canary-support.mjs";
import { actionableStderr, buildRpcLaunchArgs, RpcProcess } from "./rpc-support.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const prewalkExtensionPath = path.join(packageRoot, "extensions", "prewalk.ts");
const canaryGuardPath = path.join(packageRoot, "scripts", "canary-guard.mjs");
const defaultPi = path.resolve(
	packageRoot,
	"..",
	"earendil-works-pi",
	"packages",
	"coding-agent",
	"dist",
	"cli.js",
);
function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function modelKey(model) {
	return `${model?.provider ?? "unknown"}/${model?.model ?? model?.id ?? "unknown"}`;
}

function assistantMessages(messages) {
	return messages.filter((message) => message?.role === "assistant");
}

function toolCalls(messages) {
	return assistantMessages(messages).flatMap((message) =>
		Array.isArray(message.content)
			? message.content.filter((content) => content?.type === "toolCall")
			: [],
	);
}

function toolResults(messages) {
	return messages.filter((message) => message?.role === "toolResult");
}

function selectionEntryCount(entries) {
	return entries.filter(
		(entry) => entry?.type === "model_change" || entry?.type === "thinking_level_change",
	).length;
}

async function writeSession(filePath, cwd) {
	const id = randomUUID();
	await writeFile(
		filePath,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`,
		{ mode: 0o600 },
	);
	return id;
}

async function startScenario({ options, agentDir, kind, root }) {
	const repoDir = path.join(root, "repo");
	await mkdir(repoDir, { recursive: true, mode: 0o700 });
	const fixturePath = path.join(repoDir, "fixture.txt");
	await writeFile(fixturePath, "before\n", { mode: 0o600 });
	const sessionPath = path.join(root, "session.jsonl");
	const sessionId = await writeSession(sessionPath, repoDir);
	const markerPath = path.join(root, "preflight.json");
	const scenarioPath = path.join(root, "canary-scenario.json");
	await writeFile(
		scenarioPath,
		`${JSON.stringify({
			kind,
			cwd: repoDir,
			fixturePath,
			markerPath,
			plannerProvider: options.planner.provider,
			plannerId: options.planner.id,
			targetProvider: options.target.provider,
			targetId: options.target.id,
			...(options.consent ? { consent: options.consent } : {}),
		})}\n`,
		{ mode: 0o600 },
	);
	const args = buildRpcLaunchArgs({
		extensionPath: prewalkExtensionPath,
		sessionPath,
		model: `${options.planner.provider}/${options.planner.id}`,
		thinking: "off",
		extraExtensions: [canaryGuardPath],
	});
	let guardFailure;
	const rpc = new RpcProcess({
		executable: options.piExecutable,
		args,
		cwd: repoDir,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PREWALK_CANARY_SCENARIO: scenarioPath,
		},
		timeoutMs: options.timeoutMs,
		onEvent: (event, process) => {
			if (!JSON.stringify(event).includes("PREWALK_CANARY_GUARD")) return;
			guardFailure = "Canary guard blocked an unexpected tool call.";
			void process.send({ type: "abort" }).catch(() => undefined);
		},
	});
	try {
		const initial = (await rpc.send({ type: "get_state" })).data;
		assert(initial.sessionId === sessionId, `${kind} opened a different session.`);
		assert(
			modelKey(initial.model) === `${options.planner.provider}/${options.planner.id}`,
			`${kind} did not start on the planner.`,
		);
		await rpc.send({ type: "prompt", message: "/prewalk-canary-preflight" });
		const preflight = JSON.parse(await readFile(markerPath, "utf8"));
		assert(preflight.ready === true, `${kind} preflight did not complete.`);
		if (options.planner.provider !== options.target.provider) {
			assert(
				preflight.pair === options.consent,
				`${kind} consent did not match effective recipients.`,
			);
		}
		const entriesBefore = (await rpc.send({ type: "get_entries" })).data.entries;
		return {
			rpc,
			kind,
			repoDir,
			fixturePath,
			markerPath,
			sessionPath,
			sessionId,
			selectionEntriesBefore: selectionEntryCount(entriesBefore),
			guardFailure: () => guardFailure,
		};
	} catch (error) {
		await rpc.close();
		throw error;
	}
}

async function finishScenario(scenario, options, prompt) {
	let messages;
	let entries;
	let state;
	try {
		const startIndex = scenario.rpc.events.length;
		await scenario.rpc.send({ type: "prompt", message: prompt });
		await scenario.rpc.waitFor(
			(event) => event.type === "agent_settled",
			options.timeoutMs,
			startIndex,
		);
		if (scenario.guardFailure()) throw new Error(scenario.guardFailure());
		messages = (await scenario.rpc.send({ type: "get_messages" })).data.messages;
		entries = (await scenario.rpc.send({ type: "get_entries" })).data.entries;
		state = (await scenario.rpc.send({ type: "get_state" })).data;
		const guardEvidence = JSON.parse(await readFile(scenario.markerPath, "utf8"));
		if (scenario.kind === "main") {
			assert(
				guardEvidence.finalTargetPayloadGuidanceFree === true &&
					guardEvidence.targetPayloadCount > 0,
				"Canary guard did not inspect the final target provider payload.",
			);
		} else {
			assert(
				(guardEvidence.targetPayloadCount ?? 0) === 0,
				`${scenario.kind} unexpectedly sent a request to the target.`,
			);
		}
	} finally {
		await scenario.rpc.close();
	}
	const errors = actionableStderr(scenario.rpc.stderr);
	assert(
		errors.length === 0,
		`${path.basename(scenario.repoDir)} wrote actionable stderr: ${errors.join(" | ")}`,
	);
	assert(
		!containsHiddenGuidance(messages),
		"Hidden planning guidance entered projected messages.",
	);
	assert(!containsHiddenGuidance(entries), "Hidden planning guidance entered session entries.");
	return {
		messages,
		entries,
		state,
		finalTargetPayloadGuidanceFree: scenario.kind === "main",
	};
}

function validateControl(kind, result, options) {
	const assistants = assistantMessages(result.messages);
	const calls = toolCalls(result.messages);
	if (kind === "chat") {
		assert(assistants.length === 1, "Ordinary chat used more than one provider request.");
		assert(calls.length === 0, "Ordinary chat unexpectedly used a tool.");
	} else {
		assert(assistants.length === 2, "Read-only control used a speculative provider request.");
		assert(
			calls.length === 1 && calls[0].name === "read",
			"Read-only control did not remain one-read-only loop.",
		);
		assert(
			!toolResults(result.messages).some((message) => message.toolName === "prewalk_checkpoint"),
			"Read-only control created a checkpoint.",
		);
	}
	assert(
		assistants.every(
			(message) => modelKey(message) === `${options.planner.provider}/${options.planner.id}`,
		),
		`${kind} control switched away from the planner.`,
	);
	return assistants.map(modelKey);
}

function validateMain(result, scenario, options) {
	const assistants = assistantMessages(result.messages);
	const results = toolResults(result.messages);
	const checkpointIndex = result.messages.findIndex(
		(message) =>
			message?.role === "toolResult" &&
			message.toolName === "prewalk_checkpoint" &&
			message.isError === false,
	);
	const mutationIndex = result.messages.findIndex(
		(message) =>
			message?.role === "toolResult" &&
			(message.toolName === "edit" || message.toolName === "write") &&
			message.isError === false,
	);
	assert(
		checkpointIndex >= 0 && mutationIndex > checkpointIndex,
		"Checkpoint and successful mutation were not persisted in order.",
	);
	const targetKey = `${options.target.provider}/${options.target.id}`;
	const plannerKey = `${options.planner.provider}/${options.planner.id}`;
	const afterMutation = result.messages
		.slice(mutationIndex + 1)
		.filter((message) => message?.role === "assistant");
	assert(
		afterMutation.length > 0 && modelKey(afterMutation[0]) === targetKey,
		"Target did not own the natural request after mutation.",
	);
	const models = assistants.map(modelKey);
	assert(models.includes(plannerKey), "Planner never handled a provider request.");
	const firstTarget = models.indexOf(targetKey);
	assert(firstTarget > 0, "Target transition was not observed after planner work.");
	assert(!models.slice(firstTarget).includes(plannerKey), "Planner resumed after target handoff.");
	assert(modelKey(result.state.model) === targetKey, "Target was not live after handoff.");
	assert(result.state.sessionId === scenario.sessionId, "Handoff changed the live session.");
	assert(
		results.filter((message) => message.toolName === "prewalk_checkpoint" && !message.isError)
			.length === 1,
		"Canary did not persist exactly one checkpoint result.",
	);
	assert(
		results.filter(
			(message) =>
				(message.toolName === "edit" || message.toolName === "write") && !message.isError,
		).length === 1,
		"Canary did not persist exactly one successful mutation result.",
	);
	return models;
}

export async function runCanary(rawOptions) {
	const options = validateCanaryOptions(rawOptions);
	options.piExecutable = path.resolve(options.piExecutable || defaultPi);
	await access(options.piExecutable);
	await access(prewalkExtensionPath);
	await access(canaryGuardPath);
	if (options.authFile) await access(options.authFile);
	if (options.modelsFile) await access(options.modelsFile);
	const evidenceDir = path.resolve(
		options.evidenceDir || path.join(process.cwd(), ".prewalk-canary-evidence"),
	);
	await pruneEvidence(evidenceDir);
	const root = await mkdtemp(path.join(tmpdir(), "prewalk-provider-canary-"));
	const agentDir = path.join(root, "agent");
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	if (options.authFile) {
		const isolatedAuth = path.join(agentDir, "auth.json");
		await copyFile(options.authFile, isolatedAuth);
		await chmod(isolatedAuth, 0o600);
	}
	if (options.modelsFile) {
		const isolatedModels = path.join(agentDir, "models.json");
		await copyFile(options.modelsFile, isolatedModels);
		await chmod(isolatedModels, 0o600);
	}
	await writeFile(
		path.join(agentDir, "settings.json"),
		`${JSON.stringify({ defaultProvider: options.planner.provider, defaultModel: options.planner.id, defaultThinkingLevel: "off", packages: [] }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	await writeFile(
		path.join(agentDir, "prewalk.json"),
		`${JSON.stringify({ enabled: true, target: `${options.target.provider}/${options.target.id}`, thinkingLevel: options.thinking, crossProviderPairs: options.consent ? [options.consent] : [] }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	const settingsPath = path.join(agentDir, "settings.json");
	const settingsBefore = await readFile(settingsPath);
	const aggregate = {
		requestModels: [],
		checkpointCount: 0,
		mutationCount: 0,
		assertions: [],
	};
	let outcome = "failed";
	let primaryError;
	try {
		const chatRoot = path.join(root, "chat");
		const chat = await startScenario({
			options,
			agentDir,
			kind: "chat",
			root: chatRoot,
		});
		const chatResult = await finishScenario(
			chat,
			options,
			"Reply with exactly PREWALK_CANARY_CHAT_OK. Do not use tools.",
		);
		aggregate.requestModels.push(...validateControl("chat", chatResult, options));
		aggregate.assertions.push("ordinary-chat-no-extra-request");

		const readonlyRoot = path.join(root, "readonly");
		const readonly = await startScenario({
			options,
			agentDir,
			kind: "readonly",
			root: readonlyRoot,
		});
		const readonlyResult = await finishScenario(
			readonly,
			options,
			`This is strictly read-only. Use the read tool exactly once on ${readonly.fixturePath}, then report its single word. Do not checkpoint, edit, write, or use any other tool.`,
		);
		aggregate.requestModels.push(...validateControl("readonly", readonlyResult, options));
		aggregate.assertions.push("readonly-no-speculative-request");

		const mainRoot = path.join(root, "handoff");
		const main = await startScenario({
			options,
			agentDir,
			kind: "main",
			root: mainRoot,
		});
		const mainResult = await finishScenario(
			main,
			options,
			`Work only on ${main.fixturePath}. This task requires implementation. First use read on that exact file. Follow the active Prewalk checkpoint instruction, then use exactly one edit replacing the exact text before with after. After handoff, verify the mutation from the transcript and reply PREWALK_CANARY_TARGET_COMPLETE. Do not use bash or touch any other path.`,
		);
		const mainModels = validateMain(mainResult, main, options);
		aggregate.requestModels.push(...mainModels);
		const targetCompletion = assistantMessages(mainResult.messages)
			.filter(
				(message) => modelKey(message) === `${options.target.provider}/${options.target.id}`,
			)
			.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
			.filter((content) => content?.type === "text")
			.map((content) => content.text)
			.join("\n");
		assert(
			targetCompletion.includes("PREWALK_CANARY_TARGET_COMPLETE"),
			"Target did not confirm transcript-visible completion.",
		);
		aggregate.checkpointCount = 1;
		aggregate.mutationCount = 1;
		assert(
			(await readFile(main.fixturePath, "utf8")) === "after\n",
			"Bounded fixture did not contain the expected mutation.",
		);
		assert(
			selectionEntryCount(mainResult.entries) === main.selectionEntriesBefore,
			"Handoff persisted model/thinking selection entries.",
		);
		assert(
			(await readFile(settingsPath)).equals(settingsBefore),
			"Provider canary changed settings.json.",
		);
		aggregate.assertions.push(
			"same-session",
			"checkpoint-before-mutation",
			"target-natural-continuation",
			"target-transcript-visible",
			"hidden-guidance-absent",
			"settings-byte-identical",
			"selection-entries-unchanged",
			"bounded-fixture-only",
		);
		outcome = "passed";
	} catch (error) {
		primaryError = error;
	} finally {
		const summary = buildEvidenceSummary({
			now: new Date(),
			retentionMs: options.retentionMs,
			outcome,
			planner: options.planner,
			target: options.target,
			requestModels: aggregate.requestModels,
			requestCount: aggregate.requestModels.length,
			checkpointCount: aggregate.checkpointCount,
			mutationCount: aggregate.mutationCount,
			assertions: outcome === "passed" ? aggregate.assertions : ["canary-failed"],
		});
		let evidencePath;
		try {
			evidencePath = await writeEvidence(evidenceDir, summary);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
		console.log(
			`Canary evidence: ${path.basename(evidencePath)} (${outcome}, expires ${summary.expiresAt})`,
		);
	}
	if (primaryError) throw primaryError;
	console.log(
		"Provider canary passed: OMP-faithful live handoff, zero speculative controls, bounded fixture, byte-identical settings, redacted evidence.",
	);
}

async function main() {
	const options = parseCanaryArgs(process.argv.slice(2));
	await runCanary(options);
}

const invokedPath = process.argv[1]
	? await realpath(process.argv[1]).catch(() => undefined)
	: undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
