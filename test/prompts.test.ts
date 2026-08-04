import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const ompRevision = "f559e7e9dc1e8818d5d8e15ace28da3d42f2457d";
const expectedHashes = new Map([
	["prewalk-plan.md", "0a7442a41c2d8554f0683ac947323bc8a20d2cd6ebda049a9d9df323f2471a78"],
	["prewalk-checklist.md", "045383ef934fe8afc7b0c13ad647caf9ad0aed4d6f1af594657a968aabe660d1"],
	["prewalk-continue.md", "9af48cebe3490c679a6670968b8d59ed418d4a9a374a8d99f9be1165c93478f0"],
]);

async function bytes(path: string): Promise<Buffer> {
	return readFile(path);
}

describe("canonical OMP prompt assets", () => {
	it("pins one immutable upstream revision", () => {
		expect(ompRevision).toMatch(/^[0-9a-f]{40}$/);
	});

	for (const name of ["prewalk-plan.md", "prewalk-continue.md", "prewalk-checklist.md"]) {
		it(`matches the canonical ${name} digest`, async () => {
			const local = await bytes(resolve(root, "prompts", name));
			expect(createHash("sha256").update(local).digest("hex")).toBe(expectedHashes.get(name));
		});
	}
});
