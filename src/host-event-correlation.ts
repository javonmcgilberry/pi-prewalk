import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type HostRunIdentity = Readonly<{
	runId: string;
	epoch: string;
}>;

export type HostObservation =
	| { type: "before-agent" }
	| { type: "agent-start" }
	| { type: "agent-end"; messages: readonly AgentMessage[] }
	| { type: "agent-settled" }
	| { type: "message-start"; message: AgentMessage }
	| { type: "message"; message: AgentMessage }
	| { type: "tool-claim"; toolCallId: string }
	| { type: "tool"; toolCallId: string }
	| { type: "before-compaction" }
	| { type: "compaction" };

export type HostCorrelationEvidence =
	| "message-object"
	| "message-key"
	| "tool-id"
	| "pending-agent"
	| "agent-message"
	| "agent-order"
	| "active-agent"
	| "settlement-order"
	| "compaction-order"
	| "current-capture"
	| "discarded-compaction";

export type HostAttribution =
	| { kind: "exact"; run: HostRunIdentity; evidence: HostCorrelationEvidence }
	| { kind: "stale"; run: HostRunIdentity; evidence: HostCorrelationEvidence }
	| { kind: "unowned"; evidence: HostCorrelationEvidence }
	| { kind: "unknown"; fallback: "preserve-current" | "ignore-agent-end" }
	| { kind: "suppressed"; evidence: "discarded-compaction" };

export type HostCorrelation = Readonly<{
	decision: "apply" | "ignore";
	attribution: HostAttribution;
}>;

export type PendingRunDiscard = Readonly<{
	pendingAgentMarkersRemoved: number;
	pendingCompactionMarkersRemoved: number;
	compactionSuppression: "armed" | "unchanged";
}>;

type HostRunMarker = HostRunIdentity | null;

type KnownMarker = Readonly<{
	marker: HostRunMarker;
	evidence: HostCorrelationEvidence;
}>;

interface CorrelationState {
	readonly messageRunObjects: WeakMap<object, HostRunMarker>;
	readonly messageRunKeys: Map<string, HostRunMarker>;
	readonly toolRunIds: Map<string, HostRunMarker>;
	readonly pendingAgentMarkers: HostRunMarker[];
	readonly agentEndMarkers: HostRunMarker[];
	readonly settlementMarkers: HostRunMarker[];
	readonly compactionMarkers: HostRunMarker[];
	activeAgentMarker: HostRunMarker | undefined;
	suppressCompactionCycle: boolean;
}

const KEYED_RETENTION_LIMIT = 512;

function createState(): CorrelationState {
	return {
		messageRunObjects: new WeakMap(),
		messageRunKeys: new Map(),
		toolRunIds: new Map(),
		pendingAgentMarkers: [],
		agentEndMarkers: [],
		settlementMarkers: [],
		compactionMarkers: [],
		activeAgentMarker: undefined,
		suppressCompactionCycle: false,
	};
}

function sameIdentity(left: HostRunIdentity, right: HostRunIdentity): boolean {
	return left.runId === right.runId && left.epoch === right.epoch;
}

function sameMarker(left: HostRunMarker, right: HostRunMarker): boolean {
	return (
		(left === null && right === null) ||
		(left !== null && right !== null && sameIdentity(left, right))
	);
}

function currentMarker(currentRun: HostRunIdentity | undefined): HostRunMarker {
	return currentRun ?? null;
}

function messageKey(message: AgentMessage): string {
	return `${message.role}:${String(message.timestamp)}`;
}

function retainNewestKey<K, V>(map: Map<K, V>): void {
	if (map.size <= KEYED_RETENTION_LIMIT) return;
	const oldest = map.keys().next();
	if (!oldest.done) map.delete(oldest.value);
}

function removeAllExact(markers: HostRunMarker[], run: HostRunIdentity): number {
	let removed = 0;
	for (let index = markers.length - 1; index >= 0; index -= 1) {
		const marker = markers[index];
		if (marker !== null && marker !== undefined && sameIdentity(marker, run)) {
			markers.splice(index, 1);
			removed += 1;
		}
	}
	return removed;
}

function shiftMarker(
	markers: HostRunMarker[],
	evidence: HostCorrelationEvidence,
): KnownMarker | undefined {
	if (markers.length === 0) return undefined;
	const marker = markers.shift();
	return marker === undefined ? undefined : { marker, evidence };
}

function classify(
	marker: HostRunMarker,
	currentRun: HostRunIdentity | undefined,
	evidence: HostCorrelationEvidence,
): HostCorrelation {
	if (marker === null) {
		return {
			decision: currentRun === undefined ? "apply" : "ignore",
			attribution: { kind: "unowned", evidence },
		};
	}
	if (currentRun !== undefined && sameIdentity(marker, currentRun)) {
		return {
			decision: "apply",
			attribution: { kind: "exact", run: marker, evidence },
		};
	}
	return {
		decision: "ignore",
		attribution: { kind: "stale", run: marker, evidence },
	};
}

function permissiveUnknown(): HostCorrelation {
	return {
		decision: "apply",
		attribution: { kind: "unknown", fallback: "preserve-current" },
	};
}

function messageFact(state: CorrelationState, message: AgentMessage): KnownMarker | undefined {
	if (state.messageRunObjects.has(message)) {
		const marker = state.messageRunObjects.get(message);
		if (marker !== undefined) return { marker, evidence: "message-object" };
	}
	const key = messageKey(message);
	if (!state.messageRunKeys.has(key)) return undefined;
	const marker = state.messageRunKeys.get(key);
	return marker === undefined ? undefined : { marker, evidence: "message-key" };
}

function toolFact(state: CorrelationState, toolCallId: string): KnownMarker | undefined {
	if (!state.toolRunIds.has(toolCallId)) return undefined;
	const marker = state.toolRunIds.get(toolCallId);
	return marker === undefined ? undefined : { marker, evidence: "tool-id" };
}

function fallbackFact(state: CorrelationState): KnownMarker | undefined {
	if (state.activeAgentMarker !== undefined) {
		return { marker: state.activeAgentMarker, evidence: "active-agent" };
	}
	const settlement = state.settlementMarkers[0];
	return settlement === undefined
		? undefined
		: { marker: settlement, evidence: "settlement-order" };
}

function discardFirstExactAgentEnd(state: CorrelationState, marker: HostRunMarker): void {
	if (marker === null) return;
	const index = state.agentEndMarkers.findIndex(
		(queued) => queued !== null && sameIdentity(queued, marker),
	);
	if (index >= 0) state.agentEndMarkers.splice(index, 1);
}

function observeBeforeAgent(
	state: CorrelationState,
	currentRun: HostRunIdentity | undefined,
): HostCorrelation {
	const marker = currentMarker(currentRun);
	state.pendingAgentMarkers.push(marker);
	return classify(marker, currentRun, "current-capture");
}

function observeAgentStart(
	state: CorrelationState,
	currentRun: HostRunIdentity | undefined,
): HostCorrelation {
	const pending = shiftMarker(state.pendingAgentMarkers, "pending-agent");
	const marker = pending === undefined ? currentMarker(currentRun) : pending.marker;
	state.agentEndMarkers.push(marker);
	state.activeAgentMarker = marker;
	return classify(marker, currentRun, pending === undefined ? "current-capture" : "pending-agent");
}

function observeAgentEnd(
	state: CorrelationState,
	messages: readonly AgentMessage[],
	currentRun: HostRunIdentity | undefined,
): HostCorrelation {
	let selected: KnownMarker | undefined;
	for (const message of messages) {
		const direct = messageFact(state, message);
		if (direct !== undefined) {
			selected = { marker: direct.marker, evidence: "agent-message" };
			break;
		}
	}
	if (selected !== undefined) discardFirstExactAgentEnd(state, selected.marker);
	selected ??= shiftMarker(state.agentEndMarkers, "agent-order");
	if (selected === undefined) {
		return {
			decision: "ignore",
			attribution: { kind: "unknown", fallback: "ignore-agent-end" },
		};
	}
	state.settlementMarkers.push(selected.marker);
	return classify(selected.marker, currentRun, selected.evidence);
}

function observeAgentSettled(
	state: CorrelationState,
	currentRun: HostRunIdentity | undefined,
): HostCorrelation {
	const settlement = shiftMarker(state.settlementMarkers, "settlement-order");
	const active =
		settlement === undefined && state.activeAgentMarker !== undefined
			? { marker: state.activeAgentMarker, evidence: "active-agent" as const }
			: undefined;
	const selected = settlement ??
		active ?? {
			marker: currentMarker(currentRun),
			evidence: "current-capture" as const,
		};
	if (
		state.activeAgentMarker !== undefined &&
		sameMarker(state.activeAgentMarker, selected.marker)
	) {
		state.activeAgentMarker = undefined;
	}
	if (selected.marker !== null) {
		const removed = removeAllExact(state.compactionMarkers, selected.marker);
		if (removed > 0) state.suppressCompactionCycle = true;
	}
	return classify(selected.marker, currentRun, selected.evidence);
}

function observeMessageStart(
	state: CorrelationState,
	message: AgentMessage,
	currentRun: HostRunIdentity | undefined,
): HostCorrelation {
	const selected = messageFact(state, message) ??
		fallbackFact(state) ?? {
			marker: currentMarker(currentRun),
			evidence: "current-capture" as const,
		};
	state.messageRunObjects.set(message, selected.marker);
	state.messageRunKeys.set(messageKey(message), selected.marker);
	retainNewestKey(state.messageRunKeys);
	return classify(selected.marker, currentRun, selected.evidence);
}

function observeMessage(
	state: CorrelationState,
	message: AgentMessage,
	currentRun: HostRunIdentity | undefined,
): HostCorrelation {
	const selected = messageFact(state, message) ?? fallbackFact(state);
	return selected === undefined
		? permissiveUnknown()
		: classify(selected.marker, currentRun, selected.evidence);
}

function observeToolClaim(
	state: CorrelationState,
	toolCallId: string,
	currentRun: HostRunIdentity | undefined,
): HostCorrelation {
	const selected = toolFact(state, toolCallId) ??
		fallbackFact(state) ?? {
			marker: currentMarker(currentRun),
			evidence: "current-capture" as const,
		};
	state.toolRunIds.set(toolCallId, selected.marker);
	retainNewestKey(state.toolRunIds);
	return classify(selected.marker, currentRun, selected.evidence);
}

function observeTool(
	state: CorrelationState,
	toolCallId: string,
	currentRun: HostRunIdentity | undefined,
): HostCorrelation {
	const selected = toolFact(state, toolCallId) ?? fallbackFact(state);
	return selected === undefined
		? permissiveUnknown()
		: classify(selected.marker, currentRun, selected.evidence);
}

function observeBeforeCompaction(
	state: CorrelationState,
	currentRun: HostRunIdentity | undefined,
): HostCorrelation {
	state.suppressCompactionCycle = false;
	const marker = currentMarker(currentRun);
	if (marker !== null) state.compactionMarkers.push(marker);
	return classify(marker, currentRun, "current-capture");
}

function observeCompaction(
	state: CorrelationState,
	currentRun: HostRunIdentity | undefined,
): HostCorrelation {
	const queued = shiftMarker(state.compactionMarkers, "compaction-order");
	if (queued !== undefined) return classify(queued.marker, currentRun, queued.evidence);
	if (state.suppressCompactionCycle) {
		return {
			decision: "ignore",
			attribution: { kind: "suppressed", evidence: "discarded-compaction" },
		};
	}
	return permissiveUnknown();
}

function observeState(
	state: CorrelationState,
	observation: HostObservation,
	currentRun: HostRunIdentity | undefined,
): HostCorrelation {
	switch (observation.type) {
		case "before-agent":
			return observeBeforeAgent(state, currentRun);
		case "agent-start":
			return observeAgentStart(state, currentRun);
		case "agent-end":
			return observeAgentEnd(state, observation.messages, currentRun);
		case "agent-settled":
			return observeAgentSettled(state, currentRun);
		case "message-start":
			return observeMessageStart(state, observation.message, currentRun);
		case "message":
			return observeMessage(state, observation.message, currentRun);
		case "tool-claim":
			return observeToolClaim(state, observation.toolCallId, currentRun);
		case "tool":
			return observeTool(state, observation.toolCallId, currentRun);
		case "before-compaction":
			return observeBeforeCompaction(state, currentRun);
		case "compaction":
			return observeCompaction(state, currentRun);
		default:
			return assertNever(observation);
	}
}

function assertNever(observation: never): never {
	throw new Error(`Unsupported host observation: ${String(observation)}`);
}

function resetState(state: CorrelationState): void {
	state.messageRunKeys.clear();
	state.toolRunIds.clear();
	state.pendingAgentMarkers.length = 0;
	state.agentEndMarkers.length = 0;
	state.settlementMarkers.length = 0;
	state.compactionMarkers.length = 0;
	state.activeAgentMarker = undefined;
	state.suppressCompactionCycle = false;
}

function discardPending(state: CorrelationState, run: HostRunIdentity): PendingRunDiscard {
	const pendingAgentMarkersRemoved = removeAllExact(state.pendingAgentMarkers, run);
	const pendingCompactionMarkersRemoved = removeAllExact(state.compactionMarkers, run);
	if (pendingCompactionMarkersRemoved > 0) state.suppressCompactionCycle = true;
	return {
		pendingAgentMarkersRemoved,
		pendingCompactionMarkersRemoved,
		compactionSuppression: pendingCompactionMarkersRemoved > 0 ? "armed" : "unchanged",
	};
}

export class PiHostEventCorrelation {
	readonly #state = createState();

	resetSession(): void {
		resetState(this.#state);
	}

	discardPendingForRun(run: HostRunIdentity): PendingRunDiscard {
		return discardPending(this.#state, run);
	}

	observe(observation: HostObservation, currentRun: HostRunIdentity | undefined): HostCorrelation {
		return observeState(this.#state, observation, currentRun);
	}
}
