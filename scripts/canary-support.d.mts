export const CANARY_CONFIRMATION: string;
export const DEFAULT_RETENTION_MS: number;
export const MAX_RETENTION_MS: number;
export function containsCanaryHiddenGuidance(payload: unknown, hiddenPrompts: string[]): boolean;
export interface CanaryOptions {
	confirmation?: string;
	authFile?: string;
	piExecutable?: string;
	evidenceDir?: string;
	retentionMs: number;
	timeoutMs: number;
}
export function parseCanaryArgs(argv: string[]): CanaryOptions;
export function validateCanaryOptions(options: CanaryOptions): CanaryOptions;
export interface EvidenceUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}
export interface EvidenceInput {
	now?: Date;
	retentionMs?: number;
	outcome: "passed" | "failed";
	requestModels: string[];
	usage: Partial<EvidenceUsage>;
	status: string;
	trigger?: string;
	settingsBefore: string;
	settingsAfter: string;
	assertions: string[];
}
export interface EvidenceSummary extends EvidenceInput {
	schemaVersion: 1;
	createdAt: string;
	expiresAt: string;
	usage: EvidenceUsage;
}
export function buildEvidenceSummary(input: EvidenceInput): EvidenceSummary;
export function writeEvidence(directory: string, summary: EvidenceSummary): Promise<string>;
export function pruneEvidence(directory: string, now?: Date): Promise<string[]>;
export function stageOpenAICodexCredential(sourceFile: string, targetFile: string): Promise<void>;
