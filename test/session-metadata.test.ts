import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeSessionTitles, readSessionMetadataTitles } from "../src/session-metadata.js";

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
});
