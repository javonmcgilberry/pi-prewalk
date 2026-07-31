import type { Api, Model } from "@earendil-works/pi-ai";
import { isPlannerSelected, type ModelConfig, type PrewalkRun } from "./core.js";

export interface DelegationStatus {
	agent: string;
	state: "running" | "completed" | "failed";
	route?: "planner" | "executor";
	reason?: string;
}

export interface SessionStatus {
	mode: "manual" | "auto-ready";
	lastOutcome?: "bypassed" | "completed";
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
		const outcome = session?.lastOutcome ? `; last ${session.lastOutcome}` : "";
		return session ? `prewalk: ${session.mode}${outcome}` : undefined;
	}
	const plannerSelected = isPlannerSelected(selectedModel, run.planner);
	if (run.phase === "cancelled" && !plannerSelected) {
		const selected = selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : "none";
		return `prewalk: ${modelLabel(run.planner)} / ${modelLabel(run.config.executor)} (cancelled; selected: ${selected})`;
	}

	const plannerLabel = `${modelLabel(run.planner)} · ${run.planner.reasoning}`;
	const executorLabel = `${modelLabel(run.config.executor)} · ${run.config.executor.reasoning}`;
	const planner = run.effectiveRoute === "planner" ? `[${plannerLabel}]` : plannerLabel;
	const executor = run.effectiveRoute === "executor" ? `[${executorLabel}]` : executorLabel;
	switch (run.phase) {
		case "handoff-pending":
			return `prewalk: ${planner} / ${executor} (switching after this turn)`;
		case "cancelled":
			return `prewalk: ${planner} / ${executor} (cancelled)`;
		case "failed":
			return `prewalk: ${planner} / ${executor} (failed${run.reasonCode ? `: ${run.reasonCode.replaceAll("-", " ")}` : ""})`;
	}
	if (run.phase === "ready") {
		return `prewalk: ${planner} / ${executor} (waiting for this agent's first code change)`;
	}
	return `prewalk: ${planner} / ${executor}`;
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
