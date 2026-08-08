export const CANARY_CONFIRMATION: string;
export const CANARY_TOOL_ALLOWLIST: string;
export const DEFAULT_RETENTION_MS: number;
export const MAX_RETENTION_MS: number;
export function containsCanaryHiddenGuidance(payload: unknown, hiddenPrompts: string[]): boolean;
export function findCanaryHiddenGuidancePaths(payload: unknown, hiddenPrompts: string[]): string[];
export function canaryPayloadTargetsModel(payload: unknown, model: string): boolean;
export function canaryAuditState(entries: unknown[]): {
	state: "running" | "ready" | "completed" | "failed";
	events: string[];
	reasonCode?: string;
};
export function evaluateCanaryPayloadMarker(
	marker:
		| {
				targetPayloadCount?: number;
				targetPayloadGuidanceFree?: boolean;
				toolEvents?: string[];
				payloadGuidancePaths?: string[];
		  }
		| undefined,
	requirement: "required" | "optional",
): { ok: true; assertion: string } | { ok: false; reasonCode: string };
export function isCanaryMutationInput(
	toolName: string,
	input: unknown,
	requestedPath: string,
	fixturePath: string,
): boolean;
export interface CanaryModelRef {
	provider: string;
	model: string;
}
export type CanaryThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface CanaryOptions {
	confirmation?: string;
	authFile?: string;
	piExecutable?: string;
	evidenceDir?: string;
	planner: CanaryModelRef;
	executor: CanaryModelRef;
	plannerThinking: CanaryThinkingLevel;
	executorThinking: CanaryThinkingLevel;
	extensions: string[];
	payloadInspection: "required" | "optional";
	retentionMs: number;
	timeoutMs: number;
}
export function parseCanaryArgs(argv: string[]): CanaryOptions;
export function validateCanaryOptions(options: CanaryOptions): CanaryOptions;
export function buildCanaryPrewalkConfig(
	executor: CanaryModelRef,
	reasoning: CanaryThinkingLevel,
): {
	executor: CanaryModelRef & { reasoning: CanaryThinkingLevel };
	executorFallbacks: [];
	analytics: {
		enabled: false;
		catalogFallbackEnabled: false;
		recentReceiptCount: 10;
		schemaVersion: 1;
	};
};
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
	auditEvents?: string[];
	toolEvents?: string[];
	payloadGuidancePaths?: string[];
}
export interface EvidenceSummary extends EvidenceInput {
	schemaVersion: 1;
	createdAt: string;
	expiresAt: string;
	usage: EvidenceUsage;
	auditEvents: string[];
	toolEvents: string[];
	payloadGuidancePaths: string[];
}
export function buildEvidenceSummary(input: EvidenceInput): EvidenceSummary;
export function writeEvidence(directory: string, summary: EvidenceSummary): Promise<string>;
export function pruneEvidence(directory: string, now?: Date): Promise<string[]>;
export function stageOpenAICodexCredential(sourceFile: string, targetFile: string): Promise<void>;
export function stageProviderCredentials(
	sourceFile: string,
	targetFile: string,
	providers: string[],
): Promise<void>;
