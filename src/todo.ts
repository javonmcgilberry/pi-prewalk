import { isRecord } from "./guards.js";

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
export type TodoOperation =
	| "init"
	| "start"
	| "done"
	| "rm"
	| "drop"
	| "block"
	| "unblock"
	| "append"
	| "view";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	blocker?: string;
}

export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

export interface TodoInput {
	op: TodoOperation;
	list?: Array<{ phase: string; items: string[] }>;
	task?: string;
	phase?: string;
	items?: string[];
	reason?: string;
}

export interface TodoCompletionTransition {
	phase: string;
	content: string;
}

export interface TodoSnapshot {
	op: TodoOperation;
	phases: TodoPhase[];
	completedTasks?: TodoCompletionTransition[];
}

export interface TodoResult {
	isError: boolean;
	text: string;
	details: TodoSnapshot;
}

function cloneTask(task: TodoItem): TodoItem {
	return task.blocker === undefined
		? { content: task.content, status: task.status }
		: { content: task.content, status: task.status, blocker: task.blocker };
}

function cloneTodoPhases(phases: readonly TodoPhase[]): TodoPhase[] {
	return phases.map((phase) => ({
		name: phase.name,
		tasks: phase.tasks.map(cloneTask),
	}));
}

function isStatus(value: unknown): value is TodoStatus {
	return (
		value === "pending" ||
		value === "in_progress" ||
		value === "completed" ||
		value === "abandoned" ||
		value === "blocked"
	);
}

function isTodoPhase(value: unknown): value is TodoPhase {
	if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.tasks)) {
		return false;
	}
	return value.tasks.every((task) => {
		if (!isRecord(task) || typeof task.content !== "string" || !isStatus(task.status)) {
			return false;
		}
		return task.blocker === undefined || typeof task.blocker === "string";
	});
}

function normalize(phases: TodoPhase[]): void {
	const tasks = phases.flatMap((phase) => phase.tasks);
	let activeFound = false;
	for (const task of tasks) {
		if (task.status !== "in_progress") continue;
		if (!activeFound) {
			activeFound = true;
		} else {
			task.status = "pending";
		}
	}
	if (activeFound) return;
	const next = tasks.find((task) => task.status === "pending");
	if (next) next.status = "in_progress";
}

function findTask(
	phases: TodoPhase[],
	content: string,
): { phase: TodoPhase; task: TodoItem } | undefined {
	for (const phase of phases) {
		const task = phase.tasks.find((candidate) => candidate.content === content);
		if (task) return { phase, task };
	}
	return undefined;
}

function taskTargets(phases: TodoPhase[], input: TodoInput): TodoItem[] {
	if (input.task) {
		const hit = findTask(phases, input.task);
		if (!hit) throw new Error(`Task "${input.task}" not found.`);
		return [hit.task];
	}
	if (input.phase) {
		const phase = phases.find((candidate) => candidate.name === input.phase);
		if (!phase) throw new Error(`Phase "${input.phase}" not found.`);
		return phase.tasks;
	}
	return phases.flatMap((phase) => phase.tasks);
}

function initialPhases(input: TodoInput): TodoPhase[] {
	const list =
		input.list ??
		(input.items && input.items.length > 0
			? [{ phase: input.phase ?? "Tasks", items: input.items }]
			: undefined);
	if (!list || list.length === 0) throw new Error("Missing list for init operation.");

	const phaseNames = new Set<string>();
	const taskNames = new Set<string>();
	const phases = list.map((entry) => {
		const phaseName = entry.phase.trim();
		if (!phaseName) throw new Error("Todo phase names must not be empty.");
		if (phaseNames.has(phaseName)) throw new Error(`Duplicate phase "${phaseName}".`);
		phaseNames.add(phaseName);
		if (entry.items.length === 0) throw new Error(`Phase "${phaseName}" has no tasks.`);
		const tasks: TodoItem[] = entry.items.map((value) => {
			const content = value.trim();
			if (!content) throw new Error("Todo task content must not be empty.");
			if (taskNames.has(content)) throw new Error(`Duplicate task "${content}".`);
			taskNames.add(content);
			return { content, status: "pending" };
		});
		return { name: phaseName, tasks };
	});
	normalize(phases);
	return phases;
}

function completedTransitions(
	previous: readonly TodoPhase[],
	current: readonly TodoPhase[],
): TodoCompletionTransition[] {
	const oldStatuses = new Map<string, TodoStatus>();
	for (const phase of previous) {
		for (const task of phase.tasks) {
			oldStatuses.set(`${phase.name}\0${task.content}`, task.status);
		}
	}
	const completed: TodoCompletionTransition[] = [];
	for (const phase of current) {
		for (const task of phase.tasks) {
			const oldStatus = oldStatuses.get(`${phase.name}\0${task.content}`);
			if (task.status === "completed" && oldStatus && oldStatus !== "completed") {
				completed.push({ phase: phase.name, content: task.content });
			}
		}
	}
	return completed;
}

function remainingText(phases: readonly TodoPhase[]): string {
	const open = phases.flatMap((phase) =>
		phase.tasks
			.filter(
				(task) =>
					task.status === "pending" ||
					task.status === "in_progress" ||
					task.status === "blocked",
			)
			.map((task) => `${task.content} [${task.status}] (${phase.name})`),
	);
	return open.length === 0
		? "Remaining items: none."
		: `Remaining items (${open.length}):\n${open.map((item) => `- ${item}`).join("\n")}`;
}

function applyMutation(phases: TodoPhase[], input: TodoInput): void {
	switch (input.op) {
		case "start": {
			if (!input.task) throw new Error("start requires a task.");
			const hit = findTask(phases, input.task);
			if (!hit) throw new Error(`Task "${input.task}" not found.`);
			for (const task of phases.flatMap((phase) => phase.tasks)) {
				if (task.status === "in_progress") task.status = "pending";
			}
			hit.task.status = "in_progress";
			hit.task.blocker = undefined;
			return;
		}
		case "done":
			for (const task of taskTargets(phases, input)) {
				task.status = "completed";
				task.blocker = undefined;
			}
			return;
		case "drop":
			for (const task of taskTargets(phases, input)) {
				if (task.status !== "completed") task.status = "abandoned";
				task.blocker = undefined;
			}
			return;
		case "block": {
			if (!input.task && !input.phase) throw new Error("block requires a task or phase target.");
			const blocker = input.reason?.replace(/\s+/g, " ").trim();
			for (const task of taskTargets(phases, input)) {
				if (
					task.status === "pending" ||
					task.status === "in_progress" ||
					task.status === "blocked"
				) {
					task.status = "blocked";
					task.blocker = blocker || undefined;
				}
			}
			return;
		}
		case "unblock":
			if (!input.task && !input.phase)
				throw new Error("unblock requires a task or phase target.");
			for (const task of taskTargets(phases, input)) {
				if (task.status === "blocked") {
					task.status = "pending";
					task.blocker = undefined;
				}
			}
			return;
		case "rm": {
			if (input.task) {
				const hit = findTask(phases, input.task);
				if (!hit) throw new Error(`Task "${input.task}" not found.`);
				hit.phase.tasks = hit.phase.tasks.filter((task) => task !== hit.task);
			} else if (input.phase) {
				const phase = phases.find((candidate) => candidate.name === input.phase);
				if (!phase) throw new Error(`Phase "${input.phase}" not found.`);
				phase.tasks = [];
			} else {
				for (const phase of phases) phase.tasks = [];
			}
			return;
		}
		case "append": {
			if (!input.phase) throw new Error("append requires a phase.");
			if (!input.items || input.items.length === 0) throw new Error("append requires items.");
			let phase = phases.find((candidate) => candidate.name === input.phase);
			if (!phase) {
				phase = { name: input.phase, tasks: [] };
				phases.push(phase);
			}
			const existing = new Set(
				phases.flatMap((candidate) => candidate.tasks.map((task) => task.content)),
			);
			const pending: TodoItem[] = [];
			for (const raw of input.items) {
				const content = raw.trim();
				if (!content) throw new Error("Todo task content must not be empty.");
				if (existing.has(content)) throw new Error(`Task "${content}" already exists.`);
				existing.add(content);
				pending.push({ content, status: "pending" });
			}
			phase.tasks.push(...pending);
			return;
		}
		case "init":
		case "view":
			return;
	}
}

export function applyTodoOperation(current: readonly TodoPhase[], input: TodoInput): TodoResult {
	const previous = cloneTodoPhases(current);
	try {
		const phases = input.op === "init" ? initialPhases(input) : cloneTodoPhases(current);
		if (input.op !== "init" && input.op !== "view") {
			applyMutation(phases, input);
			normalize(phases);
		}
		const completedTasks = completedTransitions(previous, phases);
		const details =
			completedTasks.length === 0
				? { op: input.op, phases }
				: { op: input.op, phases, completedTasks };
		return {
			isError: false,
			text:
				input.op === "rm" && phases.every((phase) => phase.tasks.length === 0)
					? "Todo list cleared."
					: remainingText(phases),
			details,
		};
	} catch (error) {
		return {
			isError: true,
			text: error instanceof Error ? error.message : "Todo operation failed.",
			details: { op: input.op, phases: previous },
		};
	}
}

export function latestTodoPhases(messages: readonly unknown[]): TodoPhase[] {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!isRecord(message) || message.role !== "toolResult" || message.toolName !== "todo")
			continue;
		if (
			message.isError === true ||
			!isRecord(message.details) ||
			!Array.isArray(message.details.phases)
		) {
			continue;
		}
		if (message.details.phases.every(isTodoPhase)) {
			return cloneTodoPhases(message.details.phases);
		}
	}
	return [];
}

export class TodoReminder {
	#remaining = 1;

	reset(): void {
		this.#remaining = 1;
	}

	next(phases: readonly TodoPhase[]): string | undefined {
		if (this.#remaining === 0) return undefined;
		const open = phases.flatMap((phase) =>
			phase.tasks.filter((task) => task.status === "pending" || task.status === "in_progress"),
		);
		if (open.length === 0) return undefined;
		this.#remaining -= 1;
		return `Complete the remaining ${open.length} todo ${open.length === 1 ? "item" : "items"} before finishing.`;
	}
}
