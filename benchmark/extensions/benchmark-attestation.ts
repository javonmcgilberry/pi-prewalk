import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ACTIVE_TOOLS = ["exec_command", "write_stdin", "apply_patch", "prewalk_todo"];
const REMOTE_TOOLS = new Set(["exec_command", "write_stdin", "apply_patch"]);

function attest(pi: ExtensionAPI): void {
	const active = pi.getActiveTools();
	if (
		active.length !== ACTIVE_TOOLS.length ||
		ACTIVE_TOOLS.some((name, index) => active[index] !== name)
	) {
		throw new Error("benchmark-tool-slate-drift");
	}
	for (const tool of pi.getAllTools()) {
		if (
			REMOTE_TOOLS.has(tool.name) &&
			!tool.sourceInfo.path.toLowerCase().includes("benchmark-tools")
		) {
			throw new Error("benchmark-host-tool-owner");
		}
		if (tool.name === "prewalk_todo" && !tool.sourceInfo.path.toLowerCase().includes("prewalk")) {
			throw new Error("benchmark-todo-owner");
		}
	}
}

export default function benchmarkAttestation(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		pi.setActiveTools(ACTIVE_TOOLS);
		attest(pi);
	});
	pi.on("before_agent_start", () => {
		attest(pi);
	});
}
