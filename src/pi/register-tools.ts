import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PrewalkApplication } from "../orchestration/prewalk-application.js";
import { PREWALK_TODO_TOOL_NAME, type TodoInput } from "../turn/todo.js";
import type { TurnGate } from "../turn/turn-gate.js";

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

export interface PrewalkToolRegistration {
	application: PrewalkApplication;
	turnGate: TurnGate;
	assertCurrentToolExecution(
		toolCallId: string,
		ctx: ExtensionContext | undefined,
		retryPlanning: boolean,
	): void;
	onTodoInitialized(): void;
}

const PREFERRED_CONSTRAINED_SAMPLING = {
	type: "json_schema",
	strict: "prefer",
} as const;

/** Registers the namespaced checklist tool and keeps its schema at the Pi seam. */
export function registerPrewalkTools(pi: ExtensionAPI, deps: PrewalkToolRegistration): void {
	pi.registerTool({
		name: PREWALK_TODO_TOOL_NAME,
		label: "Prewalk Todo",
		description: "Create and maintain the phased implementation checklist required by Prewalk.",
		parameters: TodoParameters,
		constrainedSampling: PREFERRED_CONSTRAINED_SAMPLING,
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			deps.assertCurrentToolExecution(toolCallId, ctx, true);
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
			if (input.op === "init") deps.onTodoInitialized();
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
			};
		},
	});
}
