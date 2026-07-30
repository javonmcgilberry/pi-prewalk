import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isThinkingLevel } from "../src/protocol.mjs";
import { parseModelRef } from "./rpc-support.mjs";

export const CANARY_CONFIRMATION = "I_UNDERSTAND_PROVIDER_REQUESTS";
export const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const EVIDENCE_PREFIX = "prewalk-canary-";
const EVIDENCE_SUFFIX = ".json";
const CONSENT_PATTERN = /^[a-f0-9]{64}->[a-f0-9]{64}$/;

function takeValue(argv, index, name) {
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
	return value;
}

export function parseCanaryArgs(argv) {
	const options = {
		confirmation: undefined,
		planner: undefined,
		target: undefined,
		thinking: "low",
		consent: undefined,
		authFile: undefined,
		modelsFile: undefined,
		piExecutable: undefined,
		evidenceDir: undefined,
		retentionMs: DEFAULT_RETENTION_MS,
		timeoutMs: 10 * 60 * 1_000,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const name = argv[index];
		if (name === "--confirm-provider-cost") options.confirmation = takeValue(argv, index++, name);
		else if (name === "--planner") options.planner = takeValue(argv, index++, name);
		else if (name === "--target") options.target = takeValue(argv, index++, name);
		else if (name === "--thinking") options.thinking = takeValue(argv, index++, name);
		else if (name === "--consent") options.consent = takeValue(argv, index++, name);
		else if (name === "--auth-file") options.authFile = takeValue(argv, index++, name);
		else if (name === "--models-file") options.modelsFile = takeValue(argv, index++, name);
		else if (name === "--pi") options.piExecutable = takeValue(argv, index++, name);
		else if (name === "--evidence-dir") options.evidenceDir = takeValue(argv, index++, name);
		else if (name === "--retention-hours")
			options.retentionMs = Number(takeValue(argv, index++, name)) * 60 * 60 * 1_000;
		else if (name === "--timeout-ms") options.timeoutMs = Number(takeValue(argv, index++, name));
		else throw new Error(`Unknown canary option: ${name}`);
	}
	return options;
}

export function validateCanaryOptions(options) {
	if (options.confirmation !== CANARY_CONFIRMATION) {
		throw new Error(
			`Provider canary requires explicit provider-cost opt-in: --confirm-provider-cost ${CANARY_CONFIRMATION}.`,
		);
	}
	const planner = parseModelRef(options.planner);
	const target = parseModelRef(options.target);
	if (!isThinkingLevel(options.thinking))
		throw new Error("Provider canary thinking level is invalid.");
	if (
		!Number.isFinite(options.retentionMs) ||
		options.retentionMs <= 0 ||
		options.retentionMs > MAX_RETENTION_MS
	) {
		throw new Error(
			"Provider canary evidence retention must be greater than zero and no more than 168 hours.",
		);
	}
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000)
		throw new Error("Provider canary timeout must be at least 1000ms.");
	if (options.consent && !CONSENT_PATTERN.test(options.consent)) {
		throw new Error("Provider canary consent must be <planner-fingerprint->target-fingerprint>.");
	}
	if (planner.provider !== target.provider && !options.consent) {
		throw new Error(
			"Cross-provider canary requires exact effective-recipient consent: --consent <planner-fingerprint->target-fingerprint>.",
		);
	}
	return { ...options, planner, target };
}

function safeCount(value, name) {
	if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid evidence ${name}.`);
	return value;
}

function safeLabels(values, name) {
	if (
		!Array.isArray(values) ||
		!values.every((value) => typeof value === "string" && /^[a-z0-9._:/-]+$/i.test(value))
	) {
		throw new Error(`Invalid evidence ${name}.`);
	}
	return [...values];
}

export function buildEvidenceSummary({
	now = new Date(),
	retentionMs = DEFAULT_RETENTION_MS,
	outcome,
	planner,
	target,
	requestModels,
	requestCount,
	checkpointCount,
	mutationCount,
	assertions,
}) {
	if (!new Set(["passed", "failed"]).has(outcome)) throw new Error("Invalid canary outcome.");
	const createdAt = new Date(now);
	if (!Number.isFinite(createdAt.getTime())) throw new Error("Invalid evidence timestamp.");
	if (!Number.isFinite(retentionMs) || retentionMs <= 0 || retentionMs > MAX_RETENTION_MS) {
		throw new Error("Invalid evidence retention.");
	}
	return {
		schemaVersion: 1,
		createdAt: createdAt.toISOString(),
		expiresAt: new Date(createdAt.getTime() + retentionMs).toISOString(),
		outcome,
		planner: `${planner.provider}/${planner.id}`,
		target: `${target.provider}/${target.id}`,
		requestModels: safeLabels(requestModels, "request models"),
		requestCount: safeCount(requestCount, "request count"),
		checkpointCount: safeCount(checkpointCount, "checkpoint count"),
		mutationCount: safeCount(mutationCount, "mutation count"),
		assertions: safeLabels(assertions, "assertions"),
	};
}

async function validateEvidenceDirectory(directory, create) {
	if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
	let info;
	try {
		info = await lstat(directory);
	} catch (error) {
		if (!create && error.code === "ENOENT") return false;
		throw error;
	}
	if (info.isSymbolicLink() || !info.isDirectory())
		throw new Error("Evidence directory must be a real directory, not a symlink.");
	if (typeof process.getuid === "function" && info.uid !== process.getuid())
		throw new Error("Evidence directory is not owned by the current user.");
	return true;
}

export async function writeEvidence(directory, summary) {
	const allowedKeys = new Set([
		"schemaVersion",
		"createdAt",
		"expiresAt",
		"outcome",
		"planner",
		"target",
		"requestModels",
		"requestCount",
		"checkpointCount",
		"mutationCount",
		"assertions",
	]);
	if (Object.keys(summary).some((key) => !allowedKeys.has(key))) {
		throw new Error("Evidence summary contains a forbidden field.");
	}
	const serialized = `${JSON.stringify(summary, null, 2)}\n`;
	if (/\/(?:Users|home|tmp)\//i.test(serialized)) {
		throw new Error("Evidence summary contains an absolute host path.");
	}
	await validateEvidenceDirectory(directory, true);
	await chmod(directory, 0o700);
	const filePath = path.join(directory, `${EVIDENCE_PREFIX}${randomUUID()}${EVIDENCE_SUFFIX}`);
	await writeFile(filePath, serialized, {
		encoding: "utf8",
		mode: 0o600,
		flag: "wx",
	});
	await chmod(filePath, 0o600);
	return filePath;
}

export async function pruneEvidence(directory, now = new Date()) {
	if (!(await validateEvidenceDirectory(directory, false))) return [];
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	const removed = [];
	for (const entry of entries) {
		if (
			!entry.isFile() ||
			!entry.name.startsWith(EVIDENCE_PREFIX) ||
			!entry.name.endsWith(EVIDENCE_SUFFIX)
		)
			continue;
		const filePath = path.join(directory, entry.name);
		let value;
		try {
			value = JSON.parse(await readFile(filePath, "utf8"));
		} catch {
			continue;
		}
		if (value.schemaVersion !== 1 || typeof value.expiresAt !== "string") continue;
		const expiresAt = Date.parse(value.expiresAt);
		if (!Number.isFinite(expiresAt) || expiresAt > now.getTime()) continue;
		await rm(filePath, { force: true });
		removed.push(filePath);
	}
	return removed;
}
