import { readFile } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
	type HostCorrelation,
	type HostCorrelationEvidence,
	type HostRunIdentity,
	PiHostEventCorrelation,
} from "../src/host-event-correlation.js";

const A: HostRunIdentity = { runId: "run-a", epoch: "epoch-a" };
const A_NEW_EPOCH: HostRunIdentity = { runId: "run-a", epoch: "epoch-b" };
const B_SAME_EPOCH: HostRunIdentity = { runId: "run-b", epoch: "epoch-a" };
const B: HostRunIdentity = { runId: "run-b", epoch: "epoch-b" };

function message(timestamp: number, role: "assistant" | "user" = "assistant"): AgentMessage {
	if (role === "user") return { role, content: [], timestamp };
	return {
		role,
		content: [],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function expectResult(
	result: HostCorrelation,
	expected: {
		decision: "apply" | "ignore";
		kind: HostCorrelation["attribution"]["kind"];
		evidence?: HostCorrelationEvidence;
		run?: HostRunIdentity;
		fallback?: "preserve-current" | "ignore-agent-end";
	},
): void {
	expect(result.decision).toBe(expected.decision);
	expect(result.attribution.kind).toBe(expected.kind);
	if (expected.evidence !== undefined && "evidence" in result.attribution) {
		expect(result.attribution.evidence).toBe(expected.evidence);
	}
	if (expected.run !== undefined && "run" in result.attribution) {
		expect(result.attribution.run).toEqual(expected.run);
	}
	if (expected.fallback !== undefined && "fallback" in result.attribution) {
		expect(result.attribution.fallback).toBe(expected.fallback);
	}
}

function expectDecisionConsistent(result: HostCorrelation): void {
	switch (result.attribution.kind) {
		case "exact":
			expect(result.decision).toBe("apply");
			break;
		case "stale":
		case "suppressed":
			expect(result.decision).toBe("ignore");
			break;
		case "unknown":
			expect(result.decision).toBe(
				result.attribution.fallback === "preserve-current" ? "apply" : "ignore",
			);
			break;
		case "unowned":
			expect(["apply", "ignore"]).toContain(result.decision);
			break;
	}
}

function leaveOneSettlement(correlation: PiHostEventCorrelation, run: HostRunIdentity): void {
	correlation.observe({ type: "before-agent" }, run);
	correlation.observe({ type: "agent-start" }, run);
	correlation.observe({ type: "before-agent" }, run);
	correlation.observe({ type: "agent-start" }, run);
	correlation.observe({ type: "agent-end", messages: [] }, run);
	correlation.observe({ type: "agent-end", messages: [] }, run);
	correlation.observe({ type: "agent-settled" }, run);
}

describe("PiHostEventCorrelation identity and outcome model", () => {
	it("compares both runId and epoch and distinguishes unowned from unknown", () => {
		const sameEpochChange = new PiHostEventCorrelation();
		sameEpochChange.observe({ type: "before-agent" }, A);
		expectResult(sameEpochChange.observe({ type: "agent-start" }, A_NEW_EPOCH), {
			decision: "ignore",
			kind: "stale",
			evidence: "pending-agent",
			run: A,
		});

		const sameIdChange = new PiHostEventCorrelation();
		sameIdChange.observe({ type: "before-agent" }, A);
		expectResult(sameIdChange.observe({ type: "agent-start" }, B_SAME_EPOCH), {
			decision: "ignore",
			kind: "stale",
			evidence: "pending-agent",
			run: A,
		});

		const exact = new PiHostEventCorrelation();
		expectResult(exact.observe({ type: "before-agent" }, A), {
			decision: "apply",
			kind: "exact",
			evidence: "current-capture",
			run: A,
		});
		expectResult(exact.observe({ type: "agent-start" }, A), {
			decision: "apply",
			kind: "exact",
			evidence: "pending-agent",
			run: A,
		});

		const unowned = new PiHostEventCorrelation();
		expectResult(unowned.observe({ type: "before-agent" }, undefined), {
			decision: "apply",
			kind: "unowned",
			evidence: "current-capture",
		});
		expectResult(unowned.observe({ type: "agent-start" }, B), {
			decision: "ignore",
			kind: "unowned",
			evidence: "pending-agent",
		});
		expectResult(new PiHostEventCorrelation().observe({ type: "tool", toolCallId: "T" }, B), {
			decision: "apply",
			kind: "unknown",
			fallback: "preserve-current",
		});
	});

	it("enforces the decision-kind pairs for all ten observation variants", () => {
		const cases: Array<{
			result: HostCorrelation;
			decision: "apply" | "ignore";
			kind: HostCorrelation["attribution"]["kind"];
		}> = [
			{
				result: new PiHostEventCorrelation().observe({ type: "before-agent" }, A),
				decision: "apply",
				kind: "exact",
			},
			{
				result: new PiHostEventCorrelation().observe({ type: "agent-start" }, undefined),
				decision: "apply",
				kind: "unowned",
			},
			{
				result: new PiHostEventCorrelation().observe({ type: "agent-end", messages: [] }, A),
				decision: "ignore",
				kind: "unknown",
			},
			{
				result: new PiHostEventCorrelation().observe({ type: "agent-settled" }, A),
				decision: "apply",
				kind: "exact",
			},
			{
				result: new PiHostEventCorrelation().observe(
					{ type: "message-start", message: message(1) },
					A,
				),
				decision: "apply",
				kind: "exact",
			},
			{
				result: new PiHostEventCorrelation().observe(
					{ type: "message", message: message(2) },
					A,
				),
				decision: "apply",
				kind: "unknown",
			},
			{
				result: new PiHostEventCorrelation().observe(
					{ type: "tool-claim", toolCallId: "T" },
					A,
				),
				decision: "apply",
				kind: "exact",
			},
			{
				result: new PiHostEventCorrelation().observe({ type: "tool", toolCallId: "T" }, A),
				decision: "apply",
				kind: "unknown",
			},
			{
				result: new PiHostEventCorrelation().observe({ type: "before-compaction" }, A),
				decision: "apply",
				kind: "exact",
			},
			{
				result: new PiHostEventCorrelation().observe({ type: "compaction" }, A),
				decision: "apply",
				kind: "unknown",
			},
		];
		for (const entry of cases) {
			expectResult(entry.result, { decision: entry.decision, kind: entry.kind });
			expectDecisionConsistent(entry.result);
		}
	});
});

describe("PiHostEventCorrelation agent ordering", () => {
	it("moves pending ownership through agent-end and settlement before current fallback", () => {
		const correlation = new PiHostEventCorrelation();
		correlation.observe({ type: "before-agent" }, A);
		expectResult(correlation.observe({ type: "agent-start" }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "pending-agent",
			run: A,
		});
		expectResult(correlation.observe({ type: "message", message: message(10) }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "active-agent",
			run: A,
		});
		expectResult(correlation.observe({ type: "agent-end", messages: [] }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "agent-order",
			run: A,
		});
		expectResult(correlation.observe({ type: "agent-settled" }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "settlement-order",
			run: A,
		});
		expectResult(correlation.observe({ type: "agent-settled" }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "current-capture",
			run: B,
		});
	});

	it("uses active ownership for agent-settled before falling back to current", () => {
		const correlation = new PiHostEventCorrelation();
		correlation.observe({ type: "agent-start" }, A);
		expectResult(correlation.observe({ type: "agent-settled" }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "active-agent",
			run: A,
		});
		expectResult(correlation.observe({ type: "agent-settled" }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "current-capture",
			run: B,
		});
	});

	it("uses the first directly known message and removes only one exact marker", () => {
		const correlation = new PiHostEventCorrelation();
		const messageA = message(20);
		const messageB = message(21);
		for (let index = 0; index < 2; index += 1) {
			correlation.observe({ type: "before-agent" }, A);
			correlation.observe({ type: "agent-start" }, A);
		}
		correlation.observe({ type: "message-start", message: messageA }, A);
		correlation.observe({ type: "before-agent" }, B);
		correlation.observe({ type: "agent-start" }, B);
		correlation.observe({ type: "message-start", message: messageB }, B);

		expectResult(
			correlation.observe(
				{ type: "agent-end", messages: [message(19), message(20), messageB] },
				B,
			),
			{
				decision: "ignore",
				kind: "stale",
				evidence: "agent-message",
				run: A,
			},
		);
		expectResult(correlation.observe({ type: "agent-end", messages: [] }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "agent-order",
			run: A,
		});
		expectResult(correlation.observe({ type: "agent-end", messages: [] }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "agent-order",
			run: B,
		});
		for (let index = 0; index < 2; index += 1) {
			expectResult(correlation.observe({ type: "agent-settled" }, B), {
				decision: "ignore",
				kind: "stale",
				evidence: "settlement-order",
				run: A,
			});
		}
		expectResult(correlation.observe({ type: "agent-settled" }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "settlement-order",
			run: B,
		});
	});

	it("does not clear replacement active ownership when stale settlement wins", () => {
		const correlation = new PiHostEventCorrelation();
		leaveOneSettlement(correlation, A);
		correlation.observe({ type: "agent-start" }, B);
		expectResult(correlation.observe({ type: "agent-settled" }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "settlement-order",
			run: A,
		});
		expectResult(correlation.observe({ type: "agent-settled" }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "active-agent",
			run: B,
		});
	});

	it("retains direct-unowned agent-end order and never turns settlement into unknown", () => {
		const correlation = new PiHostEventCorrelation();
		const unownedMessage = message(30);
		correlation.observe({ type: "before-agent" }, undefined);
		correlation.observe({ type: "agent-start" }, undefined);
		correlation.observe({ type: "message-start", message: unownedMessage }, undefined);
		expectResult(
			correlation.observe({ type: "agent-end", messages: [unownedMessage] }, undefined),
			{ decision: "apply", kind: "unowned", evidence: "agent-message" },
		);
		expectResult(correlation.observe({ type: "agent-end", messages: [] }, undefined), {
			decision: "apply",
			kind: "unowned",
			evidence: "agent-order",
		});
		for (let index = 0; index < 2; index += 1) {
			expectResult(correlation.observe({ type: "agent-settled" }, B), {
				decision: "ignore",
				kind: "unowned",
				evidence: "settlement-order",
			});
		}
		expectResult(correlation.observe({ type: "agent-settled" }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "current-capture",
			run: B,
		});
	});

	it("ignores an entirely unknown agent-end without appending settlement", () => {
		const correlation = new PiHostEventCorrelation();
		expectResult(correlation.observe({ type: "agent-end", messages: [message(40)] }, A), {
			decision: "ignore",
			kind: "unknown",
			fallback: "ignore-agent-end",
		});
		expectResult(correlation.observe({ type: "agent-settled" }, A), {
			decision: "apply",
			kind: "exact",
			evidence: "current-capture",
			run: A,
		});
	});
});

describe("PiHostEventCorrelation message facts", () => {
	it("selects object before key and always writes the selected marker into both facts", () => {
		const correlation = new PiHostEventCorrelation();
		const original = message(50);
		const clone = message(50);
		correlation.observe({ type: "message-start", message: original }, A);
		correlation.resetSession();
		correlation.observe({ type: "message-start", message: clone }, B);

		expectResult(correlation.observe({ type: "message", message: original }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "message-object",
			run: A,
		});
		expectResult(correlation.observe({ type: "message-start", message: original }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "message-object",
			run: A,
		});
		expectResult(correlation.observe({ type: "message", message: message(50) }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "message-key",
			run: A,
		});
	});

	it("includes message role in the compatibility key", () => {
		const correlation = new PiHostEventCorrelation();
		correlation.observe({ type: "message-start", message: message(55, "assistant") }, A);
		expectResult(correlation.observe({ type: "message", message: message(55, "user") }, B), {
			decision: "apply",
			kind: "unknown",
			fallback: "preserve-current",
		});
		expectResult(
			correlation.observe({ type: "message-start", message: message(55, "user") }, B),
			{
				decision: "apply",
				kind: "exact",
				evidence: "current-capture",
				run: B,
			},
		);
		expectResult(correlation.observe({ type: "message", message: message(55, "assistant") }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "message-key",
			run: A,
		});
	});

	it("selects key, active, settlement, then current and returns post-store attribution", () => {
		const keyed = new PiHostEventCorrelation();
		keyed.observe({ type: "message-start", message: message(60) }, A);
		expectResult(keyed.observe({ type: "message-start", message: message(60) }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "message-key",
			run: A,
		});

		const active = new PiHostEventCorrelation();
		active.observe({ type: "agent-start" }, A);
		const activeMessage = message(61);
		expectResult(active.observe({ type: "message-start", message: activeMessage }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "active-agent",
			run: A,
		});
		expectResult(active.observe({ type: "message", message: activeMessage }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "message-object",
			run: A,
		});

		const settlement = new PiHostEventCorrelation();
		leaveOneSettlement(settlement, A);
		expectResult(settlement.observe({ type: "message-start", message: message(62) }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "settlement-order",
			run: A,
		});

		const activeOverSettlement = new PiHostEventCorrelation();
		leaveOneSettlement(activeOverSettlement, A);
		activeOverSettlement.observe({ type: "agent-start" }, B);
		expectResult(
			activeOverSettlement.observe({ type: "message-start", message: message(65) }, B),
			{
				decision: "apply",
				kind: "exact",
				evidence: "active-agent",
				run: B,
			},
		);

		const current = new PiHostEventCorrelation();
		expectResult(current.observe({ type: "message-start", message: message(63) }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "current-capture",
			run: B,
		});
		expectResult(current.observe({ type: "message-start", message: message(64) }, undefined), {
			decision: "apply",
			kind: "unowned",
			evidence: "current-capture",
		});
	});

	it("does not store a query and distinguishes same-instance reset from a new instance", () => {
		const correlation = new PiHostEventCorrelation();
		const queried = message(70);
		expectResult(correlation.observe({ type: "message", message: queried }, A), {
			decision: "apply",
			kind: "unknown",
			fallback: "preserve-current",
		});
		expectResult(correlation.observe({ type: "message-start", message: queried }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "current-capture",
			run: B,
		});

		correlation.resetSession();
		expectResult(correlation.observe({ type: "message", message: queried }, A), {
			decision: "ignore",
			kind: "stale",
			evidence: "message-object",
			run: B,
		});
		expectResult(correlation.observe({ type: "message", message: message(70) }, A), {
			decision: "apply",
			kind: "unknown",
			fallback: "preserve-current",
		});
		expectResult(new PiHostEventCorrelation().observe({ type: "message", message: queried }, A), {
			decision: "apply",
			kind: "unknown",
			fallback: "preserve-current",
		});
	});

	it("retains 512 keys, evicts the oldest distinct key, and does not promote overwrite", () => {
		const correlation = new PiHostEventCorrelation();
		for (let index = 0; index < 512; index += 1) {
			correlation.observe({ type: "message-start", message: message(1_000 + index) }, A);
		}
		expectResult(correlation.observe({ type: "message", message: message(1_000) }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "message-key",
			run: A,
		});
		correlation.observe({ type: "message-start", message: message(1_000) }, B);
		correlation.observe({ type: "message-start", message: message(1_512) }, A);
		expectResult(correlation.observe({ type: "message", message: message(1_000) }, B), {
			decision: "apply",
			kind: "unknown",
			fallback: "preserve-current",
		});
		expectResult(correlation.observe({ type: "message", message: message(1_001) }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "message-key",
			run: A,
		});
	});

	it("retains and evicts explicit-unowned message keys", () => {
		const correlation = new PiHostEventCorrelation();
		for (let index = 0; index < 512; index += 1) {
			correlation.observe({ type: "message-start", message: message(2_000 + index) }, undefined);
		}
		expectResult(correlation.observe({ type: "message", message: message(2_000) }, B), {
			decision: "ignore",
			kind: "unowned",
			evidence: "message-key",
		});
		correlation.observe({ type: "message-start", message: message(2_512) }, undefined);
		expectResult(correlation.observe({ type: "message", message: message(2_000) }, B), {
			decision: "apply",
			kind: "unknown",
			fallback: "preserve-current",
		});
	});
});

describe("PiHostEventCorrelation tool facts", () => {
	it("always stores current ownership and never rebinds an existing ID", () => {
		const correlation = new PiHostEventCorrelation();
		expectResult(correlation.observe({ type: "tool-claim", toolCallId: "T" }, A), {
			decision: "apply",
			kind: "exact",
			evidence: "current-capture",
			run: A,
		});
		expectResult(correlation.observe({ type: "tool-claim", toolCallId: "T" }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "tool-id",
			run: A,
		});
		expectResult(correlation.observe({ type: "tool", toolCallId: "T" }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "tool-id",
			run: A,
		});
	});

	it("selects active, settlement, then current and keeps explicit-unowned", () => {
		const active = new PiHostEventCorrelation();
		active.observe({ type: "agent-start" }, A);
		expectResult(active.observe({ type: "tool-claim", toolCallId: "active" }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "active-agent",
			run: A,
		});

		const settlement = new PiHostEventCorrelation();
		leaveOneSettlement(settlement, A);
		expectResult(settlement.observe({ type: "tool-claim", toolCallId: "settled" }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "settlement-order",
			run: A,
		});

		const activeOverSettlement = new PiHostEventCorrelation();
		leaveOneSettlement(activeOverSettlement, A);
		activeOverSettlement.observe({ type: "agent-start" }, B);
		expectResult(
			activeOverSettlement.observe({ type: "tool-claim", toolCallId: "active-first" }, B),
			{
				decision: "apply",
				kind: "exact",
				evidence: "active-agent",
				run: B,
			},
		);

		const current = new PiHostEventCorrelation();
		expectResult(current.observe({ type: "tool-claim", toolCallId: "current" }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "current-capture",
			run: B,
		});
		expectResult(current.observe({ type: "tool-claim", toolCallId: "unowned" }, undefined), {
			decision: "apply",
			kind: "unowned",
			evidence: "current-capture",
		});
		expectResult(current.observe({ type: "tool", toolCallId: "unowned" }, B), {
			decision: "ignore",
			kind: "unowned",
			evidence: "tool-id",
		});
	});

	it("does not store result-before-claim queries", () => {
		const correlation = new PiHostEventCorrelation();
		expectResult(correlation.observe({ type: "tool", toolCallId: "T" }, A), {
			decision: "apply",
			kind: "unknown",
			fallback: "preserve-current",
		});
		expectResult(correlation.observe({ type: "tool-claim", toolCallId: "T" }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "current-capture",
			run: B,
		});
		expectResult(correlation.observe({ type: "tool", toolCallId: "T" }, A), {
			decision: "ignore",
			kind: "stale",
			evidence: "tool-id",
			run: B,
		});
	});

	it("retains 512 IDs, evicts the oldest distinct ID, and does not promote duplicate claim", () => {
		const correlation = new PiHostEventCorrelation();
		for (let index = 0; index < 512; index += 1) {
			correlation.observe({ type: "tool-claim", toolCallId: `T-${index}` }, A);
		}
		correlation.observe({ type: "tool-claim", toolCallId: "T-0" }, B);
		correlation.observe({ type: "tool-claim", toolCallId: "T-512" }, A);
		expectResult(correlation.observe({ type: "tool", toolCallId: "T-0" }, B), {
			decision: "apply",
			kind: "unknown",
			fallback: "preserve-current",
		});
		expectResult(correlation.observe({ type: "tool", toolCallId: "T-1" }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "tool-id",
			run: A,
		});
	});

	it("retains and evicts explicit-unowned tool IDs", () => {
		const correlation = new PiHostEventCorrelation();
		for (let index = 0; index < 512; index += 1) {
			correlation.observe({ type: "tool-claim", toolCallId: `U-${index}` }, undefined);
		}
		expectResult(correlation.observe({ type: "tool", toolCallId: "U-0" }, B), {
			decision: "ignore",
			kind: "unowned",
			evidence: "tool-id",
		});
		correlation.observe({ type: "tool-claim", toolCallId: "U-512" }, undefined);
		expectResult(correlation.observe({ type: "tool", toolCallId: "U-0" }, B), {
			decision: "apply",
			kind: "unknown",
			fallback: "preserve-current",
		});
	});
});

describe("PiHostEventCorrelation ordered retention", () => {
	it("keeps more than 512 pending markers in mixed FIFO order", () => {
		const correlation = new PiHostEventCorrelation();
		for (let index = 0; index < 512; index += 1) {
			correlation.observe({ type: "before-agent" }, A);
		}
		correlation.observe({ type: "before-agent" }, B);
		for (let index = 0; index < 512; index += 1) {
			expectResult(correlation.observe({ type: "agent-start" }, B), {
				decision: "ignore",
				kind: "stale",
				evidence: "pending-agent",
				run: A,
			});
		}
		expectResult(correlation.observe({ type: "agent-start" }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "pending-agent",
			run: B,
		});
		expectResult(correlation.observe({ type: "agent-start" }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "current-capture",
			run: B,
		});
	});

	it("keeps more than 512 agent-end markers in mixed FIFO order", () => {
		const correlation = new PiHostEventCorrelation();
		for (let index = 0; index < 512; index += 1) {
			correlation.observe({ type: "agent-start" }, A);
		}
		correlation.observe({ type: "agent-start" }, B);
		for (let index = 0; index < 512; index += 1) {
			expectResult(correlation.observe({ type: "agent-end", messages: [] }, B), {
				decision: "ignore",
				kind: "stale",
				evidence: "agent-order",
				run: A,
			});
		}
		expectResult(correlation.observe({ type: "agent-end", messages: [] }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "agent-order",
			run: B,
		});
		expectResult(correlation.observe({ type: "agent-end", messages: [] }, B), {
			decision: "ignore",
			kind: "unknown",
			fallback: "ignore-agent-end",
		});
	});

	it("keeps more than 512 settlement markers in mixed FIFO order", () => {
		const correlation = new PiHostEventCorrelation();
		const messageA = message(3_000);
		const messageB = message(3_001);
		correlation.observe({ type: "message-start", message: messageA }, A);
		correlation.observe({ type: "message-start", message: messageB }, B);
		for (let index = 0; index < 512; index += 1) {
			correlation.observe({ type: "agent-end", messages: [messageA] }, B);
		}
		correlation.observe({ type: "agent-end", messages: [messageB] }, B);
		for (let index = 0; index < 512; index += 1) {
			expectResult(correlation.observe({ type: "agent-settled" }, B), {
				decision: "ignore",
				kind: "stale",
				evidence: "settlement-order",
				run: A,
			});
		}
		expectResult(correlation.observe({ type: "agent-settled" }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "settlement-order",
			run: B,
		});
		expectResult(correlation.observe({ type: "agent-settled" }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "current-capture",
			run: B,
		});
	});

	it("keeps more than 512 compaction markers in mixed FIFO order", () => {
		const correlation = new PiHostEventCorrelation();
		for (let index = 0; index < 512; index += 1) {
			correlation.observe({ type: "before-compaction" }, A);
		}
		correlation.observe({ type: "before-compaction" }, B);
		for (let index = 0; index < 512; index += 1) {
			expectResult(correlation.observe({ type: "compaction" }, B), {
				decision: "ignore",
				kind: "stale",
				evidence: "compaction-order",
				run: A,
			});
		}
		expectResult(correlation.observe({ type: "compaction" }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "compaction-order",
			run: B,
		});
		expectResult(correlation.observe({ type: "compaction" }, B), {
			decision: "apply",
			kind: "unknown",
			fallback: "preserve-current",
		});
	});
});

describe("PiHostEventCorrelation discard and compaction", () => {
	it("discards all matching exact pending and compaction markers by ID and epoch", () => {
		const correlation = new PiHostEventCorrelation();
		for (const run of [A, A_NEW_EPOCH, A, B]) {
			correlation.observe({ type: "before-agent" }, run);
			correlation.observe({ type: "before-compaction" }, run);
		}
		correlation.observe({ type: "before-agent" }, undefined);

		expect(correlation.discardPendingForRun(A)).toEqual({
			pendingAgentMarkersRemoved: 2,
			pendingCompactionMarkersRemoved: 2,
			compactionSuppression: "armed",
		});
		expectResult(correlation.observe({ type: "agent-start" }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "pending-agent",
			run: A_NEW_EPOCH,
		});
		expectResult(correlation.observe({ type: "agent-start" }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "pending-agent",
			run: B,
		});
		expectResult(correlation.observe({ type: "agent-start" }, B), {
			decision: "ignore",
			kind: "unowned",
			evidence: "pending-agent",
		});
		expectResult(correlation.observe({ type: "compaction" }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "compaction-order",
			run: A_NEW_EPOCH,
		});
		expectResult(correlation.observe({ type: "compaction" }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "compaction-order",
			run: B,
		});
		expectResult(correlation.observe({ type: "compaction" }, B), {
			decision: "ignore",
			kind: "suppressed",
			evidence: "discarded-compaction",
		});
	});

	it("leaves message, tool, agent-end, settlement, and active facts unchanged", () => {
		const correlation = new PiHostEventCorrelation();
		const owned = message(4_000);
		correlation.observe({ type: "message-start", message: owned }, A);
		correlation.observe({ type: "tool-claim", toolCallId: "T" }, A);
		correlation.observe({ type: "before-agent" }, A);
		correlation.observe({ type: "agent-start" }, A);
		correlation.observe({ type: "before-agent" }, A);
		correlation.observe({ type: "agent-start" }, A);
		correlation.observe({ type: "agent-end", messages: [] }, A);
		correlation.observe({ type: "before-agent" }, A);
		correlation.observe({ type: "before-compaction" }, A);

		expect(correlation.discardPendingForRun(A)).toEqual({
			pendingAgentMarkersRemoved: 1,
			pendingCompactionMarkersRemoved: 1,
			compactionSuppression: "armed",
		});
		expectResult(correlation.observe({ type: "tool", toolCallId: "missing-active" }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "active-agent",
			run: A,
		});
		expectResult(correlation.observe({ type: "message", message: owned }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "message-object",
			run: A,
		});
		expectResult(correlation.observe({ type: "tool", toolCallId: "T" }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "tool-id",
			run: A,
		});
		expectResult(correlation.observe({ type: "agent-end", messages: [] }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "agent-order",
			run: A,
		});
		for (let index = 0; index < 2; index += 1) {
			expectResult(correlation.observe({ type: "agent-settled" }, B), {
				decision: "ignore",
				kind: "stale",
				evidence: "settlement-order",
				run: A,
			});
		}
	});

	it("does not queue an explicit-unowned before-compaction marker", () => {
		const correlation = new PiHostEventCorrelation();
		expectResult(correlation.observe({ type: "before-compaction" }, undefined), {
			decision: "apply",
			kind: "unowned",
			evidence: "current-capture",
		});
		expectResult(correlation.observe({ type: "compaction" }, B), {
			decision: "apply",
			kind: "unknown",
			fallback: "preserve-current",
		});
	});

	it("reports unchanged when no matching compaction exists and arms only after removal", () => {
		const correlation = new PiHostEventCorrelation();
		expect(correlation.discardPendingForRun(A)).toEqual({
			pendingAgentMarkersRemoved: 0,
			pendingCompactionMarkersRemoved: 0,
			compactionSuppression: "unchanged",
		});
		expectResult(correlation.observe({ type: "compaction" }, B), {
			decision: "apply",
			kind: "unknown",
			fallback: "preserve-current",
		});
		correlation.observe({ type: "before-compaction" }, A);
		expect(correlation.discardPendingForRun(A).compactionSuppression).toBe("armed");
		for (let index = 0; index < 2; index += 1) {
			expectResult(correlation.observe({ type: "compaction" }, B), {
				decision: "ignore",
				kind: "suppressed",
				evidence: "discarded-compaction",
			});
		}
	});

	it("lets queued exact markers precede armed suppression until before-compaction resets it", () => {
		const correlation = new PiHostEventCorrelation();
		correlation.observe({ type: "before-compaction" }, B);
		correlation.observe({ type: "before-compaction" }, A);
		correlation.discardPendingForRun(A);
		expectResult(correlation.observe({ type: "compaction" }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "compaction-order",
			run: B,
		});
		expectResult(correlation.observe({ type: "compaction" }, B), {
			decision: "ignore",
			kind: "suppressed",
			evidence: "discarded-compaction",
		});
		expectResult(correlation.observe({ type: "before-compaction" }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "current-capture",
			run: B,
		});
		expectResult(correlation.observe({ type: "compaction" }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "compaction-order",
			run: B,
		});
		expectResult(correlation.observe({ type: "compaction" }, B), {
			decision: "apply",
			kind: "unknown",
			fallback: "preserve-current",
		});
	});

	it("arms suppression when settlement discards matching exact compaction", () => {
		const correlation = new PiHostEventCorrelation();
		correlation.observe({ type: "before-compaction" }, A);
		correlation.observe({ type: "before-agent" }, A);
		correlation.observe({ type: "agent-start" }, A);
		correlation.observe({ type: "agent-end", messages: [] }, A);
		expectResult(correlation.observe({ type: "agent-settled" }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "settlement-order",
			run: A,
		});
		expectResult(correlation.observe({ type: "compaction" }, B), {
			decision: "ignore",
			kind: "suppressed",
			evidence: "discarded-compaction",
		});
	});

	it("queues only exact before-compaction and reset clears all non-weak state", () => {
		const correlation = new PiHostEventCorrelation();
		const live = message(5_000);
		correlation.observe({ type: "message-start", message: live }, A);
		correlation.observe({ type: "tool-claim", toolCallId: "T" }, A);
		correlation.observe({ type: "before-agent" }, A);
		correlation.observe({ type: "agent-start" }, A);
		correlation.observe({ type: "agent-end", messages: [] }, A);
		correlation.observe({ type: "before-compaction" }, A);
		correlation.discardPendingForRun(A);
		expectResult(correlation.observe({ type: "before-compaction" }, undefined), {
			decision: "apply",
			kind: "unowned",
			evidence: "current-capture",
		});
		correlation.resetSession();

		expectResult(correlation.observe({ type: "message", message: live }, B), {
			decision: "ignore",
			kind: "stale",
			evidence: "message-object",
			run: A,
		});
		expectResult(correlation.observe({ type: "message", message: message(5_000) }, B), {
			decision: "apply",
			kind: "unknown",
			fallback: "preserve-current",
		});
		expectResult(correlation.observe({ type: "tool", toolCallId: "T" }, B), {
			decision: "apply",
			kind: "unknown",
			fallback: "preserve-current",
		});
		expectResult(correlation.observe({ type: "agent-end", messages: [] }, B), {
			decision: "ignore",
			kind: "unknown",
			fallback: "ignore-agent-end",
		});
		expectResult(correlation.observe({ type: "agent-settled" }, B), {
			decision: "apply",
			kind: "exact",
			evidence: "current-capture",
			run: B,
		});
		expectResult(correlation.observe({ type: "compaction" }, B), {
			decision: "apply",
			kind: "unknown",
			fallback: "preserve-current",
		});
	});
});

describe("PiHostEventCorrelation ambiguity and dependency boundary", () => {
	it("does not throw for missing predecessors or out-of-order host observations", () => {
		const correlation = new PiHostEventCorrelation();
		const observations = [
			() => correlation.observe({ type: "agent-end", messages: [message(6_000)] }, A),
			() => correlation.observe({ type: "agent-settled" }, undefined),
			() => correlation.observe({ type: "message", message: message(6_001) }, A),
			() => correlation.observe({ type: "tool", toolCallId: "missing" }, A),
			() => correlation.observe({ type: "compaction" }, A),
			() => correlation.observe({ type: "before-compaction" }, undefined),
		];
		for (const observe of observations) expect(observe).not.toThrow();
	});

	it("has the exact public seam, neutral dependency, and sole production adoption", async () => {
		const moduleSource = await readFile(
			new URL("../src/host-event-correlation.ts", import.meta.url),
			"utf8",
		);
		const extensionSource = await readFile(
			new URL("../extensions/prewalk.ts", import.meta.url),
			"utf8",
		);
		const moduleFile = ts.createSourceFile(
			"host-event-correlation.ts",
			moduleSource,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);
		const exportedStatements = moduleFile.statements.filter((statement) => {
			const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
			return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
		});
		expect(exportedStatements).toHaveLength(7);
		const exportedNames = exportedStatements.flatMap((statement) => {
			if (ts.isTypeAliasDeclaration(statement) || ts.isClassDeclaration(statement)) {
				return statement.name ? [statement.name.text] : [];
			}
			return [];
		});
		expect(exportedNames).toEqual([
			"HostRunIdentity",
			"HostObservation",
			"HostCorrelationEvidence",
			"HostAttribution",
			"HostCorrelation",
			"PendingRunDiscard",
			"PiHostEventCorrelation",
		]);
		const correlationClass = moduleFile.statements.find(
			(statement): statement is ts.ClassDeclaration =>
				ts.isClassDeclaration(statement) && statement.name?.text === "PiHostEventCorrelation",
		);
		expect(
			correlationClass?.members.flatMap((member) =>
				ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)
					? [member.name.text]
					: [],
			),
		).toEqual(["resetSession", "discardPendingForRun", "observe"]);

		expect(moduleSource).toContain(
			'import type { AgentMessage } from "@earendil-works/pi-agent-core";',
		);
		for (const forbidden of [
			"./core.js",
			"PrewalkRun",
			"PrewalkCoordinator",
			"MutationTurnBuffer",
			"TemporaryModelRuntime",
			"AnalyticsStore",
			"subagent",
			"ExtensionAPI",
			"ExtensionContext",
			"ctx.compact",
		]) {
			expect(moduleSource).not.toContain(forbidden);
		}

		const extensionFile = ts.createSourceFile(
			"prewalk.ts",
			extensionSource,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);
		const observationTypes: string[] = [];
		const toolClaimIds: string[] = [];
		let resetCalls = 0;
		let discardCalls = 0;
		const visit = (node: ts.Node): void => {
			if (
				ts.isCallExpression(node) &&
				ts.isPropertyAccessExpression(node.expression) &&
				ts.isIdentifier(node.expression.expression) &&
				node.expression.expression.text === "hostCorrelation"
			) {
				const method = node.expression.name.text;
				if (method === "resetSession") resetCalls += 1;
				if (method === "discardPendingForRun") discardCalls += 1;
				if (method === "observe") {
					const observation = node.arguments[0];
					if (!observation || !ts.isObjectLiteralExpression(observation)) {
						throw new Error("host correlation observation must be an object literal");
					}
					const typeProperty = observation.properties.find(
						(property): property is ts.PropertyAssignment =>
							ts.isPropertyAssignment(property) &&
							property.name.getText(extensionFile) === "type",
					);
					if (!typeProperty || !ts.isStringLiteral(typeProperty.initializer)) {
						throw new Error("host correlation observation type must be a string literal");
					}
					observationTypes.push(typeProperty.initializer.text);
					if (typeProperty.initializer.text === "tool-claim") {
						const idProperty = observation.properties.find(
							(property): property is ts.PropertyAssignment =>
								ts.isPropertyAssignment(property) &&
								property.name.getText(extensionFile) === "toolCallId",
						);
						toolClaimIds.push(idProperty?.initializer.getText(extensionFile) ?? "missing");
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(extensionFile);
		expect(observationTypes.sort()).toEqual(
			[
				"before-agent",
				"agent-start",
				"agent-end",
				"agent-settled",
				"message-start",
				"message",
				"message",
				"tool-claim",
				"tool-claim",
				"tool",
				"tool",
				"before-compaction",
				"compaction",
			].sort(),
		);
		expect(toolClaimIds).toEqual(["event.toolCallId", "event.toolCallId"]);
		expect(resetCalls).toBe(1);
		expect(discardCalls).toBe(2);
		expect(extensionSource).toContain('from "../src/host-event-correlation.js"');
		expect(extensionSource).not.toContain(".attribution");
		expect(extensionSource).not.toContain("pendingAgentMarkersRemoved");
		for (const retired of [
			"HostRunMarker",
			"HostEventOwnership",
			"messageRunIds",
			"messageRunKeys",
			"toolRunIds",
			"hostSettlementRuns",
			"hostCompactionRuns",
			"pendingHostRuns",
			"agentEndRuns",
			"activeHostRun",
			"suppressUnownedCompaction",
			"messageKey",
			"rememberMessageRun",
			"messageOwnership",
			"activeHostRunMarker",
			"fallbackEventOwnership",
			"eventOwnership",
			"belongsToCurrentRun",
			"rememberToolRun",
			"toolOwnership",
			"rememberAgentContext",
			"discardPendingHostRun",
			"discardHostCompactionRun",
			"discardAgentEndRun",
			"beginAgentStream",
			"settleAgentStream",
		]) {
			expect(extensionSource).not.toContain(retired);
		}
	});
});
