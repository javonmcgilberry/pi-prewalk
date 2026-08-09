import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	isContextOverflow,
	type Message,
	type Model,
	type ProviderEnv,
	type ProviderHeaders,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as builtinStreamSimple } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { ExecutorConfig, PlannerProfile } from "./core.js";
import { estimateExecutorRequestTokens, needsExecutorCompaction } from "./executor-context.js";

type StreamSimple = NonNullable<ProviderConfig["streamSimple"]>;
type ExecutorRouteConfig = Pick<ExecutorConfig, "provider" | "model" | "reasoning">;
type ResolvedExecutorAuth = {
	ok: true;
	apiKey?: string;
	headers?: ProviderHeaders;
	baseUrl?: string;
	env?: ProviderEnv;
};

class ProviderOverlayDriftError extends Error {}
class ProviderOverlayCancelledError extends Error {}

export interface ProviderOverlayState {
	shouldRouteToExecutor(): boolean;
	isPrimaryAgentStream(): boolean;
	currentRunId(): string | undefined;
	/** Effective Pi compaction reserve, when the host can provide it. */
	getExecutorCompactionReserveTokens?(): number | undefined;
	prepareExecutorContext(context: Context): Context;
	onExecutorStreamStarted(runId: string): void | Promise<void>;
	onExecutorStreamSucceeded(runId: string): void | Promise<void>;
	onExecutorStreamFailed(runId: string): void | Promise<void>;
	onExecutorContextPressure(runId: string, retry: boolean): void | Promise<void>;
	onProviderDrift(runId: string): void;
}

export interface ProviderOverlay {
	install(): void;
	restore(): void;
	ownsRegistration(): boolean;
}

interface ProviderOverlayAPI {
	registerProvider(name: string, config: ProviderConfig): void;
	unregisterProvider(name: string): void;
}

export function removeExactUserPrompt(context: Context, prompt: string): Context {
	const expected = prompt.trim();
	let changed = false;
	const messages: Message[] = [];
	for (const message of context.messages) {
		if (message.role !== "user") {
			messages.push(message);
			continue;
		}
		if (typeof message.content === "string") {
			if (message.content.trim() === expected) {
				changed = true;
				continue;
			}
			messages.push(message);
			continue;
		}
		const content = message.content.filter(
			(block) => block.type !== "text" || block.text.trim() !== expected,
		);
		if (content.length === 0) {
			changed = true;
			continue;
		}
		if (content.length !== message.content.length) {
			changed = true;
			messages.push({ ...message, content });
			continue;
		}
		messages.push(message);
	}
	return changed ? { ...context, messages } : context;
}

function forwardStream(
	source: Promise<{ stream: AssistantMessageEventStream; executor: Model<Api> }>,
	executor: Model<Api>,
	onStarted: () => void | Promise<void>,
	onSucceeded: () => void | Promise<void>,
	onFailed: () => void | Promise<void>,
	onContextPressure: (retry: boolean) => void | Promise<void>,
	isCurrent: () => boolean,
): AssistantMessageEventStream {
	const forwarded = createAssistantMessageEventStream();
	void (async () => {
		let started = false;
		let terminal = false;
		let activeExecutor = executor;
		try {
			const resolved = await source;
			activeExecutor = resolved.executor;
			for await (const event of resolved.stream) {
				if (!isCurrent()) {
					forwarded.end(abortedAssistantMessage(activeExecutor));
					return;
				}
				if (event.type === "start") {
					if (!started) {
						started = true;
						await settleCallback(onStarted);
						if (!isCurrent()) {
							forwarded.end(abortedAssistantMessage(activeExecutor));
							return;
						}
					}
					forwarded.push(event);
				} else if (event.type === "done") {
					if (!started && !isContextOverflow(event.message, activeExecutor.contextWindow)) {
						await settleCallback(onFailed);
						if (!isCurrent()) {
							forwarded.end(abortedAssistantMessage(activeExecutor));
							return;
						}
						terminal = true;
						const error = failedAssistantMessage(activeExecutor);
						forwarded.push({ type: "start", partial: error });
						forwarded.push({ type: "error", reason: "error", error });
					} else if (isContextOverflow(event.message, activeExecutor.contextWindow)) {
						const retry = event.message.stopReason !== "stop";
						await settleCallback(() => onContextPressure(retry));
						if (!isCurrent()) {
							forwarded.end(abortedAssistantMessage(activeExecutor));
							return;
						}
						terminal = true;
						if (retry) {
							const error = executorContextPressureMessage(activeExecutor);
							if (!started) forwarded.push({ type: "start", partial: error });
							forwarded.push({ type: "error", reason: "error", error });
						} else {
							await settleCallback(onSucceeded);
							if (!isCurrent()) {
								forwarded.end(abortedAssistantMessage(activeExecutor));
								return;
							}
							forwarded.push(event);
						}
					} else {
						await settleCallback(onSucceeded);
						terminal = true;
						if (!isCurrent()) {
							forwarded.end(abortedAssistantMessage(activeExecutor));
							return;
						}
						forwarded.push(event);
					}
				} else if (event.type === "error") {
					if (isContextOverflow(event.error, activeExecutor.contextWindow)) {
						await settleCallback(() => onContextPressure(true));
						if (!isCurrent()) {
							forwarded.end(abortedAssistantMessage(activeExecutor));
							return;
						}
						terminal = true;
						const error = executorContextPressureMessage(activeExecutor);
						if (!started) forwarded.push({ type: "start", partial: error });
						forwarded.push({ type: "error", reason: "error", error });
					} else {
						await settleCallback(onFailed);
						terminal = true;
						if (!isCurrent()) {
							forwarded.end(abortedAssistantMessage(activeExecutor));
							return;
						}
						const error = event.error;
						if (!started) forwarded.push({ type: "start", partial: error });
						forwarded.push({ type: "error", reason: "error", error });
					}
				} else {
					forwarded.push(event);
				}
			}
			if (!terminal) throw new Error("Executor provider stream ended without a terminal event.");
		} catch (error) {
			if (terminal) return;
			if (
				error instanceof ProviderOverlayCancelledError ||
				(!isCurrent() && !(error instanceof ProviderOverlayDriftError))
			) {
				forwarded.end(abortedAssistantMessage(activeExecutor));
				return;
			}
			await settleCallback(onFailed);
			const failure = failedAssistantMessage(activeExecutor);
			if (!started) forwarded.push({ type: "start", partial: failure });
			forwarded.push({ type: "error", reason: "error", error: failure });
		}
	})();
	return forwarded;
}

async function settleCallback(callback: () => void | Promise<void>): Promise<void> {
	try {
		await callback();
	} catch {
		// Routing results remain authoritative when an observational callback fails.
	}
}

function failedAssistantMessage(executor: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: executor.api,
		provider: executor.provider,
		model: executor.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "Prewalk executor provider stream failed.",
		timestamp: Date.now(),
	};
}

function abortedAssistantMessage(executor: Model<Api>): AssistantMessage {
	return {
		...failedAssistantMessage(executor),
		stopReason: "aborted",
		errorMessage: "Prewalk executor provider stream was cancelled.",
	};
}

function executorContextPressureMessage(executor: Model<Api>): AssistantMessage {
	return {
		...failedAssistantMessage(executor),
		errorMessage: "Prewalk executor context requires compaction.",
	};
}

function contextPressureStream(
	executor: Model<Api>,
	onPressure: () => void | Promise<void>,
	isCurrent: () => boolean,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		await settleCallback(onPressure);
		if (!isCurrent()) {
			stream.end(abortedAssistantMessage(executor));
			return;
		}
		const error = executorContextPressureMessage(executor);
		stream.push({ type: "start", partial: error });
		stream.push({ type: "error", reason: "error", error });
		stream.end();
	})();
	return stream;
}

function executorOptions(
	options: SimpleStreamOptions | undefined,
	auth: ResolvedExecutorAuth,
	executor: ExecutorRouteConfig,
	requestApiKey: string | undefined,
): SimpleStreamOptions {
	const headers = mergeHeaders(auth.headers, options?.headers);
	const env =
		auth.env || options?.env ? { ...(auth.env ?? {}), ...(options?.env ?? {}) } : undefined;
	return {
		...options,
		apiKey: requestApiKey ?? auth.apiKey,
		headers,
		env,
		reasoning: executor.reasoning,
	};
}

async function resolveRequestApiKey(
	options: SimpleStreamOptions | undefined,
	planner: Model<Api>,
	executor: Model<Api>,
	modelRegistry: Pick<ModelRegistry, "getApiKeyAndHeaders" | "getRegisteredProviderConfig">,
): Promise<string | undefined> {
	const requestApiKey = options?.apiKey;
	if (requestApiKey === undefined || planner.provider === executor.provider) return requestApiKey;

	// Agent-loop auth is flattened into the same `apiKey` field as a caller's
	// request override. Before crossing providers, identify the planner key from
	// the live registration or auth resolver so it cannot become executor auth.
	const registeredPlanner = modelRegistry.getRegisteredProviderConfig(planner.provider);
	if (registeredPlanner?.apiKey === requestApiKey) return undefined;
	const plannerAuth = await modelRegistry.getApiKeyAndHeaders(planner);
	if (plannerAuth.ok && plannerAuth.apiKey === requestApiKey) return undefined;
	return requestApiKey;
}

function mergeHeaders(base: ProviderHeaders | undefined, override: ProviderHeaders | undefined) {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

export function createProviderOverlay(
	pi: ProviderOverlayAPI,
	modelRegistry: Pick<
		ModelRegistry,
		"find" | "getApiKeyAndHeaders" | "getRegisteredProviderConfig"
	>,
	plannerProfile: PlannerProfile,
	executorConfig: ExecutorRouteConfig,
	state: ProviderOverlayState,
): ProviderOverlay {
	let previous: ProviderConfig | undefined;
	let overlayStream: StreamSimple | undefined;
	let installedConfig: ProviderConfig | undefined;

	const install = (): void => {
		if (overlayStream) return;
		const installedRunId = state.currentRunId();
		if (!installedRunId) throw new Error("Prewalk requires an active run.");

		const planner = modelRegistry.find(plannerProfile.provider, plannerProfile.model);
		const executor = modelRegistry.find(executorConfig.provider, executorConfig.model);
		if (!planner) throw new Error("Prewalk requires the configured planner model.");
		if (!executor) throw new Error("Prewalk requires the configured executor model.");

		previous = modelRegistry.getRegisteredProviderConfig(plannerProfile.provider);
		const delegate = previous?.streamSimple ?? builtinStreamSimple;
		// The executor rides its own provider transport. Reusing the planner's
		// stream would hand an executor model to the wrong provider's wire format
		// and credentials, so a cross-provider pair cannot share one delegate.
		//
		// Both the executor model and its transport are resolved per request rather
		// than captured here. Pi applies provider registration immediately, so a
		// provider replaced, unregistered, or refreshed mid-run would otherwise
		// leave this overlay calling a transport Pi has already discarded.
		//
		// A same-provider executor deliberately reuses the pre-overlay delegate
		// instead of the live registration, because that live registration is this
		// overlay and reading it would re-enter the overlay on every request.
		const resolveExecutor = ():
			| { ok: true; model: Model<Api>; delegate: StreamSimple }
			| { ok: false } => {
			const current = modelRegistry.find(executorConfig.provider, executorConfig.model);
			if (!current) return { ok: false };
			if (current.provider === plannerProfile.provider) {
				return { ok: true, model: current, delegate };
			}
			return {
				ok: true,
				model: current,
				delegate:
					modelRegistry.getRegisteredProviderConfig(current.provider)?.streamSimple ??
					builtinStreamSimple,
			};
		};

		const stream: StreamSimple = (
			model: Model<Api>,
			context: Context,
			options?: SimpleStreamOptions,
		) => {
			const current = modelRegistry.getRegisteredProviderConfig(plannerProfile.provider);
			if (current?.streamSimple !== stream) {
				state.onProviderDrift(installedRunId);
				throw new Error("Prewalk provider overlay ownership changed during the session.");
			}

			if (
				model.provider !== plannerProfile.provider ||
				model.id !== plannerProfile.model ||
				!state.shouldRouteToExecutor() ||
				!state.isPrimaryAgentStream()
			) {
				return delegate(model, context, options);
			}

			const runId = state.currentRunId();
			if (!runId || runId !== installedRunId) return delegate(model, context, options);
			const resolved = resolveExecutor();
			if (!resolved.ok) {
				// The executor disappeared from the registry mid-run. Treat it the same
				// way as losing the provider registration rather than silently serving
				// the request from the planner the user is no longer paying for.
				state.onProviderDrift(installedRunId);
				throw new Error("Prewalk executor model is no longer registered.");
			}
			const { model: executorModel } = resolved;
			const executorContext = state.prepareExecutorContext(context);
			const executorContextTokens = estimateExecutorRequestTokens(executorContext);
			if (
				needsExecutorCompaction(
					executorContextTokens,
					executorModel,
					state.getExecutorCompactionReserveTokens?.(),
				)
			) {
				return contextPressureStream(
					executorModel,
					() => state.onExecutorContextPressure(runId, true),
					() =>
						state.currentRunId() === runId &&
						modelRegistry.getRegisteredProviderConfig(plannerProfile.provider)
							?.streamSimple === stream,
				);
			}
			return forwardStream(
				(async () => {
					let target = executorModel;
					let auth = await modelRegistry.getApiKeyAndHeaders(target);
					if (!auth.ok) throw new Error("Executor authorization is unavailable.");
					for (let attempt = 0; attempt < 2; attempt++) {
						if (state.currentRunId() !== runId) {
							throw new ProviderOverlayCancelledError();
						}
						const currentPlanner = modelRegistry.getRegisteredProviderConfig(
							plannerProfile.provider,
						);
						if (currentPlanner?.streamSimple !== stream) {
							state.onProviderDrift(installedRunId);
							throw new ProviderOverlayDriftError(
								"Prewalk provider overlay ownership changed during the session.",
							);
						}
						const currentExecutor = resolveExecutor();
						if (!currentExecutor.ok) {
							state.onProviderDrift(installedRunId);
							throw new ProviderOverlayDriftError(
								"Prewalk executor model is no longer registered.",
							);
						}
						if (
							currentExecutor.model.provider === target.provider &&
							currentExecutor.model.id === target.id &&
							currentExecutor.model.api === target.api
						) {
							const requestApiKey = await resolveRequestApiKey(
								options,
								planner,
								currentExecutor.model,
								modelRegistry,
							);
							if (state.currentRunId() !== runId) {
								throw new ProviderOverlayCancelledError();
							}
							const plannerAfterAuth = modelRegistry.getRegisteredProviderConfig(
								plannerProfile.provider,
							);
							if (plannerAfterAuth?.streamSimple !== stream) {
								state.onProviderDrift(installedRunId);
								throw new ProviderOverlayDriftError(
									"Prewalk provider overlay ownership changed during the session.",
								);
							}
							const executorAfterAuth = resolveExecutor();
							if (!executorAfterAuth.ok) {
								state.onProviderDrift(installedRunId);
								throw new ProviderOverlayDriftError(
									"Prewalk executor model is no longer registered.",
								);
							}
							if (
								executorAfterAuth.model.provider !== target.provider ||
								executorAfterAuth.model.id !== target.id ||
								executorAfterAuth.model.api !== target.api
							) {
								target = executorAfterAuth.model;
								auth = await modelRegistry.getApiKeyAndHeaders(target);
								if (!auth.ok) throw new Error("Executor authorization is unavailable.");
								continue;
							}
							const requestModel = auth.baseUrl
								? { ...executorAfterAuth.model, baseUrl: auth.baseUrl }
								: executorAfterAuth.model;
							const delegated = executorAfterAuth.delegate(
								requestModel,
								executorContext,
								executorOptions(options, auth, executorConfig, requestApiKey),
							);
							return { stream: delegated, executor: requestModel };
						}
						target = currentExecutor.model;
						auth = await modelRegistry.getApiKeyAndHeaders(target);
						if (!auth.ok) throw new Error("Executor authorization is unavailable.");
					}
					state.onProviderDrift(installedRunId);
					throw new ProviderOverlayDriftError(
						"Prewalk executor transport changed during authorization.",
					);
				})(),
				executorModel,
				() => state.onExecutorStreamStarted(runId),
				() => state.onExecutorStreamSucceeded(runId),
				() => state.onExecutorStreamFailed(runId),
				(retry) => state.onExecutorContextPressure(runId, retry),
				() =>
					state.currentRunId() === runId &&
					modelRegistry.getRegisteredProviderConfig(plannerProfile.provider)?.streamSimple ===
						stream,
			);
		};

		overlayStream = stream;
		// Pi rejects a streamSimple registration that carries no api. A provider
		// with no prior custom configuration contributes none, which is the normal
		// case for a stock provider, so take it from the planner model that already
		// belongs to this provider.
		const registration = {
			...previous,
			api: previous?.api ?? planner.api,
			streamSimple: stream,
		};
		installedConfig = registration;
		pi.registerProvider(plannerProfile.provider, registration);
	};

	const restore = (): void => {
		const stream = overlayStream;
		if (!stream) return;
		const current = modelRegistry.getRegisteredProviderConfig(plannerProfile.provider);
		if (current?.streamSimple !== stream) {
			overlayStream = undefined;
			installedConfig = undefined;
			previous = undefined;
			return;
		}

		const registrationFields = (config: ProviderConfig): Map<string, unknown> =>
			new Map(Object.entries(config).filter(([key]) => key !== "streamSimple"));
		const currentRecord = registrationFields(current);
		const installedRecord = installedConfig ? registrationFields(installedConfig) : undefined;
		const changedOutsideStream =
			installedRecord !== undefined &&
			[...new Set([...currentRecord.keys(), ...installedRecord.keys()])].some(
				(key) => currentRecord.get(key) !== installedRecord.get(key),
			);
		const { streamSimple: _currentStream, ...currentWithoutStream } = current;
		const restored = changedOutsideStream
			? previous
				? {
						...currentWithoutStream,
						...(previous.streamSimple === undefined
							? {}
							: { streamSimple: previous.streamSimple }),
					}
				: currentWithoutStream
			: previous;
		pi.unregisterProvider(plannerProfile.provider);
		if (restored) pi.registerProvider(plannerProfile.provider, restored);
		overlayStream = undefined;
		installedConfig = undefined;
		previous = undefined;
	};

	return {
		install,
		restore,
		ownsRegistration: () =>
			overlayStream !== undefined &&
			modelRegistry.getRegisteredProviderConfig(plannerProfile.provider)?.streamSimple ===
				overlayStream,
	};
}
