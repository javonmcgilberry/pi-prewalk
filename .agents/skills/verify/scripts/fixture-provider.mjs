/**
 * Verification scaffolding: a credential-free scripted provider for driving
 * Prewalk through a real Pi process. It is loaded with `-e` next to
 * extensions/prewalk.ts and never reaches the network.
 *
 * Provider `fixture` serves `planner` and `executor`. The planner creates a
 * checklist, then writes PREWALK_VERIFY_TARGET and marks the item done. The
 * executor answers with plain text. Every request is appended to
 * PREWALK_VERIFY_TRACE so the driver can prove which model served each turn.
 */
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const tracePath = process.env.PREWALK_VERIFY_TRACE;
const target = process.env.PREWALK_VERIFY_TARGET ?? "prewalk-verify.txt";
const calls = { planner: 0, executor: 0 };

function model(id) {
	return {
		id,
		name: `Fixture ${id}`,
		api: "openai-codex-responses",
		provider: "fixture",
		baseUrl: "https://fixture.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	};
}

function toolCall(id, name, args) {
	return { type: "toolCall", id, name, arguments: args };
}

function plannerResponse(callNumber) {
	if (callNumber === 1)
		return [
			toolCall("verify-todo-init", "prewalk_todo", {
				op: "init",
				list: [{ phase: "Implement", items: ["Write the verification file"] }],
			}),
		];
	if (callNumber === 2)
		return [
			toolCall("verify-write", "write", { path: target, content: "written by the planner\n" }),
			toolCall("verify-todo-done", "prewalk_todo", {
				op: "done",
				task: "Write the verification file",
			}),
		];
	return [{ type: "text", text: "Planner has nothing further." }];
}

function respond(selected, content) {
	const stream = createAssistantMessageEventStream();
	const message = {
		role: "assistant",
		content,
		api: selected.api,
		provider: selected.provider,
		model: selected.id,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({
			type: "done",
			reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
			message,
		});
		stream.end();
	});
	return stream;
}

export default function registerVerifyFixture(pi) {
	pi.registerProvider("fixture", {
		api: "openai-codex-responses",
		baseUrl: "https://fixture.invalid",
		apiKey: "credential-free-fixture",
		models: [model("planner"), model("executor")],
		streamSimple(selected, _context, options) {
			const role = selected.id === "executor" ? "executor" : "planner";
			calls[role] += 1;
			const content =
				role === "executor"
					? [{ type: "text", text: "Executor completed the handoff." }]
					: plannerResponse(calls[role]);
			if (tracePath)
				appendFileSync(
					tracePath,
					`${JSON.stringify({
						type: "provider-request",
						model: `${selected.provider}/${selected.id}`,
						callNumber: calls[role],
						reasoning: options?.reasoning ?? null,
						reply: content.map((block) => (block.type === "toolCall" ? block.name : "text")),
					})}\n`,
				);
			return respond(selected, content);
		},
	});
}
