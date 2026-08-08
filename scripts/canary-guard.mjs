import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	canaryPayloadTargetsModel,
	findCanaryHiddenGuidancePaths,
	isCanaryMutationInput,
} from "./canary-support.mjs";

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
	Object.keys(scenario).some(
		(key) => !["cwd", "fixturePath", "markerPath", "targetModel"].includes(key),
	) ||
	typeof scenario.cwd !== "string" ||
	typeof scenario.fixturePath !== "string" ||
	typeof scenario.markerPath !== "string" ||
	typeof scenario.targetModel !== "string"
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
const hiddenPrompts = [readFileSync(path.join(packageRoot, "prompts", "prewalk-plan.md"), "utf8")];

function readMarker() {
	try {
		return JSON.parse(readFileSync(markerPath, "utf8"));
	} catch {
		return {};
	}
}

function updateMarker(update) {
	writeFileSync(markerPath, JSON.stringify({ ...readMarker(), ...update }), { mode: 0o600 });
}

function recordToolEvent(event) {
	const marker = readMarker();
	const toolEvents = Array.isArray(marker.toolEvents) ? marker.toolEvents : [];
	updateMarker({ toolEvents: [...toolEvents, event].slice(-64) });
}

export default function canaryGuard(pi) {
	pi.on("before_provider_request", (event) => {
		if (!canaryPayloadTargetsModel(event.payload, scenario.targetModel)) return;
		const guidancePaths = findCanaryHiddenGuidancePaths(event.payload, hiddenPrompts);
		if (guidancePaths.length > 0) {
			updateMarker({ targetPayloadGuidanceFree: false, payloadGuidancePaths: guidancePaths });
			throw new Error("Hidden Prewalk plan guidance reached the executor provider payload.");
		}
		const marker = readMarker();
		updateMarker({
			targetPayloadCount: (marker.targetPayloadCount ?? 0) + 1,
			targetPayloadGuidanceFree: true,
		});
	});

	pi.on("tool_call", (event) => {
		const deny = (reason) => ({
			block: true,
			reason: `PREWALK_CANARY_GUARD: ${reason}`,
		});
		if (event.toolName === "prewalk_todo") {
			recordToolEvent("prewalk_todo:allowed");
			return undefined;
		}
		if (event.toolName === "read") {
			const requestedPath = path.resolve(cwd, String(event.input?.path ?? ""));
			if (requestedPath === fixturePath) {
				recordToolEvent("read:allowed");
				return undefined;
			}
			recordToolEvent("read:blocked-path");
			return deny("read escaped the fixture");
		}
		if (event.toolName !== "edit" && event.toolName !== "write") {
			recordToolEvent(`${event.toolName}:blocked-unexpected`);
			return deny(`unexpected tool ${event.toolName}`);
		}
		const requestedPath = path.resolve(cwd, String(event.input?.path ?? ""));
		if (!isCanaryMutationInput(event.toolName, event.input, requestedPath, fixturePath)) {
			recordToolEvent(
				`${event.toolName}:${requestedPath === fixturePath ? "blocked-input" : "blocked-path"}`,
			);
			return deny("mutation was not the bounded sentinel replacement");
		}
		recordToolEvent(`${event.toolName}:allowed`);
		return undefined;
	});
}
