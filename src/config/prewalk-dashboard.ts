import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { DEFAULT_ANALYTICS_CONFIG } from "../analytics/index.js";
import { isSameModelAtEffectiveReasoning } from "../executor/selection.js";
import {
	type ExecutorConfig,
	type PrewalkConfig,
	REASONING_LEVELS,
} from "../orchestration/coordinator.js";
import {
	childAgentNames,
	childPolicyFor,
	childPolicyLabel,
	DEFAULT_CHILD_AGENT,
	executorLabel,
	withChildPolicy,
} from "./child-policy.js";
import { PrewalkModelPicker } from "./model-picker.js";

export type ConfigureMenuResult = "saved" | "cancelled";

interface ConfigureMenuOptions {
	ctx: ExtensionContext;
	initial: PrewalkConfig;
	models: readonly Model<Api>[];
	planner: Model<Api>;
	onSave(config: PrewalkConfig): Promise<void>;
}

type Screen =
	| "home"
	| "main"
	| "children"
	| "child-agent"
	| "analytics"
	| "model"
	| "reasoning"
	| "add-agent"
	| "save-confirm"
	| "discard-confirm"
	| "help";
type BaseScreen = Exclude<Screen, "model" | "reasoning" | "add-agent" | "help">;
type EditorTarget = "main" | "child";
type MessageTone = "error" | "success" | "muted";

interface MenuRow {
	label: string;
	value?: string;
	description?: string;
}

const MAX_VISIBLE_ROWS = 10;
type MenuKeybindings = Pick<KeybindingsManager, "matches">;

/** One custom component owns the complete configuration lifecycle. */
export async function showPrewalkConfigureMenu(
	options: ConfigureMenuOptions,
): Promise<ConfigureMenuResult> {
	// Keep every child screen inside this component. Opening ctx.ui.select,
	// input, or confirm here would replace the custom component with Pi's core
	// editor when that nested dialog closes, stranding this promise off-screen.
	return (
		(await options.ctx.ui.custom<ConfigureMenuResult>(
			(tui, theme, keybindings, done) =>
				new PrewalkConfigureComponent(options, tui, theme, keybindings, done),
		)) ?? "cancelled"
	);
}

export class PrewalkConfigureComponent implements Component, Focusable {
	private readonly saved: PrewalkConfig;
	private draft: PrewalkConfig;
	private screen: Screen = "home";
	private selectedIndex = 0;
	private selectedAgent = DEFAULT_CHILD_AGENT;
	private editorTarget: EditorTarget = "main";
	private returnScreen: BaseScreen = "home";
	private returnIndex = 0;
	private helpReturnScreen: Exclude<Screen, "help"> = "home";
	private helpReturnIndex = 0;
	private modelPicker: PrewalkModelPicker | undefined;
	private agentInput: Input | undefined;
	private busy = false;
	private closed = false;
	private _focused = false;
	private message: { tone: MessageTone; text: string } | undefined;

	constructor(
		private readonly options: ConfigureMenuOptions,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: MenuKeybindings,
		private readonly done: (result: ConfigureMenuResult) => void,
	) {
		this.saved = structuredClone(options.initial);
		this.draft = structuredClone(options.initial);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.syncInputFocus();
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width);
		const lines = [
			this.theme.fg("borderAccent", "─".repeat(contentWidth)),
			this.renderHeading(contentWidth),
		];
		const subtitle = this.subtitle();
		if (subtitle) lines.push(this.theme.fg("muted", truncateToWidth(subtitle, contentWidth)));
		lines.push("");

		if (this.screen === "model" && this.modelPicker) {
			lines.push(...this.modelPicker.render(contentWidth));
		} else if (this.screen === "add-agent" && this.agentInput) {
			lines.push(
				this.theme.fg("muted", "Use the exact name from the pi-subagents agent file:"),
				...this.agentInput.render(contentWidth),
				"",
				this.theme.fg("muted", "Type a name · Enter add · Esc back"),
			);
		} else if (this.screen === "help") {
			lines.push(...this.renderHelp(contentWidth));
		} else {
			lines.push(...this.renderRows(contentWidth));
		}

		if (this.message) {
			lines.push("", this.theme.fg(this.message.tone, this.message.text));
		}
		if (this.busy) lines.push("", this.theme.fg("muted", "Saving…"));
		lines.push(this.theme.fg("borderAccent", "─".repeat(contentWidth)));
		return lines.map((line) => truncateToWidth(line, contentWidth));
	}

	invalidate(): void {
		this.modelPicker?.invalidate?.();
		this.agentInput?.invalidate();
	}

	dispose(): void {
		this.closed = true;
		this.modelPicker = undefined;
		this.agentInput = undefined;
	}

	handleInput(data: string): void {
		if (this.closed || this.busy) return;
		this.message = undefined;

		if (this.screen === "model" && this.modelPicker) {
			this.modelPicker.handleInput(data);
			this.requestRender();
			return;
		}
		if (this.screen === "add-agent" && this.agentInput) {
			this.handleAgentInput(data);
			return;
		}
		if (this.screen === "help") {
			if (
				data === "?" ||
				this.keybindings.matches(data, "tui.select.cancel") ||
				this.keybindings.matches(data, "tui.select.confirm")
			) {
				this.openScreen(this.helpReturnScreen, this.helpReturnIndex);
			}
			return;
		}
		if (data === "?") {
			this.helpReturnScreen = this.screen;
			this.helpReturnIndex = this.selectedIndex;
			this.openScreen("help");
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.goBack();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1, true);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1, true);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-MAX_VISIBLE_ROWS, false);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.moveSelection(MAX_VISIBLE_ROWS, false);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			void this.activateSelected();
		}
	}

	private renderHeading(width: number): string {
		const dirty = this.isDirty() ? this.theme.fg("warning", " • unsaved changes") : "";
		return truncateToWidth(`${this.theme.bold(this.title())}${dirty}`, width);
	}

	private title(): string {
		switch (this.screen) {
			case "home":
				return "Configure Prewalk";
			case "main":
				return "Configure Prewalk › Main handoff";
			case "children":
				return "Configure Prewalk › Child agents";
			case "child-agent":
				return `Configure Prewalk › Child agents › ${this.selectedAgent}`;
			case "analytics":
				return "Configure Prewalk › Usage records";
			case "model":
				return `Configure Prewalk › ${this.editorTarget === "main" ? "Main" : this.selectedAgent} model`;
			case "reasoning":
				return `Configure Prewalk › ${this.editorTarget === "main" ? "Main" : this.selectedAgent} effort`;
			case "add-agent":
				return "Configure Prewalk › Add child agent";
			case "save-confirm":
				return "Configure Prewalk › Review changes";
			case "discard-confirm":
				return "Configure Prewalk › Discard changes?";
			case "help":
				return "Configure Prewalk › Help";
		}
	}

	private subtitle(): string | undefined {
		switch (this.screen) {
			case "home":
				return "Choose a section. Nothing is written until you review and save.";
			case "main":
				return "The planner stays unchanged. These settings apply after the handoff.";
			case "children":
				return "Each child is independent and off until you enable it.";
			case "child-agent":
				return "Choose whether this agent stays unchanged, uses the main executor, or gets its own.";
			case "analytics":
				return "Usage records stay local and do not change model routing.";
			case "model":
				return "Search as you type, just like Pi’s model picker.";
			case "reasoning":
				return "Choose how much reasoning effort the executor may use.";
			case "add-agent":
				return "Adding an agent creates an off-by-default entry.";
			case "save-confirm":
				return "Review the draft below before writing prewalk.json.";
			case "discard-confirm":
				return "Your saved configuration will stay unchanged.";
			case "help":
				return "The same keys work throughout the menu.";
		}
	}

	private renderRows(width: number): string[] {
		const rows = this.rows();
		const lines: string[] = [];
		if (this.screen === "save-confirm") lines.push(...this.renderSummary(width), "");
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(MAX_VISIBLE_ROWS / 2),
				rows.length - MAX_VISIBLE_ROWS,
			),
		);
		const endIndex = Math.min(startIndex + MAX_VISIBLE_ROWS, rows.length);
		for (let index = startIndex; index < endIndex; index += 1) {
			const row = rows[index];
			if (!row) continue;
			const selected = index === this.selectedIndex;
			const marker = selected ? this.theme.fg("accent", "→ ") : "  ";
			const label = selected ? this.theme.fg("accent", row.label) : row.label;
			const value = row.value ? this.theme.fg("muted", `  ${row.value}`) : "";
			lines.push(truncateToWidth(`${marker}${label}${value}`, width));
		}
		if (startIndex > 0 || endIndex < rows.length) {
			lines.push(this.theme.fg("muted", `  ${this.selectedIndex + 1} of ${rows.length}`));
		}
		const selected = rows[this.selectedIndex];
		if (selected?.description) {
			lines.push("");
			for (const line of wrapTextWithAnsi(selected.description, Math.max(1, width - 2))) {
				lines.push(this.theme.fg("muted", `  ${line}`));
			}
		}
		lines.push("", this.theme.fg("muted", this.footerText()));
		return lines;
	}

	private rows(): MenuRow[] {
		switch (this.screen) {
			case "home":
				return [
					{
						label: "Main handoff",
						value: executorLabel(this.draft.executor),
						description: "Choose the executor model and effort used after planning.",
					},
					{
						label: "Child agents",
						value: this.childSummary(),
						description:
							"Opt in individual pi-subagents without changing their parent or siblings.",
					},
					{
						label: "Usage records",
						value: this.analytics().enabled ? "On" : "Off",
						description: "Control local run accounting and optional catalog estimates.",
					},
					{
						label: "Automatic startup",
						value: this.draft.enabled ? "On" : "Off",
						description:
							"Use automatic mode for fresh top-level sessions. Resumed sessions stay manual.",
					},
					{
						label: "Review and save",
						value: this.isDirty() ? this.changeSummary() : "No changes yet",
						description: "Review the complete draft, then write it atomically.",
					},
					{
						label: this.isDirty() ? "Discard draft and close" : "Close settings",
						description: this.isDirty()
							? "Leave the saved file exactly as it was."
							: "Return to Pi without writing anything.",
					},
				];
			case "main":
				return [
					{
						label: "Executor model",
						value: `${this.draft.executor.provider}/${this.draft.executor.model}`,
						description: "Open a fuzzy-searchable model picker. Typing filters immediately.",
					},
					{
						label: "Executor effort",
						value: this.draft.executor.reasoning,
						description: "This is independent from the planner’s reasoning level.",
					},
					{ label: "Back to overview" },
				];
			case "children":
				return [
					...childAgentNames(this.draft).map((agent) => ({
						label: agent,
						value: childPolicyLabel(childPolicyFor(this.draft, agent), this.draft.executor),
						description: "Open this agent’s independent Prewalk policy.",
					})),
					{
						label: "Add child agent",
						description: "Add another pi-subagents agent name. New entries start off.",
					},
					{ label: "Back to overview" },
				];
			case "child-agent": {
				const policy = childPolicyFor(this.draft, this.selectedAgent);
				const rows: MenuRow[] = [
					{
						label: "Use main executor",
						value: policy === true ? "✓ current" : executorLabel(this.draft.executor),
						description: "Turn on Prewalk for this agent using the main handoff executor.",
					},
					{
						label: "Use custom executor",
						value:
							policy !== false && policy !== true
								? `✓ ${policy.executor.provider}/${policy.executor.model}`
								: "Choose a model",
						description: "Search for a separate executor used only by this agent.",
					},
				];
				if (policy !== false && policy !== true) {
					rows.push({
						label: "Custom executor effort",
						value: policy.executor.reasoning,
						description: "Change reasoning effort without changing this agent’s model.",
					});
				}
				rows.push(
					{
						label: "Turn off",
						value: policy === false ? "✓ current" : undefined,
						description:
							"Leave this child’s model and tools exactly as pi-subagents supplied them.",
					},
					{ label: "Back to child agents" },
				);
				return rows;
			}
			case "analytics":
				return [
					{
						label: "Store local usage records",
						value: this.analytics().enabled ? "On" : "Off",
						description: "Record local Prewalk run costs and outcomes for /prewalk stats.",
					},
					{
						label: "Allow catalog cost estimates",
						value: this.analytics().catalogFallbackEnabled ? "On" : "Off",
						description:
							"Use model-catalog prices only when a provider does not report exact cost.",
					},
					{ label: "Back to overview" },
				];
			case "reasoning": {
				const current = this.targetExecutor().reasoning;
				return REASONING_LEVELS.map((level) => ({
					label: level,
					value: level === current ? "✓ current" : undefined,
					description: this.reasoningDescription(level),
				}));
			}
			case "save-confirm":
				return [
					{
						label: "Save changes",
						description: "Write prewalk.json atomically. Existing runs are not changed.",
					},
					{
						label: "Keep editing",
						description: "Return to the overview without writing yet.",
					},
				];
			case "discard-confirm":
				return [
					{
						label: "Keep editing",
						description: "Return to the draft. Nothing has been lost or saved.",
					},
					{
						label: "Discard draft and close",
						description: "Close configuration and leave the saved file unchanged.",
					},
				];
			case "model":
			case "add-agent":
			case "help":
				return [];
		}
	}

	private footerText(): string {
		if (this.screen === "help") return "Esc or Enter · back";
		if (this.screen === "save-confirm" || this.screen === "discard-confirm") {
			return "↑↓ move · Enter choose · Esc keep editing";
		}
		if (this.screen === "home") {
			return "↑↓ move · Enter open · ? help · Esc close";
		}
		return "↑↓ move · PgUp/PgDn jump · Enter open/change · ? help · Esc back";
	}

	private renderHelp(width: number): string[] {
		const paragraphs = [
			"Every change stays in a draft until you choose Review and save, then Save changes.",
			"Use ↑ and ↓ inside a list. Enter opens or changes the selected row. Escape moves back one level. Escape from the overview closes the menu; if the draft changed, Prewalk asks before discarding it.",
			"Model screens work like Pi’s model picker: start typing to fuzzy-filter by provider, model name, or ID. Use Page Up and Page Down for longer result sets.",
			"Child policies are independent. Off leaves the child alone, Use main executor follows the main handoff target, and Use custom executor stores a target for that agent only.",
			"No printable letter is an exit shortcut, so typing in search or name fields cannot accidentally close configuration.",
		];
		const lines: string[] = [];
		for (const paragraph of paragraphs) {
			lines.push(...wrapTextWithAnsi(paragraph, width), "");
		}
		lines.push(this.theme.fg("muted", "Esc, Enter, or ? · back"));
		return lines;
	}

	private renderSummary(width: number): string[] {
		const summary = [
			`Automatic     ${this.draft.enabled ? "on for fresh sessions" : "off"}`,
			`Main executor  ${executorLabel(this.draft.executor)}`,
		];
		if (this.draft.executorFallbacks && this.draft.executorFallbacks.length > 0) {
			summary.push(
				`Fallbacks      ${this.draft.executorFallbacks.map(executorLabel).join("; ")}`,
			);
		}
		summary.push("Child policies");
		for (const agent of childAgentNames(this.draft)) {
			summary.push(
				`  ${agent}: ${childPolicyLabel(childPolicyFor(this.draft, agent), this.draft.executor)}`,
			);
		}
		summary.push(
			`Usage records  ${this.analytics().enabled ? "on" : "off"}`,
			`Cost estimates ${this.analytics().catalogFallbackEnabled ? "allowed" : "off"}`,
		);
		return summary.flatMap((line) => wrapTextWithAnsi(line, width));
	}

	private async activateSelected(): Promise<void> {
		switch (this.screen) {
			case "home":
				this.activateHome();
				return;
			case "main":
				if (this.selectedIndex === 0) this.openModelPicker("main", "main");
				else if (this.selectedIndex === 1) this.openReasoning("main", "main");
				else this.openScreen("home");
				return;
			case "children":
				this.activateChildren();
				return;
			case "child-agent":
				this.activateChildAgent();
				return;
			case "analytics":
				this.activateAnalytics();
				return;
			case "reasoning":
				this.applyReasoning();
				return;
			case "save-confirm":
				if (this.selectedIndex === 0) await this.save();
				else this.openScreen("home", 4);
				return;
			case "discard-confirm":
				if (this.selectedIndex === 0) this.openScreen("home", 5);
				else this.close("cancelled");
				return;
			case "model":
			case "add-agent":
			case "help":
				return;
		}
	}

	private activateHome(): void {
		if (this.selectedIndex === 0) this.openScreen("main");
		else if (this.selectedIndex === 1) this.openScreen("children");
		else if (this.selectedIndex === 2) this.openScreen("analytics");
		else if (this.selectedIndex === 3) {
			this.draft.enabled = !this.draft.enabled;
			this.message = {
				tone: "muted",
				text: this.draft.enabled
					? "Fresh top-level sessions will start in automatic mode."
					: "Fresh top-level sessions will start in manual mode.",
			};
			this.requestRender();
		} else if (this.selectedIndex === 4) {
			if (this.isDirty()) this.openScreen("save-confirm");
			else this.message = { tone: "muted", text: "There are no changes to save." };
		} else if (this.isDirty()) this.openScreen("discard-confirm");
		else this.close("cancelled");
		this.requestRender();
	}

	private activateChildren(): void {
		const agents = childAgentNames(this.draft);
		if (this.selectedIndex < agents.length) {
			this.selectedAgent = agents[this.selectedIndex] ?? DEFAULT_CHILD_AGENT;
			this.openScreen("child-agent", this.childPolicyRowIndex(this.selectedAgent));
		} else if (this.selectedIndex === agents.length) {
			this.agentInput = new Input();
			this.returnIndex = this.selectedIndex;
			this.openScreen("add-agent");
		} else {
			this.openScreen("home", 1);
		}
	}

	private activateChildAgent(): void {
		const policy = childPolicyFor(this.draft, this.selectedAgent);
		if (this.selectedIndex === 0) {
			this.draft = withChildPolicy(this.draft, this.selectedAgent, true);
			this.message = {
				tone: "success",
				text: `${this.selectedAgent} will use the main executor.`,
			};
			this.requestRender();
			return;
		}
		if (this.selectedIndex === 1) {
			this.openModelPicker("child", "child-agent");
			return;
		}
		const hasCustom = policy !== false && policy !== true;
		if (hasCustom && this.selectedIndex === 2) {
			this.openReasoning("child", "child-agent");
			return;
		}
		const offIndex = hasCustom ? 3 : 2;
		if (this.selectedIndex === offIndex) {
			this.draft = withChildPolicy(this.draft, this.selectedAgent, false);
			this.selectedIndex = this.childPolicyRowIndex(this.selectedAgent);
			this.message = { tone: "success", text: `${this.selectedAgent} will stay unchanged.` };
			this.requestRender();
			return;
		}
		this.openScreen(
			"children",
			Math.max(0, childAgentNames(this.draft).indexOf(this.selectedAgent)),
		);
	}

	private activateAnalytics(): void {
		if (this.selectedIndex === 0) {
			this.draft.analytics = { ...this.analytics(), enabled: !this.analytics().enabled };
		} else if (this.selectedIndex === 1) {
			this.draft.analytics = {
				...this.analytics(),
				catalogFallbackEnabled: !this.analytics().catalogFallbackEnabled,
			};
		} else {
			this.openScreen("home", 2);
			return;
		}
		this.requestRender();
	}

	private openModelPicker(target: EditorTarget, returnScreen: BaseScreen): void {
		this.editorTarget = target;
		this.returnScreen = returnScreen;
		this.returnIndex = this.selectedIndex;
		const current = this.targetExecutor();
		this.modelPicker = new PrewalkModelPicker(
			this.options.models,
			current,
			this.theme,
			this.keybindings,
			(model) => this.applyModel(model),
			() => this.closeModelPicker(),
		);
		this.openScreen("model");
	}

	private applyModel(model: Model<Api>): void {
		const current = this.targetExecutor();
		const executor = {
			provider: model.provider,
			model: model.id,
			reasoning:
				current.provider === model.provider && current.model === model.id
					? current.reasoning
					: "low",
		} satisfies ExecutorConfig;
		if (this.editorTarget === "main") this.draft.executor = executor;
		else this.draft = withChildPolicy(this.draft, this.selectedAgent, { executor });
		this.closeModelPicker();
	}

	private closeModelPicker(): void {
		this.modelPicker = undefined;
		this.openScreen(this.returnScreen, this.returnIndex);
	}

	private openReasoning(target: EditorTarget, returnScreen: BaseScreen): void {
		this.editorTarget = target;
		this.returnScreen = returnScreen;
		this.returnIndex = this.selectedIndex;
		this.openScreen("reasoning", REASONING_LEVELS.indexOf(this.targetExecutor().reasoning));
	}

	private applyReasoning(): void {
		const reasoning = REASONING_LEVELS[this.selectedIndex];
		if (!reasoning) return;
		if (this.editorTarget === "main") this.draft.executor.reasoning = reasoning;
		else {
			const policy = childPolicyFor(this.draft, this.selectedAgent);
			if (policy !== false && policy !== true) {
				this.draft = withChildPolicy(this.draft, this.selectedAgent, {
					executor: { ...policy.executor, reasoning },
				});
			}
		}
		this.openScreen(this.returnScreen, this.returnIndex);
	}

	private handleAgentInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.agentInput = undefined;
			this.openScreen("children", this.returnIndex);
			return;
		}
		if (
			this.keybindings.matches(data, "tui.select.confirm") ||
			this.keybindings.matches(data, "tui.input.submit")
		) {
			const name = this.agentInput?.getValue().trim() ?? "";
			if (!name) {
				this.message = { tone: "error", text: "Enter a child agent name first." };
				this.requestRender();
				return;
			}
			if (childAgentNames(this.draft).includes(name)) {
				this.message = { tone: "error", text: `${name} is already listed.` };
				this.requestRender();
				return;
			}
			this.draft = withChildPolicy(this.draft, name, false);
			this.selectedAgent = name;
			this.agentInput = undefined;
			this.openScreen("child-agent", this.childPolicyRowIndex(name));
			return;
		}
		this.agentInput?.handleInput(data);
		this.requestRender();
	}

	private async save(): Promise<void> {
		if (this.mainTargetMatchesPlanner()) {
			this.openScreen("main");
			this.message = {
				tone: "error",
				text: "The main executor is the current planner at the same effective effort. Choose another model or effort.",
			};
			this.requestRender();
			return;
		}
		this.busy = true;
		this.requestRender();
		try {
			await this.options.onSave(structuredClone(this.draft));
			this.close("saved");
		} catch (error) {
			this.busy = false;
			this.message = {
				tone: "error",
				text: `Could not save settings: ${error instanceof Error ? error.message : String(error)}`,
			};
			this.requestRender();
		}
	}

	private goBack(): void {
		switch (this.screen) {
			case "home":
				if (this.isDirty()) this.openScreen("discard-confirm");
				else this.close("cancelled");
				return;
			case "main":
				this.openScreen("home", 0);
				return;
			case "children":
				this.openScreen("home", 1);
				return;
			case "analytics":
				this.openScreen("home", 2);
				return;
			case "child-agent":
				this.openScreen(
					"children",
					Math.max(0, childAgentNames(this.draft).indexOf(this.selectedAgent)),
				);
				return;
			case "reasoning":
			case "model":
				this.modelPicker = undefined;
				this.openScreen(this.returnScreen, this.returnIndex);
				return;
			case "add-agent":
				this.agentInput = undefined;
				this.openScreen("children", this.returnIndex);
				return;
			case "save-confirm":
				this.openScreen("home", 4);
				return;
			case "discard-confirm":
				this.openScreen("home", 5);
				return;
			case "help":
				this.openScreen(this.helpReturnScreen, this.helpReturnIndex);
				return;
		}
	}

	private openScreen(screen: Screen, selectedIndex = 0): void {
		this.screen = screen;
		this.selectedIndex = Math.max(0, selectedIndex);
		this.message = undefined;
		this.syncInputFocus();
		this.requestRender();
	}

	private syncInputFocus(): void {
		if (this.modelPicker) this.modelPicker.focused = this._focused && this.screen === "model";
		if (this.agentInput) this.agentInput.focused = this._focused && this.screen === "add-agent";
	}

	private moveSelection(delta: number, wrap: boolean): void {
		const count = this.rows().length;
		if (count === 0) return;
		if (wrap && Math.abs(delta) === 1) {
			this.selectedIndex = (this.selectedIndex + delta + count) % count;
		} else {
			this.selectedIndex = Math.max(0, Math.min(count - 1, this.selectedIndex + delta));
		}
		this.requestRender();
	}

	private targetExecutor(): ExecutorConfig {
		if (this.editorTarget === "main") return this.draft.executor;
		const policy = childPolicyFor(this.draft, this.selectedAgent);
		return policy !== false && policy !== true ? policy.executor : this.draft.executor;
	}

	private analytics() {
		return this.draft.analytics ?? structuredClone(DEFAULT_ANALYTICS_CONFIG);
	}

	private childSummary(): string {
		const enabled = childAgentNames(this.draft).filter(
			(agent) => childPolicyFor(this.draft, agent) !== false,
		);
		return enabled.length === 0 ? "All off" : `${enabled.length} on · ${enabled.join(", ")}`;
	}

	private childPolicyRowIndex(agent: string): number {
		const policy = childPolicyFor(this.draft, agent);
		if (policy === true) return 0;
		if (policy === false) return 2;
		return 1;
	}

	private isDirty(): boolean {
		return JSON.stringify(this.draft) !== JSON.stringify(this.saved);
	}

	private changeSummary(): string {
		let changes = 0;
		if (Boolean(this.draft.enabled) !== Boolean(this.saved.enabled)) changes += 1;
		if (JSON.stringify(this.draft.executor) !== JSON.stringify(this.saved.executor)) changes += 1;
		if (JSON.stringify(this.draft.children) !== JSON.stringify(this.saved.children)) changes += 1;
		if (JSON.stringify(this.draft.analytics) !== JSON.stringify(this.saved.analytics))
			changes += 1;
		return `${changes} changed ${changes === 1 ? "section" : "sections"}`;
	}

	private mainTargetMatchesPlanner(): boolean {
		const target = this.options.models.find(
			(model) =>
				model.provider === this.draft.executor.provider &&
				model.id === this.draft.executor.model,
		);
		return target
			? isSameModelAtEffectiveReasoning(
					this.options.planner,
					this.options.ctx.thinkingLevel ?? "off",
					target,
					this.draft.executor.reasoning,
				)
			: false;
	}

	private reasoningDescription(level: ThinkingLevel): string {
		if (level === "minimal") return "Fastest and least expensive supported reasoning.";
		if (level === "low") return "A conservative default for implementation work.";
		if (level === "medium") return "More reasoning for moderately complex changes.";
		if (level === "high") return "Deeper reasoning for difficult implementation work.";
		return "Use only when the selected model supports this higher effort level.";
	}

	private requestRender(): void {
		if (!this.closed) this.tui.requestRender();
	}

	private close(result: ConfigureMenuResult): void {
		if (this.closed) return;
		this.closed = true;
		this.done(result);
	}
}
