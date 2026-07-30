import { createHash } from "node:crypto";
import {
	ARMS,
	benchmarkMetricsFor,
	canonicalDigest,
	canonicalJson,
	corpusDigest,
	evaluateReleaseMetrics,
	RESULT_OUTCOMES,
	validateManifest,
} from "./benchmark-contract.mjs";

const BLIND_ARMS = ["blind-a", "blind-b", "blind-c"];
const HEX_DIGEST = /^[a-f0-9]{64}$/;

function validateRows(manifest, schedule, rows) {
	const expected = manifest.tasks.length * manifest.repetitions * BLIND_ARMS.length;
	if (!Array.isArray(rows) || rows.length !== expected) {
		throw new Error(`Blinded report must include every run (${expected} required).`);
	}
	const expectedById = new Map(schedule.runs.map((run) => [run.runId, run]));
	for (const row of rows) {
		if ("arm" in row || ARMS.some((arm) => Object.values(row).includes(arm))) {
			throw new Error("Blinded evidence contains arm labels.");
		}
		const scheduled = expectedById.get(row.runId);
		if (
			!scheduled ||
			row.schemaVersion !== 1 ||
			row.corpusDigest !== schedule.corpusDigest ||
			row.scheduleDigest !== schedule.scheduleDigest ||
			row.taskId !== scheduled.taskId ||
			row.repetition !== scheduled.repetition ||
			row.blindArm !== scheduled.blindArm ||
			row.sequence !== scheduled.sequence ||
			!RESULT_OUTCOMES.includes(row.outcome) ||
			!Number.isFinite(row.cost) ||
			row.cost < 0 ||
			!Number.isFinite(row.elapsedMs) ||
			row.elapsedMs < 0 ||
			!Number.isInteger(row.lookupAttempts) ||
			row.lookupAttempts < 0 ||
			!Number.isInteger(row.sandboxViolations) ||
			row.sandboxViolations < 0 ||
			!HEX_DIGEST.test(row.patchDigest) ||
			!HEX_DIGEST.test(row.evaluatorDigest)
		) {
			throw new Error(`Invalid or duplicate blinded result: ${row.runId ?? "unknown"}.`);
		}
		expectedById.delete(row.runId);
	}
	if (expectedById.size > 0) throw new Error("Blinded report is missing required runs.");
}

function seededRandom(seed) {
	let state = Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16);
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 2 ** 32;
	};
}

function interval(values, confidenceLevel) {
	const sorted = values.sort((left, right) => left - right);
	const tail = (1 - confidenceLevel) / 2;
	return {
		lower: sorted[Math.floor((sorted.length - 1) * tail)],
		upper: sorted[Math.ceil((sorted.length - 1) * (1 - tail))],
	};
}

function taskClusteredIntervals(manifest, rows) {
	const analysis = manifest.protocol.analysis;
	const random = seededRandom(`${analysis.bootstrapSeed}:${corpusDigest(manifest)}`);
	const byTask = new Map(
		manifest.tasks.map((task) => [
			task.id,
			Object.fromEntries(
				BLIND_ARMS.map((blindArm) => [
					blindArm,
					rows.filter((row) => row.taskId === task.id && row.blindArm === blindArm),
				]),
			),
		]),
	);
	const armSamples = Object.fromEntries(
		BLIND_ARMS.map((blindArm) => [
			blindArm,
			{ passRate: [], medianCost: [], medianElapsedMs: [], lookupAttemptRate: [] },
		]),
	);
	const pairNames = BLIND_ARMS.flatMap((left, index) =>
		BLIND_ARMS.slice(index + 1).map((right) => [left, right]),
	);
	const pairSamples = Object.fromEntries(
		pairNames.map(([left, right]) => [
			`${left}-minus-${right}`,
			{ passRate: [], medianCost: [], medianElapsedMs: [], lookupAttemptRate: [] },
		]),
	);
	for (let sample = 0; sample < analysis.bootstrapSamples; sample += 1) {
		const sampled = Object.fromEntries(BLIND_ARMS.map((blindArm) => [blindArm, []]));
		for (let index = 0; index < manifest.tasks.length; index += 1) {
			const task = manifest.tasks[Math.floor(random() * manifest.tasks.length)];
			const cluster = byTask.get(task.id);
			for (const blindArm of BLIND_ARMS) sampled[blindArm].push(...cluster[blindArm]);
		}
		const sampleMetrics = Object.fromEntries(
			BLIND_ARMS.map((blindArm) => [blindArm, benchmarkMetricsFor(sampled[blindArm])]),
		);
		for (const blindArm of BLIND_ARMS) {
			for (const key of Object.keys(armSamples[blindArm])) {
				armSamples[blindArm][key].push(sampleMetrics[blindArm][key]);
			}
		}
		for (const [left, right] of pairNames) {
			const target = pairSamples[`${left}-minus-${right}`];
			for (const key of Object.keys(target)) {
				target[key].push(sampleMetrics[left][key] - sampleMetrics[right][key]);
			}
		}
	}
	const summarize = (samples) =>
		Object.fromEntries(
			Object.entries(samples).map(([key, values]) => [
				key,
				interval(values, analysis.confidenceLevel),
			]),
		);
	return {
		method: analysis.method,
		unit: analysis.unit,
		confidenceLevel: analysis.confidenceLevel,
		samples: analysis.bootstrapSamples,
		arms: Object.fromEntries(
			Object.entries(armSamples).map(([key, value]) => [key, summarize(value)]),
		),
		paired: Object.fromEntries(
			Object.entries(pairSamples).map(([key, value]) => [key, summarize(value)]),
		),
	};
}

export function freezeBlindedMetrics(manifest, schedule, rows) {
	validateManifest(manifest);
	if (
		schedule?.schemaVersion !== 1 ||
		schedule.corpusDigest !== corpusDigest(manifest) ||
		!HEX_DIGEST.test(schedule.scheduleDigest) ||
		!HEX_DIGEST.test(schedule.unblindingCommitment) ||
		!Array.isArray(schedule.runs)
	) {
		throw new Error("Blinded schedule is invalid.");
	}
	validateRows(manifest, schedule, rows);
	const base = {
		schemaVersion: 1,
		corpusDigest: schedule.corpusDigest,
		scheduleDigest: schedule.scheduleDigest,
		unblindingCommitment: schedule.unblindingCommitment,
		rawResultsDigest: canonicalDigest(rows),
		runCount: rows.length,
		metrics: Object.fromEntries(
			BLIND_ARMS.map((blindArm) => [
				blindArm,
				benchmarkMetricsFor(rows.filter((row) => row.blindArm === blindArm)),
			]),
		),
		confidenceIntervals: taskClusteredIntervals(manifest, rows),
	};
	return { ...base, metricsDigest: canonicalDigest(base) };
}

export function verifyFrozenMetrics(manifest, schedule, rows, lock, frozen) {
	const recomputed = freezeBlindedMetrics(manifest, schedule, rows);
	if (
		lock?.schemaVersion !== 1 ||
		lock.corpusDigest !== recomputed.corpusDigest ||
		lock.scheduleDigest !== recomputed.scheduleDigest ||
		lock.unblindingCommitment !== recomputed.unblindingCommitment ||
		lock.rawResultsDigest !== recomputed.rawResultsDigest ||
		lock.runCount !== recomputed.runCount ||
		canonicalJson(recomputed) !== canonicalJson(frozen)
	) {
		throw new Error("Raw benchmark evidence does not match its frozen metrics and lock.");
	}
	return frozen;
}

function validateMapping(mapping) {
	if (
		!mapping ||
		Object.keys(mapping).sort().join(",") !== [...BLIND_ARMS].sort().join(",") ||
		Object.values(mapping).sort().join(",") !== [...ARMS].sort().join(",")
	) {
		throw new Error("Unblinding mapping must be a one-to-one map of all frozen arms.");
	}
}

export function unblindFrozenMetrics(manifest, frozen, unblinding) {
	validateManifest(manifest);
	const locked = { ...frozen };
	delete locked.metricsDigest;
	if (
		!HEX_DIGEST.test(frozen?.metricsDigest) ||
		canonicalDigest(locked) !== frozen.metricsDigest ||
		frozen.corpusDigest !== corpusDigest(manifest) ||
		unblinding?.schemaVersion !== 1 ||
		unblinding.corpusDigest !== frozen.corpusDigest ||
		unblinding.scheduleDigest !== frozen.scheduleDigest
	) {
		throw new Error("Frozen metrics lock or unblinding digest is invalid.");
	}
	validateMapping(unblinding.mapping);
	if (
		unblinding.unblindingCommitment !== frozen.unblindingCommitment ||
		typeof unblinding.commitmentNonce !== "string" ||
		!HEX_DIGEST.test(unblinding.commitmentNonce) ||
		canonicalDigest({
			scheduleDigest: frozen.scheduleDigest,
			mapping: unblinding.mapping,
			nonce: unblinding.commitmentNonce,
		}) !== frozen.unblindingCommitment
	) {
		throw new Error("Unblinding mapping does not match its frozen commitment.");
	}
	const metrics = Object.fromEntries(
		Object.entries(unblinding.mapping).map(([blindArm, arm]) => [arm, frozen.metrics[blindArm]]),
	);
	const confidenceIntervals = {
		...frozen.confidenceIntervals,
		arms: Object.fromEntries(
			Object.entries(unblinding.mapping).map(([blindArm, arm]) => [
				arm,
				frozen.confidenceIntervals.arms[blindArm],
			]),
		),
		paired: Object.fromEntries(
			Object.entries(frozen.confidenceIntervals.paired).map(([key, value]) => {
				const [left, right] = key.split("-minus-");
				return [`${unblinding.mapping[left]}-minus-${unblinding.mapping[right]}`, value];
			}),
		),
	};
	const evaluation = evaluateReleaseMetrics(metrics);
	return {
		schemaVersion: 1,
		corpusDigest: frozen.corpusDigest,
		scheduleDigest: frozen.scheduleDigest,
		unblindingCommitment: frozen.unblindingCommitment,
		rawResultsDigest: frozen.rawResultsDigest,
		metricsDigest: frozen.metricsDigest,
		runCount: frozen.runCount,
		metrics,
		confidenceIntervals,
		...evaluation,
	};
}
