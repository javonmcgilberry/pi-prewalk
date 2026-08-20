#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_ROWS = 4_096;
const MIN_ROWS_PER_MODEL = 64;
const SESSION_ROOT = path.join(
	process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
	"sessions",
);
const OUTPUT = path.resolve(process.argv[2] ?? ".auto/context-calibration.json");

function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}

async function sessionFiles(directory) {
	const files = [];
	async function visit(current) {
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch (error) {
			if (error && typeof error === "object" && error.code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const candidate = path.join(current, entry.name);
			if (entry.isDirectory()) await visit(candidate);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(candidate);
		}
	}
	await visit(directory);
	return files.sort();
}

function parseEntries(contents) {
	const entries = [];
	for (const line of contents.split("\n")) {
		if (!line) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// A partially written final line is not evidence.
		}
	}
	return entries;
}

function usageTotal(usage) {
	const explicit = Number(usage?.totalTokens);
	if (Number.isFinite(explicit) && explicit > 0) return explicit;
	return [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite].reduce(
		(total, value) => total + (Number.isFinite(value) ? Number(value) : 0),
		0,
	);
}

function requestInput(usage) {
	return [usage?.input, usage?.cacheRead, usage?.cacheWrite].reduce(
		(total, value) => total + (Number.isFinite(value) ? Number(value) : 0),
		0,
	);
}

function contentTokenEstimate(content) {
	if (typeof content === "string") return Math.ceil(content.length / 4);
	if (!Array.isArray(content)) return 0;
	let characters = 0;
	for (const block of content) {
		characters +=
			block?.type === "text" ? (typeof block.text === "string" ? block.text.length : 0) : 4_800;
	}
	return Math.ceil(characters / 4);
}

function rowForPair(sessionId, previousEntry, nextEntry, trailingMessages) {
	const previous = previousEntry.message;
	const next = nextEntry.message;
	const previousTotalTokens = usageTotal(previous.usage);
	const actualRequestTokens = requestInput(next.usage);
	if (previousTotalTokens <= 0 || actualRequestTokens <= 0) return undefined;

	const key = digest(`${sessionId}:${previousEntry.id}:${nextEntry.id}`);
	const trailingTokens = trailingMessages.reduce(
		(total, message) => total + contentTokenEstimate(message.content),
		0,
	);
	return {
		key,
		split:
			Number.parseInt(key.slice(0, 2), 16) < 180
				? "train"
				: Number.parseInt(key.slice(0, 2), 16) < 230
					? "validation"
					: "holdout",
		scoreEligible: next.api !== "cursor-sdk",
		api: next.api,
		provider: next.provider,
		model: next.model,
		previousUsage: {
			input: Number(previous.usage.input) || 0,
			output: Number(previous.usage.output) || 0,
			cacheRead: Number(previous.usage.cacheRead) || 0,
			cacheWrite: Number(previous.usage.cacheWrite) || 0,
			totalTokens: previousTotalTokens,
		},
		trailingMessageCount: trailingMessages.length,
		trailingTokens,
		actualRequestTokens,
	};
}

function candidateRows(entries, rejected) {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const sessionId = entries.find((entry) => entry.type === "session")?.id ?? "unknown-session";
	const rows = [];

	for (const nextEntry of entries) {
		const next = nextEntry.type === "message" ? nextEntry.message : undefined;
		if (
			next?.role !== "assistant" ||
			!next.usage ||
			next.stopReason === "aborted" ||
			next.stopReason === "error"
		) {
			continue;
		}

		let cursor = nextEntry.parentId;
		let previousEntry;
		let rejection;
		const trailing = [];
		for (let depth = 0; cursor && depth < 256; depth += 1) {
			const entry = byId.get(cursor);
			if (!entry) {
				rejection = "missing-parent";
				break;
			}
			if (entry.type === "message" && entry.message?.role === "assistant") {
				previousEntry = entry;
				break;
			}
			if (entry.type !== "message") {
				rejection = entry.type ?? "unknown-entry";
				break;
			}
			if (entry.message?.role !== "user" && entry.message?.role !== "toolResult") {
				rejection = `message:${entry.message?.role ?? "unknown"}`;
				break;
			}
			trailing.push(entry.message);
			cursor = entry.parentId;
		}

		if (!previousEntry) {
			rejected[rejection ?? "no-previous-assistant"] =
				(rejected[rejection ?? "no-previous-assistant"] ?? 0) + 1;
			continue;
		}
		const previous = previousEntry.message;
		if (!previous.usage || previous.stopReason === "aborted" || previous.stopReason === "error") {
			rejected["invalid-previous-assistant"] = (rejected["invalid-previous-assistant"] ?? 0) + 1;
			continue;
		}
		if (
			previous.api !== next.api ||
			previous.provider !== next.provider ||
			previous.model !== next.model
		) {
			rejected["model-change"] = (rejected["model-change"] ?? 0) + 1;
			continue;
		}

		const row = rowForPair(sessionId, previousEntry, nextEntry, trailing.reverse());
		if (row) rows.push(row);
		else rejected["invalid-usage"] = (rejected["invalid-usage"] ?? 0) + 1;
	}
	return rows;
}

function sampleRows(rows) {
	if (rows.length <= MAX_ROWS)
		return rows.sort((left, right) => left.key.localeCompare(right.key));
	const selected = [];
	const splitBudgets = { train: 2_867, validation: 819, holdout: 410 };
	for (const [split, budget] of Object.entries(splitBudgets)) {
		const groups = new Map();
		for (const row of rows) {
			if (row.split !== split) continue;
			const group = `${row.api}|${row.provider}|${row.model}`;
			const values = groups.get(group) ?? [];
			values.push(row);
			groups.set(group, values);
		}

		const splitRows = [];
		const remainder = [];
		for (const values of groups.values()) {
			values.sort((left, right) => left.key.localeCompare(right.key));
			splitRows.push(...values.slice(0, Math.min(MIN_ROWS_PER_MODEL, values.length)));
			remainder.push(...values.slice(Math.min(MIN_ROWS_PER_MODEL, values.length)));
		}
		remainder.sort((left, right) => left.key.localeCompare(right.key));
		selected.push(...splitRows, ...remainder.slice(0, Math.max(0, budget - splitRows.length)));
	}
	return selected.sort((left, right) => left.key.localeCompare(right.key)).slice(0, MAX_ROWS);
}

const files = await sessionFiles(SESSION_ROOT);
const rejected = {};
const candidates = [];
for (const file of files) {
	const metadata = await stat(file);
	if (!metadata.isFile()) continue;
	candidates.push(...candidateRows(parseEntries(await readFile(file, "utf8")), rejected));
}
const rows = sampleRows(candidates);
const publicRows = rows.map(({ key: _key, ...row }) => row);
const sourceDigest = digest(
	JSON.stringify(
		rows.map(
			({ key, actualRequestTokens, previousUsage, trailingMessageCount, trailingTokens }) => ({
				key,
				actualRequestTokens,
				previousUsage,
				trailingMessageCount,
				trailingTokens,
			}),
		),
	),
);
const corpus = {
	schemaVersion: 1,
	privacy:
		"Content-free structural features only. No message text, paths, credentials, or session identifiers.",
	sourceFiles: files.length,
	candidateRows: candidates.length,
	sampledRows: rows.length,
	sourceDigest,
	rejected,
	rows: publicRows,
};

await mkdir(path.dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(corpus, null, 2)}\n`, { mode: 0o600 });
console.log(
	JSON.stringify({
		output: path.relative(process.cwd(), OUTPUT),
		sourceFiles: files.length,
		candidateRows: candidates.length,
		sampledRows: rows.length,
		sourceDigest,
	}),
);
