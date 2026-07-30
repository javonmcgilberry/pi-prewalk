import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FROZEN_BENCHMARK_PROTOCOL } from "./benchmark-contract.mjs";
import { DockerBenchmarkSandbox } from "./benchmark-docker.mjs";
import { stageOpenAICodexCredential } from "./canary-support.mjs";
import {
	actionableStderr,
	buildRpcLaunchArgs,
	RpcProcess,
	resolvePiLaunch,
} from "./rpc-support.mjs";

const SOL = "openai-codex/gpt-5.6-sol";
const LUNA = "openai-codex/gpt-5.6-luna";
const ZERO_DIGEST = "0".repeat(64);

function sumUsage(messages) {
	let cost = 0;
	const seen = new Set();
	for (const message of messages) {
		if (message?.role !== "assistant") continue;
		const value = message.usage?.cost?.total;
		const key = JSON.stringify({
			timestamp: message.timestamp,
			provider: message.provider,
			model: message.model,
			stopReason: message.stopReason,
			usage: message.usage,
			content: message.content,
		});
		if (seen.has(key)) continue;
		seen.add(key);
		if (Number.isFinite(value) && value >= 0) cost += value;
	}
	return cost;
}

function assistantMessagesFromEvents(events) {
	const found = [];
	const visit = (value) => {
		if (!value || typeof value !== "object") return;
		if (value.role === "assistant" && typeof value.model === "string") found.push(value);
		for (const nested of Object.values(value)) {
			if (Array.isArray(nested)) nested.forEach(visit);
			else if (nested && typeof nested === "object") visit(nested);
		}
	};
	for (const event of events) visit(event);
	return found;
}

function validateModelEvidence(arm, selected, messages) {
	const expectedSelected = arm === "luna" ? LUNA : SOL;
	if (`${selected?.provider}/${selected?.id}` !== expectedSelected) return false;
	const models = messages
		.filter((message) => message?.role === "assistant")
		.map((message) => `${message.provider}/${message.model}`);
	if (models.length === 0) return false;
	if (arm === "sol") return models.every((model) => model === SOL);
	if (arm === "luna") return models.every((model) => model === LUNA);
	const firstLuna = models.indexOf(LUNA);
	return (
		models[0] === SOL && firstLuna > 0 && models.slice(firstLuna).every((model) => model === LUNA)
	);
}

async function safetyTotals(filePath) {
	const content = await readFile(filePath, "utf8");
	let lookupAttempts = 0;
	let sandboxViolations = 0;
	for (const line of content.split(/\r?\n/).filter(Boolean)) {
		const value = JSON.parse(line);
		if (
			!Number.isInteger(value.lookupAttempts) ||
			value.lookupAttempts < 0 ||
			!Number.isInteger(value.sandboxViolations) ||
			value.sandboxViolations < 0 ||
			Object.keys(value).some((key) => key !== "lookupAttempts" && key !== "sandboxViolations")
		) {
			throw new Error("Benchmark tool evidence is invalid.");
		}
		lookupAttempts += value.lookupAttempts;
		sandboxViolations += value.sandboxViolations;
	}
	return { lookupAttempts, sandboxViolations };
}

function fixedConversionConfig(protocol) {
	return {
		voiceFeaturesOnly: false,
		scope: { allProviders: "on", additionalProviders: [] },
		tools: {
			customRustBinariesDir: "",
			webRun: false,
			imageGeneration: false,
			viewImageFallback: false,
			applyPatchOnly: false,
			viewImageOnly: false,
			webRunOnly: false,
			imageGenerationOnly: false,
		},
		beta: { codeMode: false, responsesLite: false, v2UserMessageRetention: 64 },
		compaction: { responsesCompaction: false },
		openai: {
			forceCachedWebSockets: protocol.cachePolicy.forceCachedWebSockets,
			fast: false,
			verbosity: "medium",
		},
	};
}

function benchmarkProcessEnvironment(agentDir, temporaryRoot, scenarioPath) {
	return {
		HOME: agentDir,
		NO_COLOR: "1",
		PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		PI_CODING_AGENT_DIR: agentDir,
		PREWALK_BENCHMARK_SCENARIO: scenarioPath,
		TMPDIR: temporaryRoot,
	};
}

async function executableVersion(executable) {
	return await new Promise((resolve, reject) => {
		const launch = resolvePiLaunch(executable, ["--version"]);
		const child = spawn(launch.command, launch.args, { stdio: ["ignore", "pipe", "ignore"] });
		const chunks = [];
		let bytes = 0;
		child.stdout.on("data", (chunk) => {
			bytes += chunk.length;
			if (bytes > 1_000) child.kill("SIGKILL");
			else chunks.push(chunk);
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code !== 0 || bytes > 1_000) {
				reject(new Error("Could not verify the Pi version."));
				return;
			}
			resolve(Buffer.concat(chunks).toString("utf8").trim());
		});
	});
}

export function createBenchmarkRuntime({
	authFile,
	piExecutable,
	sandbox = new DockerBenchmarkSandbox(),
	rpcFactory = (options) => new RpcProcess(options),
	temporaryParent = tmpdir(),
	protocol = FROZEN_BENCHMARK_PROTOCOL,
} = {}) {
	if (!path.isAbsolute(authFile ?? "") || !path.isAbsolute(piExecutable ?? "")) {
		throw new Error("Benchmark runtime requires absolute auth and Pi paths.");
	}
	const packageRoot = path.resolve(import.meta.dirname, "..");
	const extensionPaths = [
		path.join(packageRoot, "extensions", "benchmark-tools.ts"),
		path.join(
			packageRoot,
			"node_modules",
			"@howaboua",
			"pi-codex-conversion",
			"dist",
			"index.js",
		),
		path.join(packageRoot, "extensions", "prewalk.ts"),
		path.join(packageRoot, "extensions", "benchmark-attestation.ts"),
	];
	return {
		async preflight(manifest) {
			const [piVersion, conversionPackage] = await Promise.all([
				executableVersion(piExecutable),
				readFile(
					path.join(
						packageRoot,
						"node_modules",
						"@howaboua",
						"pi-codex-conversion",
						"package.json",
					),
					"utf8",
				).then((value) => JSON.parse(value)),
			]);
			if (
				piVersion !== protocol.piVersion ||
				conversionPackage.version !== protocol.conversionVersion
			) {
				throw new Error("Benchmark runtime versions do not match the frozen protocol.");
			}
			await Promise.all(
				manifest.tasks.flatMap((task) => [
					sandbox.assertImage(task.workerImage, { task, role: "worker" }),
					sandbox.assertImage(task.evaluatorImage, { task, role: "evaluator" }),
				]),
			);
		},
		async run({ task, arm, run }) {
			const started = Date.now();
			let result = {
				outcome: "invalid",
				cost: 0,
				elapsedMs: 0,
				lookupAttempts: 0,
				sandboxViolations: 0,
				patchDigest: ZERO_DIGEST,
				evaluatorDigest: ZERO_DIGEST,
			};
			let temporaryRoot;
			let rpc;
			let messages = [];
			let providerFailed = false;
			let settingsBefore = "";
			let worker;
			try {
				worker = await sandbox.createWorker(task, run.runId);
				temporaryRoot = await mkdtemp(path.join(temporaryParent, "prewalk-benchmark-run-"));
				const agentDir = path.join(temporaryRoot, "agent");
				const controllerWork = path.join(temporaryRoot, "work");
				const sessionPath = path.join(temporaryRoot, "session.jsonl");
				const scenarioPath = path.join(temporaryRoot, "scenario.json");
				const evidencePath = path.join(temporaryRoot, "tool-evidence.jsonl");
				const settingsPath = path.join(agentDir, "settings.json");
				await Promise.all([
					mkdir(agentDir, { recursive: true, mode: 0o700 }),
					mkdir(controllerWork, { recursive: true, mode: 0o700 }),
				]);
				await stageOpenAICodexCredential(authFile, path.join(agentDir, "auth.json"));
				await writeFile(
					path.join(agentDir, "prewalk.json"),
					`${JSON.stringify({ enabled: protocol.arms[arm]?.prewalk === true })}\n`,
					{ mode: 0o600, flag: "wx" },
				);
				await writeFile(
					path.join(agentDir, "pi-codex-conversion.json"),
					`${JSON.stringify(fixedConversionConfig(protocol))}\n`,
					{ mode: 0o600, flag: "wx" },
				);
				const armConfig = protocol.arms[arm];
				if (!armConfig) throw new Error("Benchmark arm is invalid.");
				const selectedModel = armConfig.selectedModel;
				const thinking = armConfig.thinking;
				settingsBefore = `${JSON.stringify({
					defaultProvider: "openai-codex",
					defaultModel: selectedModel.split("/")[1],
					defaultThinkingLevel: thinking,
					packages: [],
				})}\n`;
				await writeFile(settingsPath, settingsBefore, { mode: 0o600, flag: "wx" });
				await writeFile(
					scenarioPath,
					`${JSON.stringify({
						containerId: worker.containerId,
						evidencePath,
					})}\n`,
					{ mode: 0o600, flag: "wx" },
				);
				await writeFile(evidencePath, "", { mode: 0o600, flag: "wx" });
				await writeFile(
					sessionPath,
					`${JSON.stringify({
						type: "session",
						version: 3,
						id: randomUUID(),
						timestamp: new Date().toISOString(),
						cwd: controllerWork,
					})}\n`,
					{ mode: 0o600, flag: "wx" },
				);
				rpc = rpcFactory({
					executable: piExecutable,
					args: buildRpcLaunchArgs({
						extensionPath: extensionPaths[0],
						extraExtensions: extensionPaths.slice(1),
						sessionPath,
						model: selectedModel,
						thinking,
						noBuiltinTools: true,
					}),
					cwd: controllerWork,
					env: benchmarkProcessEnvironment(agentDir, temporaryRoot, scenarioPath),
					timeoutMs: task.timeoutSeconds * 1000,
				});
				let selected;
				try {
					const state = await rpc.send({ type: "get_state" });
					selected = state.data?.model;
					await rpc.send({
						type: "set_auto_retry",
						enabled: protocol.retryPolicy.autoRetry,
					});
					await rpc.send({ type: "set_auto_compaction", enabled: false });
					const eventIndex = rpc.events.length;
					await rpc.send({ type: "prompt", message: task.prompt });
					await rpc.waitFor(
						(event) => event.type === "agent_settled",
						task.timeoutSeconds * 1000,
						eventIndex,
					);
					const response = await rpc.send({ type: "get_messages" });
					messages = response.data?.messages ?? [];
				} catch {
					providerFailed = true;
					messages = assistantMessagesFromEvents(rpc.events);
				} finally {
					try {
						await rpc.close();
					} catch {
						providerFailed = true;
					}
				}
				if (actionableStderr(rpc.stderr).length > 0) providerFailed = true;
				if (!validateModelEvidence(arm, selected, messages)) providerFailed = true;
				if ((await readFile(settingsPath, "utf8")) !== settingsBefore) providerFailed = true;
				const seal = await sandbox.request(
					worker,
					{ method: "seal" },
					task.timeoutSeconds * 1000,
				);
				if (
					seal?.ok !== true ||
					typeof seal.patchBase64 !== "string" ||
					!/^[a-f0-9]{64}$/.test(seal.patchDigest) ||
					!/^[a-f0-9]{64}$/.test(seal.workspaceDigest)
				) {
					throw new Error("Worker seal is invalid.");
				}
				await sandbox.destroy(worker);
				worker = undefined;
				const evaluator = await sandbox.evaluate(task, run.runId, seal.patchBase64);
				const safety = await safetyTotals(evidencePath);
				result = {
					outcome:
						providerFailed || safety.sandboxViolations > 0 ? "invalid" : evaluator.outcome,
					cost: sumUsage(messages),
					elapsedMs: Date.now() - started,
					...safety,
					patchDigest: seal.patchDigest,
					evaluatorDigest: evaluator.evaluatorDigest,
				};
			} catch {
				result = {
					...result,
					outcome: "invalid",
					cost: Math.max(result.cost, sumUsage(messages)),
					elapsedMs: Date.now() - started,
				};
			} finally {
				if (rpc) {
					try {
						await rpc.close();
					} catch {
						// The result is already invalidated by the guarded run.
					}
				}
				try {
					await sandbox.cleanup();
				} catch {
					result = { ...result, outcome: "invalid", sandboxViolations: 1 };
				}
				if (temporaryRoot) {
					await rm(temporaryRoot, { recursive: true, force: true });
				}
			}
			return result;
		},
		async cleanup() {
			await sandbox.cleanup();
		},
	};
}
