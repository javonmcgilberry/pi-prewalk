type CompatibilityValue =
	| null
	| boolean
	| number
	| string
	| CompatibilityValue[]
	| { [key: string]: CompatibilityValue }
	| undefined;

export type CandidateStatus = "supported" | "failed" | "pending" | "skipped" | "yanked" | "review";

export const PI_PACKAGES: readonly string[];
export const CONVERSION_PACKAGE: string;

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

export function stableVersion(version: CompatibilityValue): version is string;
export function candidateVersion(version: CompatibilityValue): version is string;
export function validateCandidateResult(value: CompatibilityValue): CandidateResult;
export function marker(version: string): string;
export function renderLedgerEntry(input: CandidateResult): string;
export function upsertLedger(body: string, input: CandidateResult): string;
export function failureFingerprint(input: CandidateResult): string;
