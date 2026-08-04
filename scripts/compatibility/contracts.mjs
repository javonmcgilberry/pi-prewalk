import { createHash } from "node:crypto";

const STATUSES = new Set(["supported", "failed", "pending", "skipped", "yanked", "review"]);
const MAX_SUMMARY = 2000;

export function stableVersion(version) {
	return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version);
}

function candidateVersion(version) {
	return typeof version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
}

export function validateCandidateResult(value) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("result must be an object");
	const keys = Object.keys(value).sort();
	const expected = [
		"artifactId",
		"dependencies",
		"integrity",
		"runId",
		"status",
		"summary",
		"testedAt",
		"version",
	];
	if (JSON.stringify(keys) !== JSON.stringify(expected))
		throw new Error("result fields are invalid");
	if (!candidateVersion(value.version)) throw new Error("version must be semver");
	if (!STATUSES.has(value.status)) throw new Error("status is invalid");
	for (const field of ["artifactId", "integrity", "runId", "testedAt"]) {
		if (
			typeof value[field] !== "string" ||
			value[field].length === 0 ||
			value[field].length > 200
		) {
			throw new Error(`${field} is invalid`);
		}
	}
	if (typeof value.summary !== "string" || value.summary.length > MAX_SUMMARY)
		throw new Error("summary is invalid");
	if (
		!value.dependencies ||
		typeof value.dependencies !== "object" ||
		Array.isArray(value.dependencies)
	) {
		throw new Error("dependencies are invalid");
	}
	for (const [name, version] of Object.entries(value.dependencies)) {
		if (
			!/^[a-zA-Z0-9@/._-]+$/.test(name) ||
			typeof version !== "string" ||
			version.length > 100
		) {
			throw new Error("dependency entry is invalid");
		}
	}
	return structuredClone(value);
}

export function marker(version) {
	if (!candidateVersion(version)) throw new Error("invalid marker version");
	return `<!-- prewalk-compat:start:${version} -->`;
}

function endMarker(version) {
	if (!candidateVersion(version)) throw new Error("invalid marker version");
	return `<!-- prewalk-compat:end:${version} -->`;
}

function markdownText(value) {
	return [...value]
		.map((character) => {
			const code = character.charCodeAt(0);
			return code <= 31 || code === 127 ? " " : character;
		})
		.join("")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("`", "\\`");
}

export function renderLedgerEntry(input) {
	const result = validateCandidateResult(input);
	const dependencies = Object.entries(result.dependencies)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, version]) => `${name}@${version}`)
		.join(", ");
	return [
		marker(result.version),
		`### Pi ${result.version} — ${result.status}`,
		`- Package: \`@earendil-works/pi-coding-agent@${result.version}\``,
		`- Integrity: \`${result.integrity}\``,
		`- Tested: ${result.testedAt}`,
		`- Workflow run: \`${result.runId}\`; artifact: \`${result.artifactId}\``,
		`- Dependencies: ${dependencies || "none"}`,
		`- Summary: ${result.summary ? markdownText(result.summary) : "none"}`,
		endMarker(result.version),
	].join("\n");
}

export function upsertLedger(body, input) {
	const entry = renderLedgerEntry(input);
	const start = marker(input.version);
	const end = endMarker(input.version);
	const startIndex = body.indexOf(start);
	if (startIndex < 0) return `${body.trimEnd()}\n\n${entry}\n`;
	const endIndex = body.indexOf(end, startIndex);
	if (endIndex < 0) throw new Error("ledger marker is incomplete");
	return `${body.slice(0, startIndex)}${entry}${body.slice(endIndex + end.length)}`;
}

export function failureFingerprint(input) {
	const result = validateCandidateResult(input);
	return createHash("sha256")
		.update(`${result.version}\0${result.integrity}\0${result.status}\0${result.summary}`)
		.digest("hex");
}
