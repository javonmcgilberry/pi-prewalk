import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const CANARY_CONFIRMATION = "I_UNDERSTAND_PROVIDER_REQUESTS";
export const CANARY_TOOL_ALLOWLIST = "prewalk_todo,read,edit,write";
export const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const EVIDENCE_PREFIX = "prewalk-canary-";
const EVIDENCE_SUFFIX = ".json";
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const ALLOWED_EVIDENCE_KEYS = new Set([
	"schemaVersion",
	"createdAt",
	"expiresAt",
	"outcome",
	"requestModels",
	"usage",
	"status",
	"trigger",
	"settingsBefore",
	"settingsAfter",
	"assertions",
	"auditEvents",
	"toolEvents",
	"payloadGuidancePaths",
]);

export function containsCanaryHiddenGuidance(payload, hiddenPrompts) {
	return findCanaryHiddenGuidancePaths(payload, hiddenPrompts).length > 0;
}

export function findCanaryHiddenGuidancePaths(payload, hiddenPrompts) {
	const expected = hiddenPrompts.map((prompt) => prompt.trim()).filter(Boolean);
	const paths = [];
	const visit = (value, path) => {
		if (paths.length >= 16) return;
		if (typeof value === "string") {
			if (expected.some((prompt) => value.includes(prompt))) paths.push(path);
			return;
		}
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index += 1)
				visit(value[index], `${path}[${index}]`);
			return;
		}
		if (!value || typeof value !== "object") return;
		for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
	};
	visit(payload, "$payload");
	return paths;
}

export function canaryPayloadTargetsModel(payload, model) {
	if (!payload || typeof payload !== "object") return false;
	if (payload.model === model) return true;
	const request = payload.request;
	return Boolean(request && typeof request === "object" && request.model === model);
}

export function canaryAuditState(entries) {
	const audits = entries.filter(
		(entry) => entry?.type === "custom" && entry.customType === "prewalk-audit",
	);
	const events = audits
		.map((entry) => entry.data?.event)
		.filter((event) => typeof event === "string");
	const latest = audits.at(-1)?.data;
	if (latest?.event === "failed") {
		return {
			state: "failed",
			events,
			...(typeof latest.reasonCode === "string" ? { reasonCode: latest.reasonCode } : {}),
		};
	}
	if (events.includes("handoff-completed")) return { state: "completed", events };
	return { state: events.includes("todo-ready") ? "ready" : "running", events };
}

export function evaluateCanaryPayloadMarker(marker, requirement) {
	if (marker?.targetPayloadGuidanceFree === false) {
		return { ok: false, reasonCode: "hidden-guidance-observed" };
	}
	if (
		marker === undefined ||
		!Number.isFinite(marker.targetPayloadCount) ||
		marker.targetPayloadCount < 1
	) {
		return requirement === "optional"
			? { ok: true, assertion: "target-payload-hook-unavailable" }
			: { ok: false, reasonCode: "target-payload-not-observed" };
	}
	if (marker.targetPayloadGuidanceFree !== true) {
		return { ok: false, reasonCode: "hidden-guidance-observed" };
	}
	return { ok: true, assertion: "target-payload-guidance-free" };
}

export function isCanaryMutationInput(toolName, input, requestedPath, fixturePath) {
	if (requestedPath !== fixturePath || !input || typeof input !== "object") return false;
	if (toolName === "write") return input.content === "after" || input.content === "after\n";
	if (toolName !== "edit") return false;
	return (
		(input.oldText === "before" && input.newText === "after") ||
		(input.oldText === "before\n" && input.newText === "after\n")
	);
}

function takeValue(argv, index, name) {
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
	return value;
}

export function parseCanaryArgs(argv) {
	const options = {
		confirmation: undefined,
		authFile: undefined,
		piExecutable: undefined,
		evidenceDir: undefined,
		planner: { provider: "openai-codex", model: "gpt-5.6-sol" },
		executor: { provider: "openai-codex", model: "gpt-5.6-luna" },
		plannerThinking: "high",
		executorThinking: "low",
		extensions: [],
		payloadInspection: "required",
		retentionMs: DEFAULT_RETENTION_MS,
		timeoutMs: 10 * 60 * 1_000,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const name = argv[index];
		if (name === "--confirm-provider-cost") {
			options.confirmation = takeValue(argv, index++, name);
		} else if (name === "--auth-file") {
			options.authFile = takeValue(argv, index++, name);
		} else if (name === "--pi") {
			options.piExecutable = takeValue(argv, index++, name);
		} else if (name === "--evidence-dir") {
			options.evidenceDir = takeValue(argv, index++, name);
		} else if (name === "--planner") {
			options.planner = parseCanaryModelRef(takeValue(argv, index++, name), name);
		} else if (name === "--executor") {
			options.executor = parseCanaryModelRef(takeValue(argv, index++, name), name);
		} else if (name === "--planner-thinking") {
			options.plannerThinking = takeValue(argv, index++, name);
		} else if (name === "--executor-thinking") {
			options.executorThinking = takeValue(argv, index++, name);
		} else if (name === "--extension") {
			options.extensions.push(takeValue(argv, index++, name));
		} else if (name === "--payload-inspection") {
			options.payloadInspection = takeValue(argv, index++, name);
		} else if (name === "--retention-hours") {
			options.retentionMs = Number(takeValue(argv, index++, name)) * 60 * 60 * 1_000;
		} else if (name === "--timeout-ms") {
			options.timeoutMs = Number(takeValue(argv, index++, name));
		} else {
			throw new Error(`Unknown canary option: ${name}`);
		}
	}
	return options;
}

export function validateCanaryOptions(options) {
	if (options.confirmation !== CANARY_CONFIRMATION) {
		throw new Error(
			`Provider canary requires explicit provider-cost opt-in: --confirm-provider-cost ${CANARY_CONFIRMATION}.`,
		);
	}
	if (!options.authFile || !path.isAbsolute(options.authFile)) {
		throw new Error("Provider canary requires an absolute --auth-file.");
	}
	if (!THINKING_LEVELS.has(options.plannerThinking)) {
		throw new Error("Provider canary planner thinking level is invalid.");
	}
	if (!THINKING_LEVELS.has(options.executorThinking)) {
		throw new Error("Provider canary executor thinking level is invalid.");
	}
	if (!options.extensions.every((extension) => path.isAbsolute(extension))) {
		throw new Error("Provider canary extensions must be absolute paths.");
	}
	if (options.payloadInspection !== "required" && options.payloadInspection !== "optional") {
		throw new Error("Provider canary payload inspection must be required or optional.");
	}
	if (
		!Number.isFinite(options.retentionMs) ||
		options.retentionMs <= 0 ||
		options.retentionMs > MAX_RETENTION_MS
	) {
		throw new Error("Provider canary retention must be between 1 and 168 hours.");
	}
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000) {
		throw new Error("Provider canary timeout must be at least 1000ms.");
	}
	return options;
}

function parseCanaryModelRef(value, name) {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) {
		throw new Error(`${name} must use provider/model format.`);
	}
	return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

export function buildCanaryPrewalkConfig(executor, reasoning) {
	return {
		executor: { ...executor, reasoning },
		executorFallbacks: [],
		analytics: {
			enabled: false,
			catalogFallbackEnabled: false,
			recentReceiptCount: 10,
			schemaVersion: 1,
		},
	};
}

function safeLabels(values, name) {
	if (
		!Array.isArray(values) ||
		!values.every(
			(value) => typeof value === "string" && value.length > 0 && !/[\r\n]/.test(value),
		)
	) {
		throw new Error(`Invalid evidence ${name}.`);
	}
	return [...values];
}

export function buildEvidenceSummary({
	now = new Date(),
	retentionMs = DEFAULT_RETENTION_MS,
	outcome,
	requestModels,
	usage,
	status,
	trigger,
	settingsBefore,
	settingsAfter,
	assertions,
	auditEvents = [],
	toolEvents = [],
	payloadGuidancePaths = [],
}) {
	if (outcome !== "passed" && outcome !== "failed") {
		throw new Error("Invalid canary outcome.");
	}
	if (!status || typeof status !== "string") throw new Error("Invalid canary status.");
	if (trigger !== undefined && typeof trigger !== "string") {
		throw new Error("Invalid canary trigger.");
	}
	const numericUsage = {};
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"]) {
		const value = usage?.[key] ?? 0;
		if (!Number.isFinite(value) || value < 0) throw new Error("Invalid canary usage.");
		numericUsage[key] = value;
	}
	for (const digest of [settingsBefore, settingsAfter]) {
		if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
			throw new Error("Invalid settings digest.");
		}
	}
	const createdAt = new Date(now);
	return {
		schemaVersion: 1,
		createdAt: createdAt.toISOString(),
		expiresAt: new Date(createdAt.getTime() + retentionMs).toISOString(),
		outcome,
		requestModels: safeLabels(requestModels, "request models"),
		usage: numericUsage,
		status,
		...(trigger ? { trigger } : {}),
		settingsBefore,
		settingsAfter,
		assertions: safeLabels(assertions, "assertions"),
		auditEvents: safeLabels(auditEvents, "audit events"),
		toolEvents: safeLabels(toolEvents, "tool events"),
		payloadGuidancePaths: safeLabels(payloadGuidancePaths, "payload guidance paths"),
	};
}

async function validateEvidenceDirectory(directory, create) {
	if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
	let info;
	try {
		info = await lstat(directory);
	} catch (error) {
		if (!create && error instanceof Error && "code" in error && error.code === "ENOENT") {
			return false;
		}
		throw error;
	}
	if (info.isSymbolicLink() || !info.isDirectory()) {
		throw new Error("Evidence directory must be a real directory, not a symlink.");
	}
	if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
		throw new Error("Evidence directory is not owned by the current user.");
	}
	return true;
}

export async function writeEvidence(directory, summary) {
	if (Object.keys(summary).some((key) => !ALLOWED_EVIDENCE_KEYS.has(key))) {
		throw new Error("Evidence summary contains a forbidden field.");
	}
	const serialized = `${JSON.stringify(summary, null, 2)}\n`;
	if (
		/(authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|\/Users\/|\/home\/|\/tmp\/)/i.test(
			serialized,
		)
	) {
		throw new Error("Evidence summary contains secret-shaped or host-path data.");
	}
	await validateEvidenceDirectory(directory, true);
	await chmod(directory, 0o700);
	const filePath = path.join(directory, `${EVIDENCE_PREFIX}${randomUUID()}${EVIDENCE_SUFFIX}`);
	await writeFile(filePath, serialized, { mode: 0o600, flag: "wx" });
	await chmod(filePath, 0o600);
	return filePath;
}

export async function pruneEvidence(directory, now = new Date()) {
	if (!(await validateEvidenceDirectory(directory, false))) return [];
	const removed = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (
			!entry.isFile() ||
			!entry.name.startsWith(EVIDENCE_PREFIX) ||
			!entry.name.endsWith(EVIDENCE_SUFFIX)
		) {
			continue;
		}
		const filePath = path.join(directory, entry.name);
		let value;
		try {
			value = JSON.parse(await readFile(filePath, "utf8"));
		} catch {
			continue;
		}
		if (
			value?.schemaVersion === 1 &&
			typeof value.expiresAt === "string" &&
			Date.parse(value.expiresAt) <= now.getTime()
		) {
			await rm(filePath, { force: true });
			removed.push(filePath);
		}
	}
	return removed;
}

export async function stageOpenAICodexCredential(sourceFile, targetFile) {
	const source = JSON.parse(await readFile(sourceFile, "utf8"));
	const credential = source?.["openai-codex"];
	if (
		!credential ||
		typeof credential !== "object" ||
		credential.type !== "oauth" ||
		typeof credential.access !== "string" ||
		typeof credential.refresh !== "string" ||
		typeof credential.expires !== "number"
	) {
		throw new Error("The source auth file has no complete openai-codex OAuth credential.");
	}
	await writeFile(targetFile, `${JSON.stringify({ "openai-codex": credential })}\n`, {
		mode: 0o600,
		flag: "wx",
	});
	await chmod(targetFile, 0o600);
}

export async function stageProviderCredentials(sourceFile, targetFile, providers) {
	const source = JSON.parse(await readFile(sourceFile, "utf8"));
	const staged = {};
	for (const provider of [...new Set(providers)]) {
		const credential = source?.[provider];
		if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
			throw new Error(`The source auth file has no credential for ${provider}.`);
		}
		staged[provider] = credential;
	}
	await writeFile(targetFile, `${JSON.stringify(staged)}\n`, {
		mode: 0o600,
		flag: "wx",
	});
	await chmod(targetFile, 0o600);
}
