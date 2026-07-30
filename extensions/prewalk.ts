import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type AuditEventKind,
	createAuditRecord,
	PREWALK_AUDIT_TYPE,
	parseAuditRecord,
	runFromAudit,
} from "../src/audit.js";
import {
	EXECUTOR_MODEL_ID,
	EXECUTOR_PROVIDER,
	isPlannerSelected,
	PLANNER_MODEL_ID,
	PLANNER_PROVIDER,
	PREWALK_CHECKLIST_MESSAGE_TYPE,
	PREWALK_CONTINUE_MESSAGE_TYPE,
	PREWALK_PLAN_MESSAGE_TYPE,
	type PrewalkConfig,
	PrewalkCoordinator,
	type PrewalkRun,
	parseConfig,
} from "../src/core.js";
import { isRecord } from "../src/guards.js";
import { MutationTurnBuffer } from "../src/mutation.js";
import { createProviderOverlay, type ProviderOverlay } from "../src/provider-overlay.js";
import { compactStatus, detailedStatus } from "../src/status.js";
import {
	applyTodoOperation,
	latestTodoPhases,
	type TodoInput,
	type TodoPhase,
	TodoReminder,
} from "../src/todo.js";

const STATUS_KEY = "prewalk";
const PREWALK_TODO_REMINDER_MESSAGE_TYPE = "prewalk-todo-reminder";
const PROMPT_TYPES = new Set([
	PREWALK_PLAN_MESSAGE_TYPE,
	PREWALK_CONTINUE_MESSAGE_TYPE,
	PREWALK_CHECKLIST_MESSAGE_TYPE,
	PREWALK_TODO_REMINDER_MESSAGE_TYPE,
]);

const TodoParameters = Type.Object({
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

interface PromptSet {
	plan: string;
	continue: string;
	checklist: string;
	todo: string;
}

function promptFile(name: string): URL {
	return new URL(`../prompts/${name}`, import.meta.url);
}

function loadPrompts(): PromptSet {
	return {
		plan: readFileSync(promptFile("prewalk-plan.md"), "utf8"),
		continue: readFileSync(promptFile("prewalk-continue.md"), "utf8"),
		checklist: readFileSync(promptFile("prewalk-checklist.md"), "utf8"),
		todo: readFileSync(promptFile("todo.md"), "utf8"),
	};
}

const prompts = loadPrompts();

function configPath(): string {
	return path.join(getAgentDir(), "prewalk.json");
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readConfig(): Promise<PrewalkConfig> {
	let raw: string;
	try {
		raw = await readFileAsync(configPath(), "utf8");
	} catch (error) {
		if (isMissingFile(error)) {
			throw new Error("configuration-invalid");
		}
		throw error;
	}
	try {
		return parseConfig(JSON.parse(raw));
	} catch {
		throw new Error("configuration-invalid");
	}
}

function isPrewalkPrompt(
	message: AgentMessage,
): message is Extract<AgentMessage, { role: "custom" }> {
	return message.role === "custom" && PROMPT_TYPES.has(message.customType);
}

function runIdFromMessage(message: AgentMessage): string | undefined {
	if (!isPrewalkPrompt(message) || !isRecord(message.details)) return undefined;
	return typeof message.details.runId === "string" ? message.details.runId : undefined;
}

function shouldExposePrompt(message: AgentMessage, run: PrewalkRun | undefined): boolean {
	if (!isPrewalkPrompt(message)) return true;
	const messageRunId = runIdFromMessage(message);
	if (!messageRunId) return false;
	if (!run || messageRunId !== run.id || run.phase === "cancelled") return false;
	if (message.customType === PREWALK_TODO_REMINDER_MESSAGE_TYPE) return true;
	if (
		run.phase === "handoff-pending" ||
		run.phase === "active" ||
		run.phase === "completed" ||
		(run.phase === "failed" && run.effectiveRoute === "luna")
	) {
		return message.customType === PREWALK_CHECKLIST_MESSAGE_TYPE;
	}
	return message.customType !== PREWALK_CHECKLIST_MESSAGE_TYPE;
}

function acceptsMutationEvidence(run: PrewalkRun | undefined): boolean {
	return run?.phase === "armed" || run?.phase === "planning" || run?.phase === "ready";
}

function latestAuditRecord(ctx: ExtensionContext) {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== PREWALK_AUDIT_TYPE) {
			continue;
		}
		const record = parseAuditRecord(entry.data);
		if (record) return record;
	}
	return undefined;
}

export default function prewalkExtension(pi: ExtensionAPI): void {
	const coordinator = new PrewalkCoordinator();
	const mutations = new MutationTurnBuffer();
	const todoReminder = new TodoReminder();
	let overlay: ProviderOverlay | undefined;
	let primaryAgentStream = false;
	let todoPhases: TodoPhase[] = [];
	let todoConflict = false;
	let lastAuditKey: string | undefined;
	let lastStatus: string | undefined;

	const updateStatus = (ctx: ExtensionContext): void => {
		const nextStatus = compactStatus(coordinator.run, ctx.model);
		if (nextStatus === lastStatus) return;
		ctx.ui.setStatus(STATUS_KEY, nextStatus);
		lastStatus = nextStatus;
	};

	const audit = (event: AuditEventKind, ctx: ExtensionContext): void => {
		const run = coordinator.run;
		if (!run) return;
		const record = createAuditRecord(run, event);
		const key = JSON.stringify(record);
		if (key === lastAuditKey) return;
		pi.appendEntry(PREWALK_AUDIT_TYPE, record);
		lastAuditKey = key;
		updateStatus(ctx);
	};

	const fail = (reasonCode: string, holdLunaRoute: boolean, ctx: ExtensionContext): void => {
		if (!coordinator.run) {
			coordinator.arm(
				randomUUID(),
				randomUUID(),
				"automatic",
				pi.getActiveTools().includes("todo"),
			);
		}
		coordinator.fail(reasonCode, holdLunaRoute);
		mutations.resetForRun();
		audit("failed", ctx);
		ctx.ui.notify(`Prewalk failed: ${reasonCode}.`, "error");
	};

	const cancel = (selectedModelIsSol: boolean, ctx: ExtensionContext): void => {
		coordinator.cancel(selectedModelIsSol);
		mutations.resetForRun();
		audit("cancelled", ctx);
		overlay?.restore();
		overlay = undefined;
	};

	const ensureOverlay = (ctx: ExtensionContext): ProviderOverlay => {
		if (overlay) return overlay;
		const candidate = createProviderOverlay(pi, ctx.modelRegistry, {
			shouldRouteToLuna: () =>
				coordinator.run?.phase === "handoff-pending" ||
				coordinator.run?.effectiveRoute === "luna",
			isPrimaryAgentStream: () => primaryAgentStream,
			currentRunId: () => coordinator.run?.id,
			onLunaStreamStarted: (runId) => {
				if (coordinator.run?.id !== runId || coordinator.run.phase !== "handoff-pending") {
					return;
				}
				try {
					coordinator.activateLuna();
					audit("luna-active", ctx);
				} catch {
					fail("provider-drift", false, ctx);
				}
			},
			onLunaStreamSucceeded: (runId) => {
				if (coordinator.run?.id !== runId || coordinator.run.phase !== "active") return;
				try {
					coordinator.completeHandoff();
					audit("handoff-completed", ctx);
				} catch {
					fail("provider-drift", true, ctx);
				}
			},
			onLunaStreamFailed: (runId) => {
				if (coordinator.run?.id !== runId) return;
				if (coordinator.run.phase === "handoff-pending") {
					fail("luna-stream-failed", false, ctx);
				} else if (coordinator.run.phase === "active") {
					fail("luna-stream-failed", true, ctx);
				}
			},
			onProviderDrift: () =>
				fail("provider-drift", coordinator.run?.effectiveRoute === "luna", ctx),
		});
		candidate.install();
		overlay = candidate;
		return candidate;
	};

	const verifyOverlayOwnership = (ctx: ExtensionContext): boolean => {
		if (
			!overlay ||
			overlay.ownsRegistration() ||
			coordinator.run?.phase === "cancelled" ||
			coordinator.run?.phase === "failed"
		) {
			return true;
		}
		fail("provider-drift", coordinator.run?.effectiveRoute === "luna", ctx);
		return false;
	};

	const validateModels = async (ctx: ExtensionContext): Promise<void> => {
		const planner = ctx.modelRegistry.find(PLANNER_PROVIDER, PLANNER_MODEL_ID);
		const executor = ctx.modelRegistry.find(EXECUTOR_PROVIDER, EXECUTOR_MODEL_ID);
		if (!planner || !executor || !isPlannerSelected(ctx.model)) {
			throw new Error("model-unavailable");
		}
		if (
			planner.api !== executor.api ||
			planner.contextWindow <= 0 ||
			executor.contextWindow < planner.contextWindow ||
			planner.maxTokens <= 0 ||
			executor.maxTokens <= 0
		) {
			throw new Error("model-unavailable");
		}
		const [plannerAuth, executorAuth] = await Promise.all([
			ctx.modelRegistry.getApiKeyAndHeaders(planner),
			ctx.modelRegistry.getApiKeyAndHeaders(executor),
		]);
		if (!plannerAuth.ok || !executorAuth.ok) {
			throw new Error("authorization-unavailable");
		}
	};

	const sendPrompt = async (
		type:
			| typeof PREWALK_PLAN_MESSAGE_TYPE
			| typeof PREWALK_CONTINUE_MESSAGE_TYPE
			| typeof PREWALK_CHECKLIST_MESSAGE_TYPE,
		ctx: ExtensionContext,
	): Promise<void> => {
		const run = coordinator.run;
		if (!run) return;
		let prompt: { content: string; event: AuditEventKind };
		switch (type) {
			case PREWALK_PLAN_MESSAGE_TYPE:
				prompt = { content: prompts.plan, event: "plan-injected" };
				break;
			case PREWALK_CONTINUE_MESSAGE_TYPE:
				prompt = { content: prompts.continue, event: "continuation" };
				break;
			case PREWALK_CHECKLIST_MESSAGE_TYPE:
				prompt = { content: prompts.checklist, event: "handoff-triggered" };
				break;
		}
		pi.sendMessage(
			{
				customType: type,
				content: prompt.content,
				display: false,
				details: { runId: run.id },
			},
			{ deliverAs: "steer" },
		);
		audit(prompt.event, ctx);
	};

	const startRun = async (mode: "automatic" | "manual", ctx: ExtensionContext): Promise<void> => {
		if (!isPlannerSelected(ctx.model)) return;
		try {
			const config = await readConfig();
			if (mode === "automatic" && !config.enabled) return;
			if (todoConflict) throw new Error("todo-conflict");
			await validateModels(ctx);
			ensureOverlay(ctx);
			const todoActive = pi.getActiveTools().includes("todo");
			const action = coordinator.arm(randomUUID(), randomUUID(), mode, todoActive);
			mutations.resetForRun();
			todoReminder.reset();
			audit("armed", ctx);
			if (action.type === "send-planning") {
				await sendPrompt(PREWALK_PLAN_MESSAGE_TYPE, ctx);
			}
		} catch (error) {
			const reason =
				error instanceof Error &&
				[
					"configuration-invalid",
					"model-unavailable",
					"authorization-unavailable",
					"provider-unavailable",
					"provider-drift",
					"todo-conflict",
				].includes(error.message)
					? error.message
					: "provider-unavailable";
			fail(reason, false, ctx);
		}
	};

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Create and maintain the phased implementation checklist required by Prewalk.",
		promptSnippet: prompts.todo,
		promptGuidelines: [
			"Initialize the todo list before the first implementation mutation.",
			"Keep todo state current as work advances.",
		],
		parameters: TodoParameters,
		async execute(_toolCallId, params) {
			const input: TodoInput = {
				op: params.op,
				...(params.list ? { list: params.list } : {}),
				...(params.task ? { task: params.task } : {}),
				...(params.phase ? { phase: params.phase } : {}),
				...(params.items ? { items: params.items } : {}),
				...(params.reason ? { reason: params.reason } : {}),
			};
			const result = applyTodoOperation(todoPhases, input);
			if (result.isError) throw new Error(result.text);
			todoPhases = result.details.phases;
			if (params.op !== "view") todoReminder.reset();
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
			};
		},
	});

	pi.registerCommand("prewalk", {
		description: "Inspect, run, or cancel the current Prewalk handoff.",
		async handler(args, ctx) {
			const command = args.trim() || "status";
			if (command === "status") {
				ctx.ui.notify(detailedStatus(coordinator.run, ctx.model), "info");
				return;
			}
			if (command === "cancel") {
				if (!coordinator.run) {
					ctx.ui.notify("Prewalk is inactive.", "info");
					return;
				}
				cancel(isPlannerSelected(ctx.model), ctx);
				return;
			}
			if (command === "run") {
				if (
					coordinator.run &&
					coordinator.run.phase !== "cancelled" &&
					coordinator.run.phase !== "failed"
				) {
					ctx.ui.notify("Prewalk is already active.", "error");
					return;
				}
				await startRun("manual", ctx);
				return;
			}
			ctx.ui.notify("Usage: /prewalk [status|run|cancel]", "error");
		},
	});

	pi.registerCommand("todos", {
		description: "Show the current Prewalk todo list.",
		async handler(_args, ctx) {
			ctx.ui.notify(applyTodoOperation(todoPhases, { op: "view" }).text, "info");
		},
	});

	pi.on("session_start", async (event, ctx) => {
		primaryAgentStream = false;
		const todoTool = pi.getAllTools().find((tool) => tool.name === "todo");
		todoConflict = !todoTool || !todoTool.sourceInfo.path.toLowerCase().includes("prewalk");
		todoPhases = latestTodoPhases(
			ctx.sessionManager
				.buildContextEntries()
				.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
		);
		todoReminder.reset();
		if (event.reason === "reload") {
			const record = latestAuditRecord(ctx);
			if (record) {
				const restored = runFromAudit(record);
				coordinator.restore(restored);
				lastAuditKey = JSON.stringify(record);
				if (restored.phase === "cancelled") {
					updateStatus(ctx);
					return;
				}
				try {
					await validateModels(ctx);
					ensureOverlay(ctx);
				} catch {
					fail("provider-unavailable", restored.effectiveRoute === "luna", ctx);
				}
				updateStatus(ctx);
			}
			return;
		}
		coordinator.reset();
		mutations.resetForRun();
		lastAuditKey = undefined;
		await startRun("automatic", ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		primaryAgentStream = false;
		overlay?.restore();
		overlay = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		lastStatus = undefined;
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!verifyOverlayOwnership(ctx)) return;
		primaryAgentStream = true;
	});

	pi.on("agent_end", () => {
		primaryAgentStream = false;
	});

	pi.on("agent_settled", (_event, ctx) => {
		primaryAgentStream = false;
		if (coordinator.run?.phase !== "completed") return;
		const reminder = todoReminder.next(todoPhases);
		if (!reminder) return;
		pi.sendMessage(
			{
				customType: PREWALK_TODO_REMINDER_MESSAGE_TYPE,
				content: reminder,
				display: false,
				details: { runId: coordinator.run.id },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		updateStatus(ctx);
	});

	pi.on("tool_execution_update", (event) => {
		if (!acceptsMutationEvidence(coordinator.run)) return;
		mutations.recordExecutionUpdate(event);
	});

	pi.on("tool_result", (event) => {
		if (!acceptsMutationEvidence(coordinator.run)) return;
		mutations.recordResult({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			input: event.input,
			isError: event.isError,
			details: event.details,
		});
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!verifyOverlayOwnership(ctx)) return;
		const run = coordinator.run;
		if (!run || !acceptsMutationEvidence(run)) return;
		const evidence = mutations.finishTurn(event.message, {
			todoActive: run.todoActive,
			todoSeen: run.todoSeen,
		});
		const wasTodoReady = run.todoSeen;
		const wasContinuePending = run.continuePending;
		const action = coordinator.onTurnEnd(evidence);
		if (!wasTodoReady && coordinator.run?.todoSeen) audit("todo-ready", ctx);
		if (!wasContinuePending && coordinator.run?.continuePending) audit("progress", ctx);
		if (action.type === "send-planning") {
			await sendPrompt(PREWALK_PLAN_MESSAGE_TYPE, ctx);
		} else if (action.type === "send-continuation") {
			await sendPrompt(PREWALK_CONTINUE_MESSAGE_TYPE, ctx);
		} else if (action.type === "handoff") {
			audit("handoff-triggered", ctx);
			await sendPrompt(PREWALK_CHECKLIST_MESSAGE_TYPE, ctx);
			mutations.resetForRun();
		}
		updateStatus(ctx);
	});

	pi.on("context", (event) => ({
		messages: event.messages.filter((message) => shouldExposePrompt(message, coordinator.run)),
	}));

	pi.on("session_before_compact", (event) => {
		event.preparation.messagesToSummarize = event.preparation.messagesToSummarize.filter(
			(message) => !isPrewalkPrompt(message),
		);
		event.preparation.turnPrefixMessages = event.preparation.turnPrefixMessages.filter(
			(message) => !isPrewalkPrompt(message),
		);
	});

	pi.on("model_select", (event, ctx) => {
		if (event.source === "restore" || !coordinator.run || coordinator.run.phase === "cancelled") {
			return;
		}
		cancel(isPlannerSelected(event.model), ctx);
	});
}
