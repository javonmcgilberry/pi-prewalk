import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const tracePath = process.env.PI_PREWALK_CHILD_TRACE;
const workDir = process.env.PI_PREWALK_CHILD_WORKDIR;
const calls = new Map();

function trace(value) {
	if (!tracePath) return;
	appendFileSync(tracePath, `${JSON.stringify(value)}\n`);
}

function model(id) {
	return {
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "fixture",
		baseUrl: "https://fixture.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 128000,
	};
}

function message(selected, content) {
	return {
		role: "assistant",
		content,
		api: selected.api,
		provider: selected.provider,
		model: selected.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

function stream(selected, content) {
	const result = createAssistantMessageEventStream();
	const assistant = message(selected, content);
	queueMicrotask(() => {
		result.push({ type: "start", partial: assistant });
		result.push({
			type: "done",
			reason: assistant.stopReason === "toolUse" ? "toolUse" : "stop",
			message: assistant,
		});
		result.end();
	});
	return result;
}

function toolCall(id, name, args) {
	return { type: "toolCall", id, name, arguments: args };
}

function responseFor(agent, callNumber) {
	if (agent === "parent") {
		return callNumber === 1
			? [
					toolCall("delegate-worker", "subagent", {
						workflowScript:
							"return runs.run('main', { agent: 'worker', task: 'Make the requested worker and nested changes.' })",
						async: false,
					}),
				]
			: [{ type: "text", text: "Delegation complete." }];
	}

	if (agent === "worker") {
		if (callNumber === 1) {
			return [
				toolCall("delegate-reviewer", "subagent", {
					workflowScript:
						"return runs.run('main', { agent: 'reviewer', task: 'Make the nested change without child Prewalk.' })",
					async: false,
				}),
			];
		}
		if (callNumber === 2) {
			return [
				toolCall("edit-worker", "edit", {
					path: `${workDir}/worker.txt`,
					oldText: "before",
					newText: "worker",
				}),
			];
		}
		return [{ type: "text", text: "Worker finished after its own Prewalk handoff." }];
	}

	if (agent === "reviewer" && callNumber === 1) {
		return [
			toolCall("edit-nested", "edit", {
				path: `${workDir}/nested.txt`,
				oldText: "before",
				newText: "nested",
			}),
		];
	}
	return [{ type: "text", text: "Nested reviewer finished." }];
}

export default function registerFixtureProvider(pi) {
	pi.registerProvider("fixture", {
		api: "openai-codex-responses",
		baseUrl: "https://fixture.invalid",
		apiKey: "credential-free-fixture",
		models: [model("planner"), model("executor")],
		streamSimple(selected) {
			const agent =
				process.env.PI_SUBAGENT_CHILD === "1"
					? process.env.PI_SUBAGENT_CHILD_AGENT || "unknown-child"
					: "parent";
			const callNumber = (calls.get(agent) ?? 0) + 1;
			calls.set(agent, callNumber);
			trace({
				type: "provider",
				agent,
				callNumber,
				model: selected.id,
				runId: process.env.PI_SUBAGENT_RUN_ID ?? null,
			});
			return stream(selected, responseFor(agent, callNumber));
		},
	});

	pi.on("before_agent_start", () => {
		const agent =
			process.env.PI_SUBAGENT_CHILD === "1"
				? process.env.PI_SUBAGENT_CHILD_AGENT || "unknown-child"
				: "parent";
		trace({
			type: "before-agent-start",
			agent,
			runId: process.env.PI_SUBAGENT_RUN_ID ?? null,
			tools: pi.getActiveTools(),
		});
	});

	pi.on("session_shutdown", () => {
		const agent =
			process.env.PI_SUBAGENT_CHILD === "1"
				? process.env.PI_SUBAGENT_CHILD_AGENT || "unknown-child"
				: "parent";
		trace({
			type: "session-shutdown",
			agent,
			runId: process.env.PI_SUBAGENT_RUN_ID ?? null,
		});
	});
}
