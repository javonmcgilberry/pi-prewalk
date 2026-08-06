import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { containsCanaryHiddenGuidance } from "./canary-support.mjs";

const scenarioPath = process.env.PREWALK_CANARY_SCENARIO;
if (!scenarioPath || !path.isAbsolute(scenarioPath)) {
	throw new Error("PREWALK_CANARY_SCENARIO must be an absolute owner-only file.");
}
const scenarioStat = lstatSync(scenarioPath);
if (!scenarioStat.isFile() || (scenarioStat.mode & 0o077) !== 0) {
	throw new Error("Canary scenario must be an owner-only regular file.");
}
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
if (
	!scenario ||
	typeof scenario !== "object" ||
	Object.keys(scenario).some((key) => !["cwd", "fixturePath", "markerPath"].includes(key)) ||
	typeof scenario.cwd !== "string" ||
	typeof scenario.fixturePath !== "string" ||
	typeof scenario.markerPath !== "string"
) {
	throw new Error("Canary scenario is invalid.");
}
const cwd = path.resolve(scenario.cwd);
const fixturePath = path.resolve(scenario.fixturePath);
const markerPath = path.resolve(scenario.markerPath);
const scenarioRoot = path.dirname(path.resolve(scenarioPath));
if (path.dirname(cwd) !== scenarioRoot || path.dirname(fixturePath) !== cwd) {
	throw new Error("Canary fixture escapes the bounded working directory.");
}
if (path.dirname(markerPath) !== scenarioRoot) {
	throw new Error("Canary marker escapes the bounded temporary directory.");
}
const packageRoot = path.resolve(import.meta.dirname, "..");
const hiddenPrompts = [
	readFileSync(path.join(packageRoot, "prompts", "prewalk-plan.md"), "utf8"),
	readFileSync(path.join(packageRoot, "prompts", "prewalk-continue.md"), "utf8"),
];

export default function canaryGuard(pi) {
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "openai-codex" || ctx.model.id !== "gpt-5.6-luna") return;
		if (containsCanaryHiddenGuidance(event.payload, hiddenPrompts)) {
			throw new Error("Hidden Prewalk guidance reached the Luna provider payload.");
		}
		let targetPayloadCount = 0;
		try {
			targetPayloadCount = JSON.parse(readFileSync(markerPath, "utf8")).targetPayloadCount ?? 0;
		} catch {
			// The first Luna request creates the marker.
		}
		writeFileSync(
			markerPath,
			JSON.stringify({
				targetPayloadCount: targetPayloadCount + 1,
				lunaPayloadGuidanceFree: true,
			}),
			{ mode: 0o600 },
		);
	});

	pi.on("tool_call", (event) => {
		const deny = (reason) => ({
			block: true,
			reason: `PREWALK_CANARY_GUARD: ${reason}`,
		});
		if (event.toolName === "prewalk_todo") return undefined;
		if (event.toolName !== "edit" && event.toolName !== "write") {
			return deny(`unexpected tool ${event.toolName}`);
		}
		const requestedPath = path.resolve(cwd, String(event.input?.path ?? ""));
		if (requestedPath !== fixturePath) return deny("mutation escaped the fixture");
		if (
			event.toolName === "edit" &&
			(event.input?.oldText !== "before" || event.input?.newText !== "after")
		) {
			return deny("edit was not the bounded sentinel replacement");
		}
		if (event.toolName === "write" && event.input?.content !== "after\n") {
			return deny("write was not the bounded sentinel replacement");
		}
		return undefined;
	});
}
