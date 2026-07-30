import { randomInt as cryptoRandomInt, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	ARMS,
	BENCHMARK_CONFIRMATION,
	canonicalDigest,
	corpusDigest,
	validateManifest,
} from "./benchmark-contract.mjs";
import { freezeBlindedMetrics } from "./benchmark-report-lib.mjs";

const BLIND_ARMS = ["blind-a", "blind-b", "blind-c"];
const OUTCOMES = new Set(["passed", "failed", "timeout", "invalid"]);
const SECRET_SHAPE =
	/(authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|\/Users\/|\/home\/)/i;

function shuffle(values, randomInt) {
	const shuffled = [...values];
	for (let index = shuffled.length - 1; index > 0; index -= 1) {
		const selected = randomInt(index + 1);
		if (!Number.isInteger(selected) || selected < 0 || selected > index) {
			throw new Error("Benchmark random source returned an invalid index.");
		}
		[shuffled[index], shuffled[selected]] = [shuffled[selected], shuffled[index]];
	}
	return shuffled;
}

export function createBlindedSchedule(
	manifest,
	{
		randomInt = cryptoRandomInt,
		runId = randomUUID,
		commitmentNonce = () => randomBytes(32).toString("hex"),
	} = {},
) {
	validateManifest(manifest);
	const armOrder = shuffle(ARMS, randomInt);
	const unblinding = Object.fromEntries(
		BLIND_ARMS.map((blindArm, index) => [blindArm, armOrder[index]]),
	);
	const runs = [];
	const runIds = new Set();
	let sequence = 0;
	for (const task of manifest.tasks) {
		for (let repetition = 1; repetition <= manifest.repetitions; repetition += 1) {
			for (const blindArm of shuffle(BLIND_ARMS, randomInt)) {
				const id = runId();
				if (typeof id !== "string" || !id || runIds.has(id)) {
					throw new Error("Benchmark run IDs must be unique non-empty strings.");
				}
				runIds.add(id);
				runs.push({
					runId: id,
					taskId: task.id,
					repetition,
					blindArm,
					sequence: sequence++,
				});
			}
		}
	}
	const schedule = {
		schemaVersion: 1,
		corpusDigest: corpusDigest(manifest),
		runs,
	};
	const scheduleDigest = canonicalDigest(schedule);
	const nonce = commitmentNonce();
	if (typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce)) {
		throw new Error("Benchmark commitment nonce must contain 256 bits of entropy.");
	}
	return {
		...schedule,
		scheduleDigest,
		unblindingCommitment: canonicalDigest({ scheduleDigest, mapping: unblinding, nonce }),
		unblinding,
		commitmentNonce: nonce,
	};
}

function safeRuntimeResult(value) {
	if (
		!value ||
		typeof value !== "object" ||
		!OUTCOMES.has(value.outcome) ||
		!Number.isFinite(value.cost) ||
		value.cost < 0 ||
		!Number.isFinite(value.elapsedMs) ||
		value.elapsedMs < 0 ||
		!Number.isInteger(value.lookupAttempts) ||
		value.lookupAttempts < 0 ||
		!Number.isInteger(value.sandboxViolations) ||
		value.sandboxViolations < 0 ||
		typeof value.patchDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.patchDigest) ||
		typeof value.evaluatorDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.evaluatorDigest)
	) {
		throw new Error("Benchmark runtime returned an invalid result.");
	}
	return {
		outcome: value.outcome,
		cost: value.cost,
		elapsedMs: value.elapsedMs,
		lookupAttempts: value.lookupAttempts,
		sandboxViolations: value.sandboxViolations,
		patchDigest: value.patchDigest,
		evaluatorDigest: value.evaluatorDigest,
	};
}

async function createEmptyOutputDirectory(directory) {
	try {
		const entries = await readdir(directory);
		if (entries.length > 0) {
			throw new Error("Benchmark requires an empty output directory.");
		}
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			await mkdir(directory, { recursive: true, mode: 0o700 });
		} else {
			throw error;
		}
	}
	const info = await lstat(directory);
	if (info.isSymbolicLink() || !info.isDirectory()) {
		throw new Error("Benchmark artifact directory must be a real directory.");
	}
	if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
		throw new Error("Benchmark artifact directory must be owned by the current user.");
	}
	await chmod(directory, 0o700);
	return realpath(directory);
}

async function writePrivateJson(filePath, value) {
	const serialized = `${JSON.stringify(value, null, 2)}\n`;
	if (SECRET_SHAPE.test(serialized)) {
		throw new Error("Benchmark evidence contains secret-shaped data.");
	}
	await writeFile(filePath, serialized, { mode: 0o600, flag: "wx" });
}

export async function executeBenchmark({
	manifest,
	outputDirectory,
	controlDirectory,
	confirmation,
	runtime,
	randomInt,
	runId,
}) {
	validateManifest(manifest);
	if (confirmation !== BENCHMARK_CONFIRMATION) {
		throw new Error(`Benchmark requires --confirm-provider-cost ${BENCHMARK_CONFIRMATION}.`);
	}
	if (!path.isAbsolute(outputDirectory)) {
		throw new Error("Benchmark output directory must be absolute.");
	}
	if (
		!path.isAbsolute(controlDirectory) ||
		path.resolve(controlDirectory).startsWith(`${path.resolve(outputDirectory)}${path.sep}`) ||
		path.resolve(outputDirectory).startsWith(`${path.resolve(controlDirectory)}${path.sep}`) ||
		path.resolve(controlDirectory) === path.resolve(outputDirectory)
	) {
		throw new Error("Benchmark control directory must be absolute and separate from results.");
	}
	if (
		!runtime ||
		typeof runtime.preflight !== "function" ||
		typeof runtime.run !== "function" ||
		typeof runtime.cleanup !== "function"
	) {
		throw new Error("Benchmark runtime is invalid.");
	}
	await runtime.preflight(manifest);
	const canonicalOutputDirectory = await createEmptyOutputDirectory(outputDirectory);
	const canonicalControlDirectory = await createEmptyOutputDirectory(controlDirectory);
	if (
		canonicalControlDirectory === canonicalOutputDirectory ||
		canonicalControlDirectory.startsWith(`${canonicalOutputDirectory}${path.sep}`) ||
		canonicalOutputDirectory.startsWith(`${canonicalControlDirectory}${path.sep}`)
	) {
		throw new Error(
			"Benchmark artifact directories must remain separate after canonicalization.",
		);
	}
	const schedule = createBlindedSchedule(manifest, { randomInt, runId });
	const schedulePath = path.join(canonicalOutputDirectory, "blinded-schedule.json");
	const unblindingPath = path.join(canonicalControlDirectory, "unblinding.json");
	const resultsPath = path.join(canonicalOutputDirectory, "raw-results.jsonl");
	const lockPath = path.join(canonicalOutputDirectory, "raw-results.lock.json");
	const metricsPath = path.join(canonicalOutputDirectory, "blinded-metrics.json");
	await writePrivateJson(schedulePath, {
		schemaVersion: schedule.schemaVersion,
		corpusDigest: schedule.corpusDigest,
		scheduleDigest: schedule.scheduleDigest,
		unblindingCommitment: schedule.unblindingCommitment,
		runs: schedule.runs,
	});
	await writePrivateJson(unblindingPath, {
		schemaVersion: 1,
		corpusDigest: schedule.corpusDigest,
		scheduleDigest: schedule.scheduleDigest,
		unblindingCommitment: schedule.unblindingCommitment,
		commitmentNonce: schedule.commitmentNonce,
		mapping: schedule.unblinding,
	});
	const results = await open(resultsPath, "wx", 0o600);
	const rows = [];
	try {
		for (const scheduledRun of schedule.runs) {
			const task = manifest.tasks.find((entry) => entry.id === scheduledRun.taskId);
			if (!task) throw new Error("Benchmark schedule references an unknown task.");
			const arm = schedule.unblinding[scheduledRun.blindArm];
			let runtimeResult;
			let failureCode;
			try {
				runtimeResult = safeRuntimeResult(await runtime.run({ task, arm, run: scheduledRun }));
			} catch {
				runtimeResult = {
					outcome: "invalid",
					cost: 0,
					elapsedMs: 0,
					lookupAttempts: 0,
					sandboxViolations: 0,
					patchDigest: "0".repeat(64),
					evaluatorDigest: "0".repeat(64),
				};
				failureCode = "runtime-failed";
			} finally {
				try {
					await runtime.cleanup({ task, run: scheduledRun });
				} catch {
					runtimeResult = {
						outcome: "invalid",
						cost: 0,
						elapsedMs: 0,
						lookupAttempts: 0,
						sandboxViolations: 0,
						patchDigest: runtimeResult?.patchDigest ?? "0".repeat(64),
						evaluatorDigest: runtimeResult?.evaluatorDigest ?? "0".repeat(64),
					};
					failureCode = "cleanup-failed";
				}
			}
			if (runtimeResult.sandboxViolations > 0) {
				runtimeResult = { ...runtimeResult, outcome: "invalid" };
				failureCode = "sandbox-violation";
			}
			const row = {
				schemaVersion: 1,
				corpusDigest: schedule.corpusDigest,
				scheduleDigest: schedule.scheduleDigest,
				runId: scheduledRun.runId,
				taskId: scheduledRun.taskId,
				repetition: scheduledRun.repetition,
				blindArm: scheduledRun.blindArm,
				sequence: scheduledRun.sequence,
				...runtimeResult,
				...(failureCode ? { failureCode } : {}),
			};
			const serialized = JSON.stringify(row);
			if (SECRET_SHAPE.test(serialized)) {
				throw new Error("Benchmark result contains secret-shaped data.");
			}
			await results.write(`${serialized}\n`);
			await results.sync();
			rows.push(row);
		}
	} finally {
		await results.close();
	}
	const frozen = freezeBlindedMetrics(manifest, schedule, rows);
	await writePrivateJson(lockPath, {
		schemaVersion: 1,
		corpusDigest: schedule.corpusDigest,
		scheduleDigest: schedule.scheduleDigest,
		unblindingCommitment: schedule.unblindingCommitment,
		rawResultsDigest: frozen.rawResultsDigest,
		runCount: frozen.runCount,
	});
	await writePrivateJson(metricsPath, frozen);
	await chmod(resultsPath, 0o400);
	await chmod(lockPath, 0o400);
	await chmod(metricsPath, 0o400);
	return {
		runCount: schedule.runs.length,
		schedulePath,
		unblindingPath,
		resultsPath,
		lockPath,
		metricsPath,
	};
}
