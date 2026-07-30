import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { containsHiddenGuidance } from "../src/protocol.mjs";
import { recipientFingerprint, recipientPair } from "../src/recipient-identity.mjs";

const scenarioPath = process.env.PREWALK_CANARY_SCENARIO;
if (!scenarioPath || !path.isAbsolute(scenarioPath)) {
	throw new Error("PREWALK_CANARY_SCENARIO must name an absolute owner-only file.");
}
const scenarioStat = lstatSync(scenarioPath);
if (!scenarioStat.isFile() || (scenarioStat.mode & 0o077) !== 0) {
	throw new Error("Canary scenario must be an owner-only regular file.");
}
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
const requiredStrings = [
	"kind",
	"cwd",
	"fixturePath",
	"markerPath",
	"plannerProvider",
	"plannerId",
	"targetProvider",
	"targetId",
];
if (
	!scenario ||
	typeof scenario !== "object" ||
	Object.keys(scenario).some((key) => ![...requiredStrings, "consent"].includes(key)) ||
	requiredStrings.some((key) => typeof scenario[key] !== "string" || !scenario[key]) ||
	!new Set(["chat", "readonly", "main"]).has(scenario.kind) ||
	!path.isAbsolute(scenario.cwd) ||
	!path.isAbsolute(scenario.fixturePath) ||
	!path.isAbsolute(scenario.markerPath) ||
	(scenario.consent !== undefined && typeof scenario.consent !== "string")
) {
	throw new Error("Canary scenario is invalid.");
}
const scenarioRoot = path.dirname(path.resolve(scenarioPath));
const fixturePath = path.resolve(scenario.fixturePath);
const markerPath = path.resolve(scenario.markerPath);
const cwd = path.resolve(scenario.cwd);
if (
	path.dirname(cwd) !== scenarioRoot ||
	path.dirname(fixturePath) !== cwd ||
	path.dirname(markerPath) !== scenarioRoot
) {
	throw new Error("Canary scenario paths escape their bounded directories.");
}

function resolvedInputPath(input) {
	return path.resolve(cwd, String(input?.path ?? ""));
}

function updateMarker(fields) {
	let current = {};
	try {
		current = JSON.parse(readFileSync(markerPath, "utf8"));
	} catch {
		// The first provider request may precede the explicit preflight marker.
	}
	writeFileSync(markerPath, JSON.stringify({ ...current, ...fields }), {
		mode: 0o600,
	});
}

export default function canaryGuard(pi) {
	pi.registerCommand("prewalk-canary-preflight", {
		description: "Validate canary target/auth/consent without a provider request",
		handler: async (_args, ctx) => {
			if (typeof pi.setSessionModelAndThinkingLevel !== "function") {
				throw new Error("Patched session-only host API is unavailable");
			}
			const planner = ctx.modelRegistry.find(scenario.plannerProvider, scenario.plannerId);
			const target = ctx.modelRegistry.find(scenario.targetProvider, scenario.targetId);
			if (!planner || !target) throw new Error("Planner or target is unavailable");
			if (
				!ctx.modelRegistry.hasConfiguredAuth(planner) ||
				!ctx.modelRegistry.hasConfiguredAuth(target)
			) {
				throw new Error("Planner or target lacks complete configured authentication");
			}
			const plannerFingerprint = recipientFingerprint(ctx.modelRegistry, planner);
			const targetFingerprint = recipientFingerprint(ctx.modelRegistry, target);
			const pair = recipientPair(ctx.modelRegistry, planner, target);
			if (pair === null) {
				throw new Error(
					"Custom cross-provider stream registration lacks streamImplementationId",
				);
			}
			if (pair && pair !== scenario.consent) {
				throw new Error("Effective-recipient consent does not match this runtime");
			}
			updateMarker({
				ready: true,
				plannerFingerprint,
				targetFingerprint,
				pair,
			});
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== scenario.targetProvider || ctx.model.id !== scenario.targetId)
			return;
		if (containsHiddenGuidance(event.payload)) {
			throw new Error("Hidden Prewalk guidance reached the final target provider payload");
		}
		let targetPayloadCount = 0;
		try {
			targetPayloadCount = JSON.parse(readFileSync(markerPath, "utf8")).targetPayloadCount ?? 0;
		} catch {
			// Marker is created below.
		}
		updateMarker({
			targetPayloadCount: targetPayloadCount + 1,
			finalTargetPayloadGuidanceFree: true,
		});
	});

	pi.on("tool_call", (event) => {
		const input = event.input ?? {};
		const deny = (reason) => ({
			block: true,
			reason: `PREWALK_CANARY_GUARD: ${reason}`,
		});
		if (scenario.kind === "chat") return deny("chat control may not use tools");
		if (event.toolName === "read") {
			return resolvedInputPath(input) === fixturePath
				? undefined
				: deny("read escaped the fixture");
		}
		if (scenario.kind === "readonly") {
			return deny("read-only control may only read the fixture");
		}
		if (event.toolName === "prewalk_checkpoint") return undefined;
		if (event.toolName === "edit") {
			if (resolvedInputPath(input) !== fixturePath) return deny("edit escaped the fixture");
			if (input.oldText !== "before" || input.newText !== "after")
				return deny("edit was not the bounded sentinel replacement");
			return undefined;
		}
		if (event.toolName === "write") {
			if (resolvedInputPath(input) !== fixturePath) return deny("write escaped the fixture");
			if (input.content !== "after\n") return deny("write content was not the bounded fixture");
			return undefined;
		}
		return deny(`unexpected tool ${event.toolName}`);
	});
}
