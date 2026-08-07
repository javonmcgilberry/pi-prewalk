import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type ProviderEnv,
	type ProviderHeaders,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as builtinStreamSimple } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { PlannerProfile, PrewalkConfig } from "./core.js";

type StreamSimple = NonNullable<ProviderConfig["streamSimple"]>;
type ResolvedExecutorAuth = {
	ok: true;
	apiKey?: string;
	headers?: ProviderHeaders;
	env?: ProviderEnv;
};

export interface ProviderOverlayState {
	shouldRouteToExecutor(): boolean;
	isPrimaryAgentStream(): boolean;
	currentRunId(): string | undefined;
	onExecutorStreamStarted(runId: string): void | Promise<void>;
	onExecutorStreamSucceeded(runId: string): void | Promise<void>;
	onExecutorStreamFailed(runId: string): void | Promise<void>;
	onProviderDrift(): void;
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

function forwardStream(
	source: Promise<AssistantMessageEventStream>,
	executor: Model<Api>,
	onSucceeded: () => void | Promise<void>,
	onFailed: () => void | Promise<void>,
): AssistantMessageEventStream {
	const forwarded = createAssistantMessageEventStream();
	void (async () => {
		let started = false;
		let terminal = false;
		try {
			for await (const event of await source) {
				if (event.type === "start") {
					started = true;
					forwarded.push(event);
				} else if (event.type === "done") {
					await settleCallback(onSucceeded);
					terminal = true;
					forwarded.push(event);
				} else if (event.type === "error") {
					await settleCallback(onFailed);
					terminal = true;
					const error = failedAssistantMessage(executor);
					if (!started) forwarded.push({ type: "start", partial: error });
					forwarded.push({ type: "error", reason: "error", error });
				} else {
					forwarded.push(event);
				}
			}
			if (!terminal) throw new Error("Executor provider stream ended without a terminal event.");
		} catch {
			if (terminal) return;
			await settleCallback(onFailed);
			const error = failedAssistantMessage(executor);
			if (!started) forwarded.push({ type: "start", partial: error });
			forwarded.push({ type: "error", reason: "error", error });
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

function executorOptions(
	options: SimpleStreamOptions | undefined,
	auth: ResolvedExecutorAuth,
	config: PrewalkConfig,
): SimpleStreamOptions {
	return {
		...options,
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
		reasoning: config.executor.reasoning,
	};
}

export function createProviderOverlay(
	pi: ProviderOverlayAPI,
	modelRegistry: Pick<
		ModelRegistry,
		"find" | "getApiKeyAndHeaders" | "getRegisteredProviderConfig"
	>,
	plannerProfile: PlannerProfile,
	config: PrewalkConfig,
	state: ProviderOverlayState,
): ProviderOverlay {
	let previous: ProviderConfig | undefined;
	let overlayStream: StreamSimple | undefined;

	const install = (): void => {
		if (overlayStream) return;

		const planner = modelRegistry.find(plannerProfile.provider, plannerProfile.model);
		const executor = modelRegistry.find(config.executor.provider, config.executor.model);
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
			const current = modelRegistry.find(config.executor.provider, config.executor.model);
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
				state.onProviderDrift();
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
			if (!runId) return delegate(model, context, options);
			const resolved = resolveExecutor();
			if (!resolved.ok) {
				// The executor disappeared from the registry mid-run. Treat it the same
				// way as losing the provider registration rather than silently serving
				// the request from the planner the user is no longer paying for.
				state.onProviderDrift();
				throw new Error("Prewalk executor model is no longer registered.");
			}
			const { model: executorModel, delegate: executorDelegate } = resolved;
			return forwardStream(
				(async () => {
					const auth = await modelRegistry.getApiKeyAndHeaders(executorModel);
					if (!auth.ok) throw new Error("Executor authorization is unavailable.");
					const delegated = executorDelegate(
						executorModel,
						context,
						executorOptions(options, auth, config),
					);
					await state.onExecutorStreamStarted(runId);
					return delegated;
				})(),
				executorModel,
				() => state.onExecutorStreamSucceeded(runId),
				() => state.onExecutorStreamFailed(runId),
			);
		};

		overlayStream = stream;
		pi.registerProvider(plannerProfile.provider, {
			...previous,
			streamSimple: stream,
		});
	};

	const restore = (): void => {
		const stream = overlayStream;
		if (!stream) return;
		const current = modelRegistry.getRegisteredProviderConfig(plannerProfile.provider);
		if (current?.streamSimple !== stream) {
			overlayStream = undefined;
			previous = undefined;
			return;
		}

		pi.unregisterProvider(plannerProfile.provider);
		if (previous) pi.registerProvider(plannerProfile.provider, previous);
		overlayStream = undefined;
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
