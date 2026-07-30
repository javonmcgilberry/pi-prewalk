import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRegistry, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
	EXECUTOR_MODEL_ID,
	EXECUTOR_PROVIDER,
	EXECUTOR_THINKING_LEVEL,
	PLANNER_MODEL_ID,
	PLANNER_PROVIDER,
} from "./core.js";

type StreamSimple = NonNullable<ProviderConfig["streamSimple"]>;
type ResolvedExecutorAuth = {
	ok: true;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
};

export interface ProviderOverlayState {
	shouldRouteToLuna(): boolean;
	isPrimaryAgentStream(): boolean;
	currentRunId(): string | undefined;
	onLunaStreamStarted(runId: string): void;
	onLunaStreamSucceeded(runId: string): void;
	onLunaStreamFailed(runId: string): void;
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
	onSucceeded: () => void,
	onFailed: () => void,
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
					terminal = true;
					forwarded.push(event);
					onSucceeded();
				} else if (event.type === "error") {
					terminal = true;
					onFailed();
					const error = failedAssistantMessage(executor);
					if (!started) forwarded.push({ type: "start", partial: error });
					forwarded.push({ type: "error", reason: "error", error });
				} else {
					forwarded.push(event);
				}
			}
			if (!terminal) throw new Error("Luna provider stream ended without a terminal event.");
		} catch {
			if (terminal) return;
			onFailed();
			const error = failedAssistantMessage(executor);
			if (!started) forwarded.push({ type: "start", partial: error });
			forwarded.push({ type: "error", reason: "error", error });
		}
	})();
	return forwarded;
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
		errorMessage: "Prewalk Luna provider stream failed.",
		timestamp: Date.now(),
	};
}

function executorOptions(
	options: SimpleStreamOptions | undefined,
	auth: ResolvedExecutorAuth,
): SimpleStreamOptions {
	return {
		...options,
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
		reasoning: EXECUTOR_THINKING_LEVEL,
	};
}

export function createProviderOverlay(
	pi: ProviderOverlayAPI,
	modelRegistry: Pick<
		ModelRegistry,
		"find" | "getApiKeyAndHeaders" | "getRegisteredProviderConfig"
	>,
	state: ProviderOverlayState,
): ProviderOverlay {
	let previous: ProviderConfig | undefined;
	let overlayStream: StreamSimple | undefined;

	const install = (): void => {
		if (overlayStream) return;

		const planner = modelRegistry.find(PLANNER_PROVIDER, PLANNER_MODEL_ID);
		const executor = modelRegistry.find(EXECUTOR_PROVIDER, EXECUTOR_MODEL_ID);
		if (!planner) throw new Error("Prewalk requires the configured Sol planner model.");
		if (!executor) throw new Error("Prewalk requires the configured Luna executor model.");
		if (planner.api !== executor.api) {
			throw new Error("Prewalk requires Sol and Luna to use the same Pi API.");
		}

		previous = modelRegistry.getRegisteredProviderConfig(PLANNER_PROVIDER);
		const delegate = previous?.streamSimple;
		if (!delegate || previous?.api !== "openai-codex-responses" || !previous.oauth) {
			throw new Error(
				"Prewalk requires the conversion-owned openai-codex provider to load first.",
			);
		}

		const stream: StreamSimple = (
			model: Model<Api>,
			context: Context,
			options?: SimpleStreamOptions,
		) => {
			const current = modelRegistry.getRegisteredProviderConfig(PLANNER_PROVIDER);
			if (current?.streamSimple !== stream) {
				state.onProviderDrift();
				throw new Error("Prewalk provider overlay ownership changed during the session.");
			}

			if (
				model.provider !== PLANNER_PROVIDER ||
				model.id !== PLANNER_MODEL_ID ||
				!state.shouldRouteToLuna() ||
				!state.isPrimaryAgentStream()
			) {
				return delegate(model, context, options);
			}

			const runId = state.currentRunId();
			if (!runId) return delegate(model, context, options);
			return forwardStream(
				(async () => {
					const auth = await modelRegistry.getApiKeyAndHeaders(executor);
					if (!auth.ok) throw new Error("Luna authorization is unavailable.");
					const delegated = delegate(executor, context, executorOptions(options, auth));
					state.onLunaStreamStarted(runId);
					return delegated;
				})(),
				executor,
				() => state.onLunaStreamSucceeded(runId),
				() => state.onLunaStreamFailed(runId),
			);
		};

		overlayStream = stream;
		pi.registerProvider(PLANNER_PROVIDER, {
			...previous,
			streamSimple: stream,
		});
	};

	const restore = (): void => {
		const stream = overlayStream;
		if (!stream) return;
		const current = modelRegistry.getRegisteredProviderConfig(PLANNER_PROVIDER);
		if (current?.streamSimple !== stream) {
			overlayStream = undefined;
			previous = undefined;
			return;
		}

		pi.unregisterProvider(PLANNER_PROVIDER);
		if (previous) pi.registerProvider(PLANNER_PROVIDER, previous);
		overlayStream = undefined;
		previous = undefined;
	};

	return {
		install,
		restore,
		ownsRegistration: () =>
			overlayStream !== undefined &&
			modelRegistry.getRegisteredProviderConfig(PLANNER_PROVIDER)?.streamSimple ===
				overlayStream,
	};
}
