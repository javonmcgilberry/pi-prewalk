export type CandidateStatus = "supported" | "failed" | "pending" | "skipped" | "yanked" | "review";

export interface CandidateResult {
	version: string;
	status: CandidateStatus;
	integrity: string;
	testedAt: string;
	runId: string;
	artifactId: string;
	summary: string;
	dependencies: Record<string, string>;
}

export function stableVersion(version: unknown): version is string;
export function validateCandidateResult(value: unknown): CandidateResult;
export function marker(version: string): string;
export function renderLedgerEntry(input: CandidateResult): string;
export function upsertLedger(body: string, input: CandidateResult): string;
export function failureFingerprint(input: CandidateResult): string;
