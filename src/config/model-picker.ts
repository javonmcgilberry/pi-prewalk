import type { Api, Model } from "@earendil-works/pi-ai";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	fuzzyFilter,
	Input,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { ExecutorConfig } from "../orchestration/coordinator.js";

const MAX_VISIBLE_MODELS = 10;
type MenuKeybindings = Pick<KeybindingsManager, "matches">;

function isCurrentModel(model: Model<Api>, current: ExecutorConfig): boolean {
	return model.provider === current.provider && model.id === current.model;
}

function searchText(model: Model<Api>): string {
	const name = model.name ? ` ${model.name}` : "";
	return `${model.provider} ${model.provider}/${model.id} ${model.provider} ${model.id}${name}`;
}

/**
 * Prewalk's model picker mirrors Pi's native searchable model flow without
 * changing Pi's own default model setting.
 */
export class PrewalkModelPicker implements Component, Focusable {
	private readonly input = new Input();
	private readonly models: Model<Api>[];
	private filtered: Model<Api>[];
	private selectedIndex = 0;
	private _focused = false;

	constructor(
		models: readonly Model<Api>[],
		private readonly current: ExecutorConfig,
		private readonly theme: Theme,
		private readonly keybindings: MenuKeybindings,
		private readonly onSelect: (model: Model<Api>) => void,
		private readonly onCancel: () => void,
	) {
		this.models = models
			.filter((model) => model.maxTokens > 0)
			.sort((left, right) => {
				const leftCurrent = isCurrentModel(left, current);
				const rightCurrent = isCurrentModel(right, current);
				if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
				return `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`);
			});
		this.filtered = this.models;
		this.input.onSubmit = () => this.selectCurrent();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	render(width: number): string[] {
		const lines = [
			this.theme.fg("muted", "Type a provider, model name, or model ID:"),
			...this.input.render(width),
			"",
		];
		if (this.filtered.length === 0) {
			lines.push(this.theme.fg("muted", "  No matching models"));
		} else {
			const startIndex = Math.max(
				0,
				Math.min(
					this.selectedIndex - Math.floor(MAX_VISIBLE_MODELS / 2),
					this.filtered.length - MAX_VISIBLE_MODELS,
				),
			);
			const endIndex = Math.min(startIndex + MAX_VISIBLE_MODELS, this.filtered.length);
			for (let index = startIndex; index < endIndex; index += 1) {
				const model = this.filtered[index];
				if (!model) continue;
				const selected = index === this.selectedIndex;
				const marker = selected ? this.theme.fg("accent", "→ ") : "  ";
				const modelName = selected ? this.theme.fg("accent", model.id) : model.id;
				const provider = this.theme.fg("muted", `[${model.provider}]`);
				const current = isCurrentModel(model, this.current)
					? this.theme.fg("success", " ✓ current")
					: "";
				lines.push(truncateToWidth(`${marker}${modelName} ${provider}${current}`, width));
			}
			if (startIndex > 0 || endIndex < this.filtered.length) {
				lines.push(
					this.theme.fg(
						"muted",
						`  ${this.selectedIndex + 1} of ${this.filtered.length} matching models`,
					),
				);
			}
			const selected = this.filtered[this.selectedIndex];
			if (selected?.name && selected.name !== selected.id) {
				lines.push("", this.theme.fg("muted", `  ${selected.name}`));
			}
		}
		lines.push(
			"",
			this.theme.fg(
				"muted",
				"Type to filter · ↑↓ move · PgUp/PgDn jump · Enter choose · Esc back",
			),
		);
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {
		this.input.invalidate();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1, true);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1, true);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-MAX_VISIBLE_MODELS, false);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.moveSelection(MAX_VISIBLE_MODELS, false);
			return;
		}
		if (
			this.keybindings.matches(data, "tui.select.confirm") ||
			this.keybindings.matches(data, "tui.input.submit")
		) {
			this.selectCurrent();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		}
		this.input.handleInput(data);
		this.filtered = this.input.getValue()
			? fuzzyFilter(this.models, this.input.getValue(), searchText)
			: this.models;
		this.selectedIndex = 0;
	}

	private moveSelection(delta: number, wrap: boolean): void {
		if (this.filtered.length === 0) return;
		if (wrap && Math.abs(delta) === 1) {
			this.selectedIndex =
				(this.selectedIndex + delta + this.filtered.length) % this.filtered.length;
			return;
		}
		this.selectedIndex = Math.max(
			0,
			Math.min(this.filtered.length - 1, this.selectedIndex + delta),
		);
	}

	private selectCurrent(): void {
		const selected = this.filtered[this.selectedIndex];
		if (selected) this.onSelect(selected);
	}
}
