import type { Api, Model } from "@earendil-works/pi-ai";
import {
	isPlannerSelected,
	type ModelConfig,
	type PrewalkRun,
} from "../orchestration/coordinator.js";

export interface DelegationStatus {
	agent: string;
	state: "running" | "completed" | "failed";
	route?: "planner" | "executor";
	reason?: string;
}

export interface SessionStatus {
	lastOutcome?: "bypassed" | "completed" | "failed" | "released";
}

function modelLabel(model: ModelConfig): string {
	if (model.model === "gpt-5.6-sol") return "5.6 Sol";
	if (model.model === "gpt-5.6-luna") return "Luna";
	return model.model;
}

export function compactStatus(
	run: PrewalkRun | undefined,
	selectedModel: Model<Api> | undefined,
	_plannerReasoning = "off",
	_delegation?: DelegationStatus,
	session?: SessionStatus,
): string | undefined {
	if (!run) {
		if (!session) return undefined;
		return `prewalk: off${session.lastOutcome ? ` · last ${session.lastOutcome}` : ""}`;
	}
	const plannerSelected = isPlannerSelected(selectedModel, run.planner);
	if (run.phase === "cancelled" && !plannerSelected) {
		const selected = selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : "none";
		return `prewalk: cancelled · selected ${selected}`;
	}

	const planner = modelLabel(run.planner);
	const executor = modelLabel(run.config.executor);
	switch (run.phase) {
		case "armed":
			return `prewalk: armed · ${planner} → ${executor}`;
		case "planning":
			return `prewalk: planning · ${planner} → ${executor}`;
		case "handoff-pending":
			return `prewalk: switching to ${executor}`;
		case "cancelled":
			return "prewalk: cancelled";
		case "failed":
			return `prewalk: failed${run.reasonCode ? ` · ${run.reasonCode.replaceAll("-", " ")}` : ""}`;
		case "active":
		case "completed":
			return `prewalk: executor · ${executor}`;
	}
	if (run.phase === "ready") {
		return `prewalk: ready · ${planner} → ${executor} · waiting for first code change`;
	}
	return `prewalk: ${planner} → ${executor}`;
}

export function detailedStatus(
	run: PrewalkRun | undefined,
	selectedModel: Model<Api> | undefined,
	plannerReasoning = "off",
	delegation?: DelegationStatus,
	session?: SessionStatus,
): string {
	if (!run)
		return (
			compactStatus(undefined, selectedModel, plannerReasoning, delegation, session) ??
			"Prewalk is inactive."
		);
	const selected = selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : "none";
	const detail = [
		`status=${compactStatus(run, selectedModel, plannerReasoning, delegation)}`,
		`mode=${run.mode}`,
		`phase=${run.phase}`,
		`run=${run.id}`,
		`planner=${run.planner.provider}/${run.planner.model}`,
		`executor=${run.config.executor.provider}/${run.config.executor.model}`,
		`executor reasoning=${run.config.executor.reasoning}`,
		`selected=${selected}`,
		`todo=${run.todoActive ? (run.todoSeen ? "ready" : "required") : "inactive"}`,
	];
	if (run.trigger) detail.push(`trigger=${run.trigger.toolName}`);
	if (run.reasonCode) detail.push(`reason=${run.reasonCode}`);
	if (delegation) {
		detail.push(`delegation=${delegation.agent} ${delegation.state}`);
		if (delegation.route) detail.push(`delegation route=${delegation.route}`);
		if (delegation.reason) detail.push(`delegation reason=${delegation.reason}`);
	}
	return detail.join("\n");
}
