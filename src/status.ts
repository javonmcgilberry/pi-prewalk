import type { Api, Model } from "@earendil-works/pi-ai";
import { isPlannerSelected, type PrewalkRun } from "./core.js";

export function compactStatus(
	run: PrewalkRun | undefined,
	selectedModel: Model<Api> | undefined,
): string | undefined {
	if (!run) return undefined;
	if (run.phase === "cancelled" && !isPlannerSelected(selectedModel)) {
		const selected = selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : "none";
		return `prewalk: 5.6 Sol / Luna (cancelled; Pi: ${selected})`;
	}

	const sol = run.effectiveRoute === "sol" ? "[5.6 Sol]" : "5.6 Sol";
	const luna = run.effectiveRoute === "luna" ? "[Luna]" : "Luna";
	switch (run.phase) {
		case "ready":
			return `prewalk: ${sol} / ${luna} (ready)`;
		case "cancelled":
			return `prewalk: ${sol} / ${luna} (cancelled)`;
		case "failed":
			return `prewalk: ${sol} / ${luna} (failed)`;
		default:
			return `prewalk: ${sol} / ${luna}`;
	}
}

export function detailedStatus(
	run: PrewalkRun | undefined,
	selectedModel: Model<Api> | undefined,
): string {
	if (!run) return "Prewalk is inactive.";
	const selected = selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : "none";
	const detail = [
		`status=${compactStatus(run, selectedModel)}`,
		`mode=${run.mode}`,
		`phase=${run.phase}`,
		`run=${run.id}`,
		`selected=${selected}`,
		`todo=${run.todoActive ? (run.todoSeen ? "ready" : "required") : "inactive"}`,
	];
	if (run.trigger) detail.push(`trigger=${run.trigger.toolName}`);
	if (run.reasonCode) detail.push(`reason=${run.reasonCode}`);
	return detail.join("\n");
}
