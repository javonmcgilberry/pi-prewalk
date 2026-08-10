import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PrewalkApplication } from "../orchestration/prewalk-application.js";
import { PREWALK_TODO_TOOL_NAME, type TodoInput } from "../turn/todo.js";
import type { TurnGate } from "../turn/turn-gate.js";

export const PREWALK_ASSESS_TOOL_NAME = "prewalk_assess";

export const TodoParameters = Type.Object({
	op: Type.Union([
		Type.Literal("init"),
		Type.Literal("start"),
		Type.Literal("done"),
		Type.Literal("rm"),
		Type.Literal("drop"),
		Type.Literal("block"),
		Type.Literal("unblock"),
		Type.Literal("append"),
		Type.Literal("view"),
	]),
	list: Type.Optional(
		Type.Array(
			Type.Object({
				phase: Type.String(),
				items: Type.Array(Type.String()),
			}),
		),
	),
	task: Type.Optional(Type.String()),
	phase: Type.Optional(Type.String()),
	items: Type.Optional(Type.Array(Type.String())),
	reason: Type.Optional(Type.String()),
});

export const AssessmentParameters = Type.Object({
	decision: Type.Union([Type.Literal("continue"), Type.Literal("bypass")]),
});

export interface AssessmentState {
	decision?: "continue" | "bypass";
	invalid: boolean;
}

export interface PrewalkToolRegistration {
	application: PrewalkApplication;
	turnGate: TurnGate;
	assertCurrentToolExecution(toolCallId: string): void;
	getAssessment(): AssessmentState | undefined;
	setAssessmentDecision(decision: "continue" | "bypass"): void;
}

/** Registers the two namespaced tools and keeps their schemas at the Pi seam. */
export function registerPrewalkTools(pi: ExtensionAPI, deps: PrewalkToolRegistration): void {
	pi.registerTool({
		name: PREWALK_TODO_TOOL_NAME,
		label: "Prewalk Todo",
		description: "Create and maintain the phased implementation checklist required by Prewalk.",
		parameters: TodoParameters,
		async execute(toolCallId, params) {
			deps.assertCurrentToolExecution(toolCallId);
			const run = deps.application.run;
			if (!run || run.phase === "cancelled" || run.phase === "failed") {
				throw new Error("Prewalk todo is inactive.");
			}
			const input: TodoInput = {
				op: params.op,
				...(params.list ? { list: params.list } : {}),
				...(params.task ? { task: params.task } : {}),
				...(params.phase ? { phase: params.phase } : {}),
				...(params.items ? { items: params.items } : {}),
				...(params.reason ? { reason: params.reason } : {}),
			};
			const result = deps.turnGate.applyTodo(input);
			if (result.isError) throw new Error(result.text);
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
			};
		},
	});

	pi.registerTool({
		name: PREWALK_ASSESS_TOOL_NAME,
		label: "Prewalk assessment",
		description:
			"Record whether substantial implementation work remains after bounded inspection.",
		parameters: AssessmentParameters,
		async execute(toolCallId, params) {
			deps.assertCurrentToolExecution(toolCallId);
			const evaluation = deps.getAssessment();
			if (!evaluation || evaluation.invalid || evaluation.decision) {
				throw new Error("Prewalk assessment is inactive.");
			}
			if (params.decision !== "continue" && params.decision !== "bypass") {
				throw new Error("Prewalk assessment decision is invalid.");
			}
			deps.setAssessmentDecision(params.decision);
			return { content: [{ type: "text", text: "Assessment recorded." }], details: {} };
		},
	});
}
