import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	loadSessionTitlesForIds,
	mergeSessionTitles,
	readSessionLogTitles,
	readSessionMetadataTitles,
} from "../../src/session/metadata.js";

describe("private session metadata", () => {
	it("loads valid titles and ignores malformed sidecars", async () => {
		const agentDir = await mkdtemp(path.join(os.tmpdir(), "prewalk-session-metadata-"));
		const directory = path.join(agentDir, "session-metadata", "summaries");
		await mkdir(directory, { recursive: true });
		await writeFile(
			path.join(directory, "valid.json"),
			JSON.stringify({
				schemaVersion: 1,
				sessionId: "session-one",
				title: "Useful title",
				summary: "private",
			}),
		);
		await writeFile(path.join(directory, "broken.json"), "not json");
		const titles = await readSessionMetadataTitles(agentDir);
		expect(titles.get("session-one")).toBe("Useful title");
		expect(titles.size).toBe(1);
		await rm(agentDir, { recursive: true, force: true });
	});

	it("prefers the current session-log title over older backfill metadata", () => {
		const titles = mergeSessionTitles(new Map([["session-one", "Backfilled title"]]), [
			{ id: "session-one", name: "Current title" },
			{ id: "session-two", name: "Another title" },
		]);
		expect(titles.get("session-one")).toBe("Current title");
		expect(titles.get("session-two")).toBe("Another title");
	});

	it("reads only session_info names from requested session logs", async () => {
		const agentDir = await mkdtemp(path.join(os.tmpdir(), "prewalk-session-logs-"));
		const projectDir = path.join(agentDir, "sessions", "--project--");
		await mkdir(projectDir, { recursive: true });
		await writeFile(
			path.join(projectDir, "2026-08-13T00-00-00-000Z_session-named.jsonl"),
			[
				JSON.stringify({
					type: "session",
					id: "session-named",
					timestamp: "2026-08-13T00:00:00.000Z",
					cwd: "/tmp",
				}),
				JSON.stringify({ type: "session_info", name: "First name" }),
				JSON.stringify({
					type: "message",
					role: "user",
					content: [{ type: "text", text: "noise that must not be required" }],
				}),
				JSON.stringify({ type: "session_info", name: "Latest name" }),
			].join("\n"),
		);
		await writeFile(
			path.join(projectDir, "2026-08-13T00-00-01-000Z_session-other.jsonl"),
			[
				JSON.stringify({
					type: "session",
					id: "session-other",
					timestamp: "2026-08-13T00:00:01.000Z",
					cwd: "/tmp",
				}),
				JSON.stringify({ type: "session_info", name: "Other title" }),
			].join("\n"),
		);

		const titles = await readSessionLogTitles(path.join(agentDir, "sessions"), [
			"session-named",
		]);
		expect(titles.get("session-named")).toBe("Latest name");
		expect(titles.has("session-other")).toBe(false);

		const combined = await loadSessionTitlesForIds(agentDir, ["session-named"], undefined);
		expect(combined.get("session-named")).toBe("Latest name");

		const metadataOnly = await loadSessionTitlesForIds(agentDir, []);
		expect(metadataOnly.size).toBe(0);

		await rm(agentDir, { recursive: true, force: true });
	});
});
