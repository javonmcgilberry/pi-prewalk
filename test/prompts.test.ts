import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const expectedHashes = new Map([
	["prewalk-plan.md", "349513aa69d05e492d3657df49489e32486d303ea09464929af31d466b13b9c8"],
	["prewalk-continue.md", "d8e402a29942139df021a6f1ec78a4b1e18fa72dbd1c538b851555846847335d"],
	["prewalk-checklist.md", "910cddca1c6bb446cb65dd7d5580cfc1989088cb14ff35b42e3a4fed5b44dfc2"],
]);

async function bytes(path: string): Promise<Buffer> {
	return readFile(path);
}

describe("canonical OMP prompt assets", () => {
	for (const name of ["prewalk-plan.md", "prewalk-continue.md", "prewalk-checklist.md"]) {
		it(`matches the canonical ${name} digest`, async () => {
			const local = await bytes(resolve(root, "prompts", name));
			expect(createHash("sha256").update(local).digest("hex")).toBe(expectedHashes.get(name));
		});
	}
});
