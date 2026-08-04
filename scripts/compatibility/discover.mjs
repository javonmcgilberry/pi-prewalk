import { readFile } from "node:fs/promises";
import { stableVersion } from "./contracts.mjs";

const [metadataPath, ledgerPath] = process.argv.slice(2);
if (!metadataPath) throw new Error("usage: discover.mjs <npm-metadata.json> [ledger.json]");
const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
const versions = Array.isArray(metadata.versions) ? metadata.versions : [];
const known = ledgerPath
	? new Set(JSON.parse(await readFile(ledgerPath, "utf8")).versions ?? [])
	: new Set();
const candidates = versions
	.filter(stableVersion)
	.filter((version) => !known.has(version))
	.map((version) => ({
		version,
		publishedAt: metadata.time?.[version] ?? null,
		integrity: metadata.integrity?.[version] ?? null,
		discoveredAt: new Date().toISOString(),
		source: "npm-registry",
	}));
process.stdout.write(`${JSON.stringify({ candidates })}\n`);
