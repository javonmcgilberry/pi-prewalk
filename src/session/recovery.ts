import type { RejectedExecutor } from "../executor/selection.js";
import type { PrewalkRun } from "../orchestration/coordinator.js";
import {
	PREWALK_AUDIT_TYPE,
	PREWALK_AUTO_MODE_TYPE,
	type PrewalkAuditRecord,
	type PrewalkAutoModeRecord,
	parseAuditRecord,
	parseAutoModeRecord,
	runFromAudit,
} from "./audit.js";

export type NativeCompactionState = "disabled" | "enabled" | "invalid";

export type SessionRecoveryOutcome =
	| { type: "none" }
	| { type: "terminal"; record: PrewalkAuditRecord }
	| { type: "restart"; reason: "configuration-invalid" | "native-compaction-unsupported" }
	| { type: "refused"; run: PrewalkRun; rejected: readonly RejectedExecutor[] }
	| { type: "failed"; run: PrewalkRun; reason: "provider-unavailable" }
	| { type: "restored"; run: PrewalkRun; analyticsRestored: boolean };

export interface SessionRecoveryHost {
	nativeCompactionState(): NativeCompactionState;
	restoreRun(run: PrewalkRun): void;
	resolveExecutor(
		run: PrewalkRun,
	): Promise<{ ok: true } | { ok: false; rejected: readonly RejectedExecutor[] }>;
	installRuntime(run: PrewalkRun): void;
	restoreAnalyticsJournal(run: PrewalkRun): Promise<void>;
}

function isCustomEntry(value: unknown, customType: string): value is { data: unknown } {
	return (
		value !== null &&
		typeof value === "object" &&
		Reflect.get(value, "type") === "custom" &&
		Reflect.get(value, "customType") === customType &&
		"data" in value
	);
}

/** Returns the latest valid audit entry, ignoring unrelated or malformed data. */
export function latestAuditRecord(entries: readonly unknown[]): PrewalkAuditRecord | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isCustomEntry(entry, PREWALK_AUDIT_TYPE)) continue;
		const record = parseAuditRecord(entry.data);
		if (record) return record;
	}
	return undefined;
}

export function latestAutoModeRecord(
	entries: readonly unknown[],
): PrewalkAutoModeRecord | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isCustomEntry(entry, PREWALK_AUTO_MODE_TYPE)) continue;
		const record = parseAutoModeRecord(entry.data);
		if (record) return record;
	}
	return undefined;
}

export function latestPrewalkToolSlate(
	entries: readonly unknown[],
	runId: string,
): string[] | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isCustomEntry(entry, "prewalk-tool-slate")) continue;
		const data = entry.data;
		if (data === null || typeof data !== "object" || Reflect.get(data, "runId") !== runId) {
			continue;
		}
		const tools = Reflect.get(data, "tools");
		if (Array.isArray(tools) && tools.every((name) => typeof name === "string")) {
			return [...tools];
		}
	}
	return undefined;
}

export function isTerminalAuditRecord(
	record: PrewalkAuditRecord | undefined,
): record is PrewalkAuditRecord {
	return record?.event === "completed" || record?.event === "session-ended";
}

/**
 * Owns reload interpretation and revalidation order. The host only supplies
 * model/runtime/analytics capabilities and applies the explicit outcome.
 */
export class SessionRecovery {
	async recover(
		record: PrewalkAuditRecord | undefined,
		host: SessionRecoveryHost,
	): Promise<SessionRecoveryOutcome> {
		if (!record) return { type: "none" };
		if (isTerminalAuditRecord(record)) return { type: "terminal", record };

		const run = runFromAudit(record);
		if (run.phase === "failed" && run.reasonCode === "configuration-invalid") {
			return { type: "restart", reason: "configuration-invalid" };
		}
		if (run.phase !== "failed" && host.nativeCompactionState() !== "disabled") {
			return { type: "restart", reason: "native-compaction-unsupported" };
		}

		host.restoreRun(run);
		if (run.phase === "cancelled") {
			return { type: "restored", run, analyticsRestored: false };
		}

		try {
			const resolution = await host.resolveExecutor(run);
			if (!resolution.ok) {
				return { type: "refused", run, rejected: resolution.rejected };
			}
			host.installRuntime(run);
			if (run.phase === "failed") return { type: "restored", run, analyticsRestored: false };
			try {
				await host.restoreAnalyticsJournal(run);
				return { type: "restored", run, analyticsRestored: true };
			} catch {
				return { type: "restored", run, analyticsRestored: false };
			}
		} catch {
			return { type: "failed", run, reason: "provider-unavailable" };
		}
	}
}
