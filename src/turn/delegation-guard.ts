import { type BoundaryValue, isRecord, isString } from "../guards.js";

const READ_ONLY_ACTIONS = new Set([
	"list",
	"models",
	"guide",
	"status",
	"children.list",
	"validate",
	"debug.run",
]);
const STOP_ACTIONS = new Set(["stop", "interrupt"]);

export function blocksPlannerDelegation(toolName: string, input: BoundaryValue): boolean {
	if (toolName !== "subagent") return false;
	if (!isRecord(input)) return true;
	return !(
		isString(input.action) &&
		(READ_ONLY_ACTIONS.has(input.action) || STOP_ACTIONS.has(input.action))
	);
}
