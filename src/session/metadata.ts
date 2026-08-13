import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const MAX_METADATA_FILES = 10_000;
const MAX_SESSION_LOG_INDEX = 50_000;
const SESSION_LOG_NAME_CONCURRENCY = 10;

export async function readSessionMetadataTitles(
	agentDir: string,
): Promise<ReadonlyMap<string, string>> {
	const directory = path.join(agentDir, "session-metadata", "summaries");
	let names: string[];
	try {
		const entries = await readdir(directory);
		names = entries.filter((name) => name.endsWith(".json")).sort((a, b) => a.localeCompare(b));
	} catch (error) {
		if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return new Map();
		throw error;
	}
	if (names.length > MAX_METADATA_FILES) {
		throw new Error(`Session metadata scan exceeds the ${MAX_METADATA_FILES}-file safety limit`);
	}

	const titles = new Map<string, string>();
	for (const name of names) {
		try {
			const value: unknown = JSON.parse(await readFile(path.join(directory, name), "utf8"));
			if (!value || typeof value !== "object" || Array.isArray(value)) continue;
			const schemaVersion = Reflect.get(value, "schemaVersion");
			const sessionId = Reflect.get(value, "sessionId");
			const storedTitle = Reflect.get(value, "title");
			if (
				schemaVersion !== 1 ||
				typeof sessionId !== "string" ||
				typeof storedTitle !== "string"
			)
				continue;
			const title = storedTitle.replace(/[\r\n]+/g, " ").trim();
			if (sessionId.trim() && title) titles.set(sessionId, title);
		} catch {
			// Analytics remain available when one optional private sidecar is malformed.
		}
	}
	return titles;
}

export function mergeSessionTitles(
	metadataTitles: ReadonlyMap<string, string>,
	sessions: readonly { id: string; name?: string }[],
): ReadonlyMap<string, string> {
	const titles = new Map(metadataTitles);
	for (const session of sessions) {
		if (session.name) titles.set(session.id, session.name);
	}
	return titles;
}

/**
 * Resolve display titles without SessionManager.listAll().
 *
 * Pi's listAll builds firstMessage/allMessagesText for every session file, which
 * dominates /prewalk stats open time. Stats only needs names for sessions that
 * already appear in the analytics ledger.
 *
 * - No sessionIds → metadata sidecars only (fast open path).
 * - With sessionIds → metadata plus a light session_info scan of those logs.
 */
export async function loadSessionTitlesForIds(
	agentDir: string,
	sessionIds?: readonly string[],
	sessionDirectory = process.env.PI_CODING_AGENT_SESSION_DIR,
): Promise<ReadonlyMap<string, string>> {
	const metadataTitles = await readSessionMetadataTitles(agentDir);
	if (!sessionIds || sessionIds.length === 0) return metadataTitles;

	const uniqueIds = [...new Set(sessionIds.filter((id) => id.trim().length > 0))];
	if (uniqueIds.length === 0) return metadataTitles;

	const sessionsRoot = sessionDirectory?.trim()
		? path.resolve(sessionDirectory)
		: path.join(agentDir, "sessions");
	const logTitles = await readSessionLogTitles(sessionsRoot, uniqueIds);
	return mergeSessionTitles(
		metadataTitles,
		[...logTitles.entries()].map(([id, name]) => ({ id, name })),
	);
}

export async function readSessionLogTitles(
	sessionsRoot: string,
	sessionIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
	const wanted = new Set(sessionIds);
	if (wanted.size === 0) return new Map();

	const pathsById = await indexSessionLogPaths(sessionsRoot);
	const titles = new Map<string, string>();
	const queue = [...wanted].filter((id) => pathsById.has(id));
	let next = 0;

	const workers = Array.from(
		{ length: Math.min(SESSION_LOG_NAME_CONCURRENCY, queue.length || 1) },
		async () => {
			while (next < queue.length) {
				const id = queue[next++];
				const filePath = pathsById.get(id);
				if (!filePath) continue;
				const name = await readLatestSessionInfoName(filePath);
				if (name) titles.set(id, name);
			}
		},
	);
	await Promise.all(workers);
	return titles;
}

async function indexSessionLogPaths(sessionsRoot: string): Promise<Map<string, string>> {
	const pathsById = new Map<string, string>();
	let projectNames: string[];
	try {
		projectNames = (await readdir(sessionsRoot, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch (error) {
		if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return pathsById;
		throw error;
	}

	let indexed = 0;
	for (const projectName of projectNames) {
		const projectDir = path.join(sessionsRoot, projectName);
		let files: string[];
		try {
			files = await readdir(projectDir);
		} catch {
			continue;
		}
		for (const name of files) {
			if (!name.endsWith(".jsonl")) continue;
			indexed += 1;
			if (indexed > MAX_SESSION_LOG_INDEX) {
				throw new Error(
					`Session log index exceeds the ${MAX_SESSION_LOG_INDEX}-file safety limit`,
				);
			}
			const id = sessionIdFromLogFileName(name);
			if (id) pathsById.set(id, path.join(projectDir, name));
		}
	}
	return pathsById;
}

function sessionIdFromLogFileName(name: string): string | undefined {
	const underscore = name.lastIndexOf("_");
	if (underscore < 0 || !name.endsWith(".jsonl")) return undefined;
	const id = name.slice(underscore + 1, -".jsonl".length).trim();
	return id || undefined;
}

async function readLatestSessionInfoName(filePath: string): Promise<string | undefined> {
	const rl = createInterface({
		input: createReadStream(filePath, { encoding: "utf8" }),
		crlfDelay: Infinity,
	});
	let name: string | undefined;
	try {
		for await (const line of rl) {
			if (!line.includes("session_info")) continue;
			try {
				const entry: unknown = JSON.parse(line);
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
				if (Reflect.get(entry, "type") !== "session_info") continue;
				const raw = Reflect.get(entry, "name");
				name = typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
			} catch {
				// Skip malformed lines; the ledger UI still works without a title.
			}
		}
	} catch (error) {
		if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return undefined;
		throw error;
	} finally {
		rl.close();
	}
	return name;
}
