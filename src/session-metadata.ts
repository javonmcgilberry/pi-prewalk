import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const MAX_METADATA_FILES = 10_000;

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
