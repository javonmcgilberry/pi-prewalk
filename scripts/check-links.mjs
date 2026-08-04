import { access, readFile } from "node:fs/promises";
import path from "node:path";

const files = ["README.md", "THIRD_PARTY_NOTICES.md"];
const failures = [];
for (const file of files) {
	const text = await readFile(file, "utf8");
	for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
		const target = match[1];
		if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue;
		const clean = target.split("#", 1)[0];
		if (!clean) continue;
		await access(path.resolve(path.dirname(file), clean)).catch(() =>
			failures.push(`${file}: ${target}`),
		);
	}
}
if (failures.length) throw new Error(`Broken local links:\n${failures.join("\n")}`);
