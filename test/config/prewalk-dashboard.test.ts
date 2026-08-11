import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ANALYTICS_CONFIG } from "../../src/analytics/index.js";
import { PrewalkModelPicker } from "../../src/config/model-picker.js";
import {
	PrewalkConfigureComponent,
	showPrewalkConfigureMenu,
} from "../../src/config/prewalk-dashboard.js";
import type { PrewalkConfig } from "../../src/orchestration/coordinator.js";

const ENTER = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";

function model(id: string, provider = "fixture"): Model<"openai-codex-responses"> {
	return {
		id,
		name: id.replaceAll("-", " "),
		api: "openai-codex-responses",
		provider,
		baseUrl: "https://fixture.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 128_000,
	};
}

const theme = {
	fg: (_tone: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function tui() {
	return { requestRender: vi.fn() } as unknown as TUI;
}

function initialConfig(): PrewalkConfig {
	return {
		executor: { provider: "fixture", model: "executor", reasoning: "low" },
		analytics: structuredClone(DEFAULT_ANALYTICS_CONFIG),
		children: { agents: { worker: false } },
	};
}

function component(overrides: Partial<{ onSave: (config: PrewalkConfig) => Promise<void> }> = {}) {
	const done = vi.fn();
	const onSave = overrides.onSave ?? vi.fn(async () => undefined);
	const instance = new PrewalkConfigureComponent(
		{
			ctx: { thinkingLevel: "high" } as ExtensionContext,
			initial: initialConfig(),
			models: [model("planner"), model("executor"), model("target")],
			planner: model("planner"),
			onSave,
		},
		tui(),
		theme,
		getKeybindings(),
		done,
	);
	instance.focused = true;
	return { instance, done, onSave };
}

function press(component: PrewalkConfigureComponent, ...keys: string[]): void {
	for (const key of keys) component.handleInput(key);
}

describe("Prewalk model picker", () => {
	it("uses Pi-style live fuzzy search instead of paginated model pages", () => {
		const models = Array.from({ length: 42 }, (_, index) =>
			model(`candidate-${String(index).padStart(2, "0")}`),
		);
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const picker = new PrewalkModelPicker(
			models,
			{ provider: "fixture", model: "candidate-00", reasoning: "low" },
			theme,
			getKeybindings(),
			onSelect,
			onCancel,
		);

		for (const character of "candidate 31") picker.handleInput(character);
		const rendered = picker.render(100).join("\n");

		expect(rendered).toContain("candidate-31");
		expect(rendered).not.toContain("Previous page");
		expect(rendered).not.toContain("Next page");
		picker.handleInput(ENTER);
		expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "candidate-31" }));
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("treats printable letters as search text and Escape as the only cancel path", () => {
		const onCancel = vi.fn();
		const picker = new PrewalkModelPicker(
			[model("executor"), model("qwen-coder")],
			{ provider: "fixture", model: "executor", reasoning: "low" },
			theme,
			getKeybindings(),
			vi.fn(),
			onCancel,
		);

		for (const character of "qwen") picker.handleInput(character);
		expect(picker.render(80).join("\n")).toContain("qwen-coder");
		expect(onCancel).not.toHaveBeenCalled();
		picker.handleInput(ESCAPE);
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it("ranks an exact provider/model match ahead of proxy-provider IDs", () => {
		const onSelect = vi.fn();
		const picker = new PrewalkModelPicker(
			[model("openai/gpt-5", "openrouter"), model("gpt-5", "openai")],
			{ provider: "fixture", model: "executor", reasoning: "low" },
			theme,
			getKeybindings(),
			onSelect,
			vi.fn(),
		);

		for (const character of "openai/gpt-5") picker.handleInput(character);
		picker.handleInput(ENTER);

		expect(onSelect).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "openai", id: "gpt-5" }),
		);
	});

	it("honors a custom input-submit binding independently from list confirmation", () => {
		const defaults = getKeybindings();
		const keybindings = {
			matches(data: string, id: Parameters<typeof defaults.matches>[1]) {
				if (data === "custom-submit") return id === "tui.input.submit";
				return defaults.matches(data, id);
			},
		};
		const onSelect = vi.fn();
		const picker = new PrewalkModelPicker(
			[model("executor"), model("target")],
			{ provider: "fixture", model: "executor", reasoning: "low" },
			theme,
			keybindings,
			onSelect,
			vi.fn(),
		);

		for (const character of "target") picker.handleInput(character);
		picker.handleInput("custom-submit");

		expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "target" }));
	});
});

describe("Prewalk configuration menu", () => {
	it("resolves on Escape and can be opened again immediately", async () => {
		const custom = vi.fn(
			async <T>(
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: ReturnType<typeof getKeybindings>,
					done: (result: T) => void,
				) => PrewalkConfigureComponent,
			) =>
				new Promise<T>((resolve) => {
					const menu = factory(tui(), theme, getKeybindings(), resolve);
					menu.handleInput(ESCAPE);
				}),
		);
		const options = {
			ctx: { ui: { custom }, thinkingLevel: "high" } as unknown as ExtensionContext,
			initial: initialConfig(),
			models: [model("planner"), model("executor")],
			planner: model("planner"),
			onSave: vi.fn(async () => undefined),
		};

		await expect(showPrewalkConfigureMenu(options)).resolves.toBe("cancelled");
		await expect(showPrewalkConfigureMenu(options)).resolves.toBe("cancelled");
		expect(custom).toHaveBeenCalledTimes(2);
	});

	it("keeps model, effort, confirmation, and save inside one custom component", async () => {
		const saved: PrewalkConfig[] = [];
		const save = vi.fn(async (config: PrewalkConfig) => {
			saved.push(config);
		});
		const { instance, done, onSave } = component({
			onSave: save,
		});

		press(instance, ENTER, ENTER);
		for (const character of "target") instance.handleInput(character);
		press(instance, ENTER, DOWN, ENTER, DOWN, ENTER, ESCAPE, DOWN, DOWN, DOWN, ENTER, ENTER);
		await vi.waitFor(() => expect(done).toHaveBeenCalledWith("saved"));

		expect(onSave).toHaveBeenCalledOnce();
		expect(saved[0]).toMatchObject({
			executor: { provider: "fixture", model: "target", reasoning: "medium" },
		});
	});

	it("backs out one level and confirms before discarding a changed draft", () => {
		const { instance, done } = component();

		press(instance, DOWN, DOWN, ENTER, ENTER, ESCAPE, ESCAPE);
		expect(instance.render(100).join("\n")).toContain("Discard changes?");
		expect(done).not.toHaveBeenCalled();

		press(instance, ENTER, ESCAPE, DOWN, ENTER);
		expect(done).toHaveBeenCalledWith("cancelled");
	});

	it("allows printable input in add-agent mode and keeps help recoverable", () => {
		const { instance, done } = component();

		press(instance, "?", ESCAPE, DOWN, ENTER, DOWN, ENTER);
		for (const character of "qa-agent") instance.handleInput(character);
		press(instance, ENTER, ESCAPE);

		const rendered = instance.render(100).join("\n");
		expect(rendered).toContain("qa-agent");
		expect(rendered).toContain("Off");
		expect(done).not.toHaveBeenCalled();
	});

	it("keeps focus on Turn off when a custom child policy is disabled", () => {
		const { instance, done } = component();

		press(instance, DOWN, ENTER, ENTER, "\x1b[A", ENTER);
		for (const character of "target") instance.handleInput(character);
		press(instance, ENTER, DOWN, DOWN, ENTER);

		expect(instance.render(100).join("\n")).toContain("→ Turn off  ✓ current");
		press(instance, ENTER);
		expect(done).not.toHaveBeenCalled();
		expect(instance.render(100).join("\n")).toContain("→ Turn off  ✓ current");
	});

	it("rejects a no-op main target without saving or closing the draft", () => {
		const { instance, done, onSave } = component();

		press(instance, ENTER, ENTER);
		for (const character of "planner") instance.handleInput(character);
		press(
			instance,
			ENTER,
			DOWN,
			ENTER,
			DOWN,
			DOWN,
			ENTER,
			ESCAPE,
			DOWN,
			DOWN,
			DOWN,
			ENTER,
			ENTER,
		);

		expect(instance.render(100).join("\n")).toContain(
			"current planner at the same effective effort",
		);
		expect(onSave).not.toHaveBeenCalled();
		expect(done).not.toHaveBeenCalled();
	});
});
