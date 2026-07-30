import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	CHECKPOINT_TOOL,
	EXPLORATION_TOOLS,
	MAX_CHECKPOINT_ITEM_LENGTH,
	MAX_CHECKPOINT_ITEMS,
	MIN_CHECKPOINT_ITEMS,
	MUTATION_TOOLS,
	type PrewalkConfig,
	PrewalkCoordinator,
	type PrewalkRun,
	parseConfig,
	parseTarget,
	parseThinkingLevel,
	type RunMode,
	type ThinkingLevel,
	validateCheckpoint,
} from "../src/core.js";
import { HIDDEN_GUIDANCE_SENTINEL } from "../src/protocol.mjs";
import { recipientFingerprint, recipientPair } from "../src/recipient-identity.mjs";

const STATUS_KEY = "prewalk";

interface CheckpointDetails {
	accepted: boolean;
	runId?: string;
	itemCount?: number;
}

const CheckpointParameters = Type.Object({
	runId: Type.String({
		description: "Opaque run ID from the active Prewalk instruction",
	}),
	items: Type.Array(Type.String({ minLength: 1, maxLength: MAX_CHECKPOINT_ITEM_LENGTH }), {
		minItems: MIN_CHECKPOINT_ITEMS,
		maxItems: MAX_CHECKPOINT_ITEMS,
		description: "Implementation and verification checklist in execution order",
	}),
});

function configPath(): string {
	// pi-lens-ignore: ts-path-traversal
	return path.join(getAgentDir(), "prewalk.json");
}

function targetKey(target: { provider: string; id: string }): string {
	return `${target.provider}/${target.id}`;
}

function isBuiltinTool(pi: ExtensionAPI, toolName: string): boolean {
	return pi.getAllTools().find((tool) => tool.name === toolName)?.sourceInfo.source === "builtin";
}

function planningPrompt(run: PrewalkRun): string {
	if (run.phase === "checkpointed" || run.phase === "mutation-pending") {
		return [
			HIDDEN_GUIDANCE_SENTINEL,
			"Prewalk checkpoint accepted.",
			"Make exactly one built-in edit or write call now.",
			"Do not issue parallel mutations. Stop after that mutation result so the configured target can continue this live session.",
		].join("\n");
	}
	return [
		HIDDEN_GUIDANCE_SENTINEL,
		"You are in Prewalk planning mode. Continue the user's task in this same response and preserve the user's requested scope.",
		"Inspect enough of the repository to decide whether the task requires implementation and, when it does, produce a concrete implementation and verification checklist.",
		"If the user's task is read-only or no mutation is needed, finish normally without a checkpoint or edit.",
		`Only when implementation is required, call ${CHECKPOINT_TOOL} before any edit or write, exactly once with runId ${JSON.stringify(run.id)} and 5 to 9 trimmed, non-empty checklist items.`,
		"The checklist must name the remaining work in execution order, including exact files, symbols, commands, and checks where known.",
		"After that checkpoint succeeds, make exactly one built-in edit or write call. Do not issue parallel mutations.",
	].join("\n");
}

async function readConfig(): Promise<PrewalkConfig> {
	const filePath = configPath();
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(
				"Prewalk is not configured. Run /prewalk configure provider/model thinking.",
			);
		}
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error(`Prewalk config is not valid JSON: ${filePath}`);
	}
	return parseConfig(value);
}

async function writeConfig(config: PrewalkConfig): Promise<void> {
	const filePath = configPath();
	await mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await rename(temporaryPath, filePath);
}

function resolveConfiguredModel(
	ctx: ExtensionContext,
	configuredTarget: string,
): Model<Api> | undefined {
	const parsed = parseTarget(configuredTarget);
	return parsed ? ctx.modelRegistry.find(parsed.provider, parsed.id) : undefined;
}

function effectiveThinkingLevel(target: Model<Api>, requested: ThinkingLevel): ThinkingLevel {
	return clampThinkingLevel(target, requested) as ThinkingLevel;
}

function clearUi(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

function disarm(coordinator: PrewalkCoordinator, ctx: ExtensionContext): void {
	coordinator.disarm();
	clearUi(ctx);
}

async function ensureRecipientConsent(
	config: PrewalkConfig,
	planner: Model<Api>,
	target: Model<Api>,
	mode: RunMode,
	ctx: ExtensionContext,
): Promise<boolean> {
	const pair = recipientPair(ctx.modelRegistry, planner, target);
	if (pair === undefined) return true;
	if (pair === null) {
		ctx.ui.notify(
			"Prewalk cannot identify the exact registered stream implementation for this cross-provider handoff. Custom stream registrations must declare streamImplementationId.",
			"error",
		);
		return false;
	}
	if (config.crossProviderPairs.includes(pair)) return true;
	if (mode === "automatic") {
		ctx.ui.notify(
			`Prewalk needs explicit cross-provider acknowledgement for ${planner.provider} → ${target.provider}. Run /prewalk configure again or /prewalk run.`,
			"warning",
		);
		return false;
	}
	const confirmed = await ctx.ui.confirm(
		"Cross-provider handoff",
		`Allow ${targetKey(target)} to receive the provider-visible conversation accumulated with ${targetKey(planner)}? Consent is limited to these exact recipient endpoints and target.`,
	);
	if (!confirmed) return false;
	config.crossProviderPairs = [...new Set([...config.crossProviderPairs, pair])];
	await writeConfig(config);
	return true;
}

interface ReadinessResult {
	ready: boolean;
	target?: Model<Api>;
	reason?: string;
}

async function validateRunReadiness(
	run: PrewalkRun,
	ctx: ExtensionContext,
): Promise<ReadinessResult> {
	let config: PrewalkConfig;
	try {
		config = await readConfig();
	} catch (error) {
		return {
			ready: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
	const target = resolveConfiguredModel(ctx, config.target);
	if (!target || target.provider !== run.target.provider || target.id !== run.target.id) {
		return {
			ready: false,
			reason: "Prewalk target changed or is unavailable; cancel and re-arm after configuration.",
		};
	}
	if (effectiveThinkingLevel(target, config.thinkingLevel) !== run.thinkingLevel) {
		return {
			ready: false,
			reason: "Prewalk target thinking changed; cancel and re-arm after configuration.",
		};
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(target)) {
		return {
			ready: false,
			reason: `Prewalk has no complete configured authentication for ${targetKey(target)}.`,
		};
	}
	const planner = ctx.model;
	if (
		!planner ||
		recipientFingerprint(ctx.modelRegistry, planner) !== run.plannerRecipientFingerprint ||
		recipientFingerprint(ctx.modelRegistry, target) !== run.targetRecipientFingerprint ||
		(run.crossProviderPair !== undefined &&
			!config.crossProviderPairs.includes(run.crossProviderPair))
	) {
		return {
			ready: false,
			reason:
				"Prewalk recipient identity changed or lacks exact cross-provider consent; cancel and re-arm.",
		};
	}
	return { ready: true, target };
}

interface ArmOptions {
	pi: ExtensionAPI;
	coordinator: PrewalkCoordinator;
	config: PrewalkConfig;
	mode: RunMode;
	ctx: ExtensionContext;
}

async function arm({ pi, coordinator, config, mode, ctx }: ArmOptions): Promise<boolean> {
	if (coordinator.run) {
		if (mode === "manual" && coordinator.run.phase === "armed") {
			const run = coordinator.activateManual();
			ctx.ui.setStatus(STATUS_KEY, `Prewalk → ${run.target.name}`);
			ctx.ui.notify(
				`Prewalk planning with ${targetKey(run.target)} (${run.thinkingLevel}).`,
				"info",
			);
			return true;
		}
		ctx.ui.notify("Prewalk is already active. Use /prewalk cancel first.", "error");
		return false;
	}
	if (!ctx.isProjectTrusted()) {
		if (mode === "automatic") {
			ctx.ui.notify("Prewalk did not arm because this project is not trusted.", "warning");
			return false;
		}
		const confirmed = await ctx.ui.confirm(
			"Untrusted project",
			"Prewalk will allow one edit or write after its checkpoint. Arm it for this run?",
		);
		if (!confirmed) return false;
	}
	if (!pi.getActiveTools().includes(CHECKPOINT_TOOL)) {
		ctx.ui.notify(`Prewalk requires the active ${CHECKPOINT_TOOL} tool.`, "error");
		return false;
	}
	const target = resolveConfiguredModel(ctx, config.target);
	if (!target) {
		ctx.ui.notify(`Configured Prewalk target is unavailable: ${config.target}.`, "error");
		return false;
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(target)) {
		ctx.ui.notify(`No complete configured authentication for ${targetKey(target)}.`, "error");
		return false;
	}
	const planner = ctx.model;
	if (!planner) {
		ctx.ui.notify("Prewalk requires an active planner model.", "error");
		return false;
	}
	if (!(await ensureRecipientConsent(config, planner, target, mode, ctx))) return false;
	const plannerRecipientFingerprint = recipientFingerprint(ctx.modelRegistry, planner);
	const targetRecipientFingerprint = recipientFingerprint(ctx.modelRegistry, target);
	if (!plannerRecipientFingerprint || !targetRecipientFingerprint) {
		ctx.ui.notify("Prewalk could not determine recipient identity.", "error");
		return false;
	}
	const thinkingLevel = effectiveThinkingLevel(target, config.thinkingLevel);
	if (
		planner.provider === target.provider &&
		planner.id === target.id &&
		(pi.getThinkingLevel() as ThinkingLevel) === thinkingLevel
	) {
		ctx.ui.notify(
			`Prewalk target ${targetKey(target)} (${thinkingLevel}) is already active.`,
			"info",
		);
		return false;
	}
	const run = coordinator.arm({
		id: randomUUID(),
		mode,
		target: {
			provider: target.provider,
			id: target.id,
			name: target.name || target.id,
		},
		thinkingLevel,
		plannerRecipientFingerprint,
		targetRecipientFingerprint,
		crossProviderPair: recipientPair(ctx.modelRegistry, planner, target) ?? undefined,
	});
	ctx.ui.setStatus(STATUS_KEY, `Prewalk → ${run.target.name}`);
	ctx.ui.notify(
		mode === "automatic"
			? `Prewalk armed for ${targetKey(run.target)} (${thinkingLevel}); no model request was added.`
			: `Prewalk planning with ${targetKey(run.target)} (${thinkingLevel}).`,
		"info",
	);
	return true;
}

function configSummary(config: PrewalkConfig): string {
	return `${config.enabled ? "enabled" : "disabled"}; target ${config.target} (${config.thinkingLevel})`;
}

async function configure(raw: string[], ctx: ExtensionCommandContext): Promise<void> {
	const [targetName, rawThinking, optionalFlag, ...extra] = raw;
	const requestedThinking = parseThinkingLevel(rawThinking);
	const parsedTarget = targetName ? parseTarget(targetName) : undefined;
	if (
		!targetName ||
		!parsedTarget ||
		!requestedThinking ||
		extra.length > 0 ||
		(optionalFlag && optionalFlag !== "--allow-cross-provider")
	) {
		ctx.ui.notify(
			"Usage: /prewalk configure provider/model thinking [--allow-cross-provider]",
			"error",
		);
		return;
	}
	const target = ctx.modelRegistry.find(parsedTarget.provider, parsedTarget.id);
	if (!target) {
		ctx.ui.notify(`Configured Prewalk target is unavailable: ${targetName}.`, "error");
		return;
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(target)) {
		ctx.ui.notify(`No complete configured authentication for ${targetKey(target)}.`, "error");
		return;
	}
	const thinkingLevel = effectiveThinkingLevel(target, requestedThinking);
	const config: PrewalkConfig = {
		enabled: true,
		target: targetName,
		thinkingLevel,
		crossProviderPairs: [],
	};
	const planner = ctx.model;
	const pair = planner ? recipientPair(ctx.modelRegistry, planner, target) : undefined;
	if (pair === null) {
		ctx.ui.notify(
			"Cross-provider configuration requires stable streamImplementationId values for custom stream registrations.",
			"error",
		);
		return;
	}
	if (planner && pair) {
		if (optionalFlag !== "--allow-cross-provider") {
			ctx.ui.notify(
				"Cross-provider configuration requires --allow-cross-provider and explicit confirmation.",
				"error",
			);
			return;
		}
		if (!(await ensureRecipientConsent(config, planner, target, "manual", ctx))) return;
	} else {
		await writeConfig(config);
	}
	const clampNote =
		thinkingLevel === requestedThinking
			? ""
			: `; ${requestedThinking} clamped to ${thinkingLevel}`;
	ctx.ui.notify(
		`Prewalk configured and enabled: ${targetName} (${thinkingLevel})${clampNote}.`,
		"info",
	);
}

async function handleCommand(
	pi: ExtensionAPI,
	coordinator: PrewalkCoordinator,
	rawArgs: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const args = rawArgs.trim().split(/\s+/).filter(Boolean);
	const action = args[0] ?? "run";
	if (action === "status") {
		try {
			const config = await readConfig();
			const live = coordinator.run
				? `${coordinator.run.phase}; run ${coordinator.run.id}`
				: "idle";
			ctx.ui.notify(`Prewalk ${configSummary(config)}; ${live}.`, "info");
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
		return;
	}
	if (action === "cancel") {
		disarm(coordinator, ctx);
		ctx.ui.notify("Prewalk cancelled.", "info");
		return;
	}
	if (action === "configure") {
		await configure(args.slice(1), ctx);
		return;
	}
	if (action === "enable" || action === "disable") {
		try {
			const config = await readConfig();
			config.enabled = action === "enable";
			await writeConfig(config);
			ctx.ui.notify(
				`Prewalk automatic mode ${config.enabled ? "enabled" : "disabled"}.`,
				"info",
			);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
		return;
	}
	if (action !== "run" || args.length > (args[0] === "run" ? 1 : 0)) {
		ctx.ui.notify("Usage: /prewalk [run|status|cancel|enable|disable|configure ...]", "error");
		return;
	}
	try {
		await arm({
			pi,
			coordinator,
			config: await readConfig(),
			mode: "manual",
			ctx,
		});
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export default function prewalkExtension(pi: ExtensionAPI): void {
	const coordinator = new PrewalkCoordinator();

	pi.registerTool<typeof CheckpointParameters, CheckpointDetails>({
		name: CHECKPOINT_TOOL,
		label: "Prewalk checkpoint",
		description:
			"Record the current Prewalk run's 5-9 item implementation and verification checklist",
		parameters: CheckpointParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const run = coordinator.run;
			const items = run ? validateCheckpoint(run, params) : undefined;
			if (!run || run.phase !== "planning" || !items) {
				throw new Error("Prewalk checkpoint rejected: no matching bounded planning run.");
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `Prewalk checkpoint accepted. Handoff checklist:\n${items.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
					},
				],
				details: { accepted: true, runId: run.id, itemCount: items.length },
			};
		},
	});

	pi.registerCommand("prewalk", {
		description:
			"Plan with the current model, then continue this live session with the configured target",
		handler: (args, ctx) => handleCommand(pi, coordinator, args, ctx),
	});

	pi.on("context", (event) => {
		const run = coordinator.run;
		if (!run?.projectionActive) return;
		return {
			messages: [
				...event.messages,
				{
					role: "user",
					content: planningPrompt(run),
					timestamp: Date.now(),
				} satisfies AgentMessage,
			],
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!MUTATION_TOOLS.has(event.toolName) || !isBuiltinTool(pi, event.toolName)) return;
		const needsReadiness = coordinator.run?.phase === "checkpointed";
		const readiness =
			needsReadiness && coordinator.run
				? await validateRunReadiness(coordinator.run, ctx)
				: { ready: false };
		const action = coordinator.onToolCall(event.toolName, event.toolCallId, readiness.ready);
		if (!action.block) return;
		return {
			block: true,
			reason: needsReadiness && readiness.reason ? readiness.reason : action.reason,
		};
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName === CHECKPOINT_TOOL) {
			if (coordinator.onCheckpointResult(event.input, event.isError)) {
				ctx.ui.notify("Prewalk checkpoint accepted; one edit or write may proceed.", "info");
			}
			return;
		}
		if (
			(EXPLORATION_TOOLS.has(event.toolName) || MUTATION_TOOLS.has(event.toolName)) &&
			!isBuiltinTool(pi, event.toolName)
		)
			return;
		const action = coordinator.onToolResult(
			event.toolName,
			event.toolCallId,
			event.isError ? "error" : "success",
		);
		if (action.type === "activated") {
			ctx.ui.setStatus(
				STATUS_KEY,
				`Prewalk planning → ${coordinator.run?.target.name ?? "target"}`,
			);
		} else if (action.type === "handoff-pending") {
			ctx.ui.setStatus(STATUS_KEY, `Prewalk switching → ${action.run.target.name}`);
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		const action = coordinator.onTurnEnd();
		if (action.type !== "handoff") return;
		try {
			const readiness = await validateRunReadiness(action.run, ctx);
			if (!readiness.ready || !readiness.target) {
				throw new Error(readiness.reason ?? "Prewalk target is no longer ready.");
			}
			await pi.setSessionModelAndThinkingLevel(readiness.target, action.run.thinkingLevel);
			ctx.ui.notify(
				`Prewalk handoff complete → ${targetKey(action.run.target)} (${action.run.thinkingLevel}).`,
				"info",
			);
		} catch (error) {
			ctx.ui.notify(
				`Prewalk handoff failed after the mutation: ${error instanceof Error ? error.message : String(error)} Reconfigure credentials and run Prewalk again; this handoff will not retry.`,
				"error",
			);
		} finally {
			disarm(coordinator, ctx);
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		const action = coordinator.onAgentSettled();
		if (action.type === "disarmed") {
			clearUi(ctx);
			ctx.ui.notify(action.reason, "info");
		}
	});

	pi.on("session_start", async (event, ctx) => {
		disarm(coordinator, ctx);
		if (event.reason !== "startup" && event.reason !== "new") return;
		try {
			const config = await readConfig();
			if (config.enabled) await arm({ pi, coordinator, config, mode: "automatic", ctx });
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		}
	});

	pi.on("session_before_switch", (_event, ctx) => disarm(coordinator, ctx));
	pi.on("session_before_fork", (_event, ctx) => disarm(coordinator, ctx));
	pi.on("session_before_compact", (_event, ctx) => disarm(coordinator, ctx));
	pi.on("session_tree", (_event, ctx) => disarm(coordinator, ctx));
	pi.on("session_shutdown", (_event, ctx) => disarm(coordinator, ctx));
}
