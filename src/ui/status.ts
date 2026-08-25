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
	mode: "manual" | "auto-ready";
	lastOutcome?: "bypassed" | "completed" | "failed" | "released";
}

function modelLabel(model: ModelConfig): string {
	if (model.model === "gpt-5.6-sol") return "5.6 Sol";
	if (model.model === "gpt-5.6-luna") return "5.6 Luna";
	return model.model;
}

function roleLabel(role: "Planner" | "Executor", model: ModelConfig, reasoning: string): string {
	return `${role}: ${modelLabel(model)} (${reasoning} reasoning)`;
}

export function compactStatus(
	run: PrewalkRun | undefined,
	selectedModel: Model<Api> | undefined,
	plannerReasoning = "off",
	_delegation?: DelegationStatus,
	session?: SessionStatus,
): string | undefined {
	if (!run) {
		const mode = session?.mode === "auto-ready" ? "Auto ready" : "Manual";
		const outcome = session?.lastOutcome ? ` · last ${session.lastOutcome}` : "";
		return session ? `prewalk: ${mode}${outcome}` : undefined;
	}
	const planner = roleLabel("Planner", run.planner, plannerReasoning);
	const executor = roleLabel("Executor", run.config.executor, run.config.executor.reasoning);
	const route = `${planner} → ${executor}`;
	const plannerSelected = isPlannerSelected(selectedModel, run.planner);
	if (run.phase === "cancelled" && !plannerSelected) {
		const selected = selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : "none";
		return `prewalk: Cancelled · selected ${selected}`;
	}
	switch (run.phase) {
		case "armed":
		case "planning":
			return `prewalk: Planning · ${route}`;
		case "ready":
			return `prewalk: Ready · ${route} · waiting for the first code change`;
		case "handoff-pending":
			return `prewalk: Switching after this turn · ${route}`;
		case "active":
		case "completed":
			return `prewalk: Executing · ${executor}`;
		case "cancelled":
			return `prewalk: Cancelled · ${planner}`;
		case "failed":
			return `prewalk: Failed · ${run.effectiveRoute === "executor" ? executor : planner}${run.reasonCode ? ` · ${run.reasonCode.replaceAll("-", " ")}` : ""}`;
	}
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
