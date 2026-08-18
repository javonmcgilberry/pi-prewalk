import path from "node:path";
import { isRecord } from "../guards.js";
import { PREWALK_TODO_TOOL_NAME } from "./todo.js";

export type MutationKind = "edit" | "write" | "apply_patch";
export type MutationSource =
	| "builtin"
	| "direct"
	| "shell"
	| "exec_command"
	| "code_mode"
	| "adapter";

export interface MutationCandidate {
	toolCallId: string;
	toolName: string;
	kind: MutationKind;
	source: MutationSource;
	cellId?: string;
	traceId?: string;
	sessionId?: number;
	paths?: string[];
}

export interface MutationToolResult {
	toolCallId: string;
	toolName: string;
	input: unknown;
	isError: boolean;
	details?: unknown;
}

export interface MutationExecutionUpdate {
	toolCallId: string;
	toolName: string;
	args: unknown;
	partialResult: unknown;
}

export interface MutationTurnOptions {
	todoActive: boolean;
	todoSeen: boolean;
	ignoreExtensions?: readonly string[];
}

export interface MutationTurnEvidence {
	todoSucceeded: boolean;
	mutation?: MutationCandidate;
}

/**
 * A source-owned integration explicitly claims one otherwise unknown tool and
 * classifies its terminal result. The buffer keeps event identity and
 * provenance authoritative; returning undefined is a fail-closed decision.
 */
export interface MutationEvidenceAdapter {
	readonly toolName: string;
	kindFor(result: Readonly<MutationToolResult>): MutationKind | undefined;
}

export const RECOGNIZED_MUTATION_TOOL_NAMES = [
	"edit",
	"write",
	"apply_patch",
	"bash",
	"exec_command",
	"exec",
] as const;
const RECOGNIZED_MUTATION_TOOL_SET = new Set<string>(RECOGNIZED_MUTATION_TOOL_NAMES);

/** Returns whether the active tool slate can produce a recognized proving edit. */
export function hasRecognizedMutationPath(toolNames: readonly string[]): boolean {
	return toolNames.some((toolName) => RECOGNIZED_MUTATION_TOOL_SET.has(toolName));
}

interface CodeModeTrace {
	id: string;
	name: string;
	input: unknown;
	status: string;
	result?: unknown;
}

interface CodeModeCell {
	status?: string;
	scriptError?: string;
	traces: Map<string, CodeModeTrace>;
}

interface ShellToken {
	kind: "word" | "operator";
	value: string;
	quoted: boolean;
}

function stringField(value: unknown, field: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const fieldValue = value[field];
	return typeof fieldValue === "string" ? fieldValue : undefined;
}

function numberField(value: unknown, field: string): number | undefined {
	if (!isRecord(value)) return undefined;
	const fieldValue = value[field];
	return typeof fieldValue === "number" ? fieldValue : undefined;
}

function codeModeDetails(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	const details = isRecord(value.details) ? value.details : value;
	return details.codeMode === true ? details : undefined;
}

function traceFrom(value: unknown): CodeModeTrace | undefined {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.name !== "string" ||
		typeof value.status !== "string"
	) {
		return undefined;
	}
	return {
		id: value.id,
		name: value.name,
		input: value.input,
		status: value.status,
		...(value.result === undefined ? {} : { result: value.result }),
	};
}

function commandFrom(input: unknown, field: "command" | "cmd"): string | undefined {
	return stringField(input, field);
}

function successfulExit(details: unknown): boolean {
	return (
		numberField(details, "exit_code") === 0 && numberField(details, "session_id") === undefined
	);
}

function successfulPatchDetails(details: unknown): boolean {
	return stringField(details, "status") === "success";
}

function stringArrayField(value: unknown, field: string): string[] | undefined {
	if (!isRecord(value) || !Array.isArray(value[field])) return undefined;
	const entries = value[field];
	return entries.every((entry) => typeof entry === "string") ? entries : undefined;
}

function changedFilesFromDetails(details: unknown): string[] | undefined {
	if (!isRecord(details)) return undefined;
	return (
		stringArrayField(details, "changedFiles") ??
		stringArrayField(isRecord(details.result) ? details.result : undefined, "changedFiles")
	);
}

function patchPaths(value: unknown): string[] | undefined {
	if (typeof value !== "string") return undefined;
	const paths: string[] = [];
	for (const line of value.split(/\r?\n/)) {
		const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
		const move = /^\*\*\* Move to: (.+)$/.exec(line);
		const candidate = match?.[1] ?? move?.[1];
		if (candidate) paths.push(candidate);
	}
	return paths.length > 0 ? [...new Set(paths)] : undefined;
}

function patchPathsFromInput(
	input: unknown,
	commandField?: "command" | "cmd",
): string[] | undefined {
	if (commandField) return patchPaths(commandFrom(input, commandField));
	return patchPaths(stringField(input, "patch"));
}

function editPath(input: unknown): string[] | undefined {
	const filePath = stringField(input, "path") ?? stringField(input, "file_path");
	return filePath ? [filePath] : undefined;
}

function isIgnoredMutation(candidate: MutationCandidate, extensions: readonly string[]): boolean {
	if (!candidate.paths || candidate.paths.length === 0 || extensions.length === 0) return false;
	const ignored = new Set(extensions.map((extension) => extension.toLowerCase()));
	return candidate.paths.every((filePath) => ignored.has(path.extname(filePath).toLowerCase()));
}

function stripHeredocBodies(command: string): string {
	const lines = command.split(/\r?\n/);
	const output: string[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		output.push(line);
		const match = line.match(
			/<<-?\s*(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\1|([A-Za-z_][A-Za-z0-9_]*))/,
		);
		const delimiter = match?.[2] ?? match?.[3];
		if (!delimiter) continue;
		index += 1;
		while (index < lines.length && (lines[index] ?? "").trim() !== delimiter) index += 1;
	}
	return output.join("\n");
}

function tokenizeShell(command: string): ShellToken[] | undefined {
	if (command.includes("$(") || command.includes("`")) return undefined;
	const source = stripHeredocBodies(command);
	const tokens: ShellToken[] = [];
	let word = "";
	let quoted = false;
	let quote = "";
	let escaped = false;
	const flush = () => {
		if (!word) return;
		tokens.push({ kind: "word", value: word, quoted });
		word = "";
		quoted = false;
	};
	for (let index = 0; index < source.length; index += 1) {
		const current = source[index] ?? "";
		const next = source[index + 1];
		if (quote) {
			quoted = true;
			if (escaped) {
				word += current;
				escaped = false;
			} else if (current === "\\") {
				escaped = true;
			} else if (current === quote) {
				quote = "";
			} else {
				word += current;
			}
			continue;
		}
		if (current === "'" || current === '"') {
			quote = current;
			quoted = true;
			continue;
		}
		if (current === "\\") {
			quoted = true;
			if (next !== undefined) {
				word += next;
				index += 1;
			}
			continue;
		}
		if (current === "#" && word === "") {
			while (index + 1 < source.length && source[index + 1] !== "\n") index += 1;
			continue;
		}
		if (/\s/.test(current)) {
			flush();
			if (current === "\n") tokens.push({ kind: "operator", value: "\n", quoted: false });
			continue;
		}
		if (";&|".includes(current)) {
			flush();
			const pair = `${current}${next ?? ""}`;
			const value = pair === "&&" || pair === "||" || pair === "|&" ? pair : current;
			tokens.push({ kind: "operator", value, quoted: false });
			if (value.length === 2) index += 1;
			continue;
		}
		word += current;
	}
	if (quote || escaped) return undefined;
	flush();
	return tokens;
}

export function hasProvableApplyPatch(command: string): boolean {
	const tokens = tokenizeShell(command);
	if (!tokens) return false;
	let commandPosition = true;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token) continue;
		if (token.kind === "operator") {
			commandPosition = true;
			continue;
		}
		if (commandPosition && token.value === "apply_patch" && !token.quoted) {
			const suffix = tokens.slice(index + 1);
			const unsafe = suffix.some((candidate, candidateIndex) => {
				if (candidate.kind !== "operator") return false;
				if (
					candidate.value === "|" ||
					candidate.value === "|&" ||
					candidate.value === "||" ||
					candidate.value === ";"
				)
					return true;
				if (candidate.value !== "\n") return false;
				return suffix
					.slice(candidateIndex + 1)
					.some((next) => !(next.kind === "operator" && next.value === "\n"));
			});
			return !unsafe;
		}
		if (commandPosition && /^[A-Za-z_][A-Za-z0-9_]*=[^$]*$/.test(token.value) && !token.quoted) {
			continue;
		}
		commandPosition = false;
	}
	return false;
}

function assistantCalls(message: unknown): Array<{ id: string; name: string }> {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content))
		return [];
	const calls: Array<{ id: string; name: string }> = [];
	for (const item of message.content) {
		if (
			isRecord(item) &&
			item.type === "toolCall" &&
			typeof item.id === "string" &&
			typeof item.name === "string"
		) {
			calls.push({ id: item.id, name: item.name });
		}
	}
	return calls;
}

export class MutationTurnBuffer {
	private readonly results = new Map<string, MutationToolResult>();
	private readonly cells = new Map<string, CodeModeCell>();
	private readonly directSessions = new Map<number, string[] | undefined>();
	private readonly codeModeSessions = new Map<number, string[] | undefined>();
	private readonly adapters: readonly MutationEvidenceAdapter[];
	private triggerChosen = false;

	constructor(adapters: readonly MutationEvidenceAdapter[] = []) {
		this.adapters = [...adapters];
	}

	resetForRun(): void {
		this.results.clear();
		this.cells.clear();
		this.directSessions.clear();
		this.codeModeSessions.clear();
		this.triggerChosen = false;
	}

	recordExecutionUpdate(event: MutationExecutionUpdate): void {
		const details = codeModeDetails(event.partialResult);
		if (details) this.mergeCodeModeDetails(details);
	}

	recordResult(event: MutationToolResult): void {
		this.results.set(event.toolCallId, event);
		const details = codeModeDetails(event.details);
		if (details) this.mergeCodeModeDetails(details);
		if (event.isError || event.toolName !== "exec_command") return;
		const command = commandFrom(event.input, "cmd");
		const sessionId = numberField(event.details, "session_id");
		if (command && sessionId !== undefined && hasProvableApplyPatch(command)) {
			this.directSessions.set(sessionId, patchPaths(command));
		}
	}

	finishTurn(message: unknown, options: MutationTurnOptions): MutationTurnEvidence {
		const todoSucceeded = [...this.results.values()].some(
			(result) => result.toolName === PREWALK_TODO_TOOL_NAME && !result.isError,
		);
		let mutation: MutationCandidate | undefined;
		if (!this.triggerChosen && (!options.todoActive || options.todoSeen || todoSucceeded)) {
			for (const call of assistantCalls(message)) {
				const result = this.results.get(call.id);
				if (!result || result.toolName !== call.name) continue;
				mutation = this.candidateFor(result);
				if (mutation && !isIgnoredMutation(mutation, options.ignoreExtensions ?? [])) {
					this.triggerChosen = true;
					break;
				}
				mutation = undefined;
			}
		}
		this.cleanupTurn();
		const publicMutation = mutation
			? (({ paths: _paths, ...candidate }) => candidate)(mutation)
			: undefined;
		const evidence: MutationTurnEvidence = { todoSucceeded };
		if (publicMutation) evidence.mutation = publicMutation;
		return evidence;
	}

	private mergeCodeModeDetails(details: Record<string, unknown>): void {
		const cellId = typeof details.cellId === "string" ? details.cellId : undefined;
		if (!cellId) return;
		const cell = this.cells.get(cellId) ?? { traces: new Map<string, CodeModeTrace>() };
		if (typeof details.status === "string") cell.status = details.status;
		if (typeof details.scriptError === "string") cell.scriptError = details.scriptError;
		if (Array.isArray(details.traces)) {
			for (const value of details.traces) {
				const trace = traceFrom(value);
				if (!trace) continue;
				cell.traces.set(trace.id, trace);
				if (trace.name !== "exec_command" || trace.status !== "done") continue;
				const command = commandFrom(trace.input, "cmd");
				const resultDetails = isRecord(trace.result) ? trace.result.details : undefined;
				const sessionId = numberField(resultDetails, "session_id");
				if (command && sessionId !== undefined && hasProvableApplyPatch(command)) {
					this.codeModeSessions.set(sessionId, patchPaths(command));
				}
			}
		}
		this.cells.set(cellId, cell);
	}

	private candidateFor(result: MutationToolResult): MutationCandidate | undefined {
		if (result.isError) return undefined;
		if (result.toolName === "edit" || result.toolName === "write") {
			return {
				toolCallId: result.toolCallId,
				toolName: result.toolName,
				kind: result.toolName,
				source: "builtin",
				paths: editPath(result.input),
			};
		}
		if (result.toolName === "apply_patch") {
			const paths = changedFilesFromDetails(result.details) ?? patchPathsFromInput(result.input);
			return successfulPatchDetails(result.details)
				? {
						toolCallId: result.toolCallId,
						toolName: result.toolName,
						kind: "apply_patch",
						source: "direct",
						paths,
					}
				: undefined;
		}
		if (result.toolName === "bash") {
			const command = commandFrom(result.input, "command");
			return command && hasProvableApplyPatch(command)
				? {
						toolCallId: result.toolCallId,
						toolName: result.toolName,
						kind: "apply_patch",
						source: "shell",
						paths: patchPathsFromInput(result.input, "command"),
					}
				: undefined;
		}
		if (result.toolName === "exec_command") {
			const command = commandFrom(result.input, "cmd");
			return command && successfulExit(result.details) && hasProvableApplyPatch(command)
				? {
						toolCallId: result.toolCallId,
						toolName: result.toolName,
						kind: "apply_patch",
						source: "exec_command",
						paths: patchPathsFromInput(result.input, "cmd"),
					}
				: undefined;
		}
		if (result.toolName === "write_stdin") {
			const sessionId = numberField(result.input, "session_id");
			return sessionId !== undefined &&
				this.directSessions.has(sessionId) &&
				successfulExit(result.details)
				? {
						toolCallId: result.toolCallId,
						toolName: result.toolName,
						kind: "apply_patch",
						source: "exec_command",
						sessionId,
						paths: this.directSessions.get(sessionId),
					}
				: undefined;
		}
		if (result.toolName === "exec" || result.toolName === "wait") {
			const details = codeModeDetails(result.details);
			const cellId = details && typeof details.cellId === "string" ? details.cellId : undefined;
			const cell = cellId ? this.cells.get(cellId) : undefined;
			if (!cellId || !cell || cell.status !== "result" || cell.scriptError) return undefined;
			for (const trace of cell.traces.values()) {
				const traceCandidate = this.codeModeTraceCandidate(result, cellId, trace);
				if (traceCandidate) return traceCandidate;
			}
			return undefined;
		}
		for (const adapter of this.adapters) {
			if (adapter.toolName !== result.toolName) continue;
			const kind = adapter.kindFor(result);
			if (!kind) continue;
			return {
				toolCallId: result.toolCallId,
				toolName: result.toolName,
				kind,
				source: "adapter",
			};
		}
		return undefined;
	}

	private codeModeTraceCandidate(
		outer: MutationToolResult,
		cellId: string,
		trace: CodeModeTrace,
	): MutationCandidate | undefined {
		if (trace.status !== "done") return undefined;
		const resultDetails = isRecord(trace.result) ? trace.result.details : undefined;
		if (trace.name === "apply_patch" && successfulPatchDetails(resultDetails)) {
			const paths = changedFilesFromDetails(resultDetails) ?? patchPathsFromInput(trace.input);
			return {
				toolCallId: outer.toolCallId,
				toolName: outer.toolName,
				kind: "apply_patch",
				source: "code_mode",
				cellId,
				traceId: trace.id,
				paths,
			};
		}
		if (trace.name === "exec_command") {
			const command = commandFrom(trace.input, "cmd");
			if (!command || !successfulExit(resultDetails) || !hasProvableApplyPatch(command))
				return undefined;
			return {
				toolCallId: outer.toolCallId,
				toolName: outer.toolName,
				kind: "apply_patch",
				source: "code_mode",
				cellId,
				traceId: trace.id,
				paths: patchPathsFromInput(trace.input, "cmd"),
			};
		}
		if (trace.name !== "write_stdin") return undefined;
		const sessionId = numberField(trace.input, "session_id");
		if (
			sessionId === undefined ||
			!this.codeModeSessions.has(sessionId) ||
			!successfulExit(resultDetails)
		) {
			return undefined;
		}
		return {
			toolCallId: outer.toolCallId,
			toolName: outer.toolName,
			kind: "apply_patch",
			source: "code_mode",
			cellId,
			traceId: trace.id,
			sessionId,
			paths: this.codeModeSessions.get(sessionId),
		};
	}

	private cleanupTurn(): void {
		for (const result of this.results.values()) {
			const details = codeModeDetails(result.details);
			const cellId = details && typeof details.cellId === "string" ? details.cellId : undefined;
			if (cellId && stringField(details, "status") !== "yielded") this.cells.delete(cellId);
			if (
				result.toolName === "write_stdin" &&
				numberField(result.details, "session_id") === undefined
			) {
				const sessionId = numberField(result.input, "session_id");
				if (sessionId !== undefined) this.directSessions.delete(sessionId);
			}
		}
		this.results.clear();
	}
}
