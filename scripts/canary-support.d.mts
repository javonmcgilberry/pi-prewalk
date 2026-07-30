import type { ThinkingLevel } from "../src/protocol.mjs";
import type { ModelRef } from "./rpc-support.mjs";
export const CANARY_CONFIRMATION: string;
export const DEFAULT_RETENTION_MS: number;
export const MAX_RETENTION_MS: number;
export interface CanaryOptions {
	confirmation?: string;
	planner?: string;
	target?: string;
	thinking: string;
	consent?: string;
	authFile?: string;
	modelsFile?: string;
	piExecutable?: string;
	evidenceDir?: string;
	retentionMs: number;
	timeoutMs: number;
}
export function parseCanaryArgs(argv: string[]): CanaryOptions;
export function validateCanaryOptions(options: CanaryOptions): CanaryOptions & {
	planner: ModelRef;
	target: ModelRef;
	thinking: ThinkingLevel;
};
export interface EvidenceInput {
	now?: Date;
	retentionMs?: number;
	outcome: "passed" | "failed";
	planner: ModelRef;
	target: ModelRef;
	requestModels: string[];
	requestCount: number;
	checkpointCount: number;
	mutationCount: number;
	assertions: string[];
}
export interface EvidenceSummary {
	schemaVersion: 1;
	createdAt: string;
	expiresAt: string;
	outcome: "passed" | "failed";
	planner: string;
	target: string;
	requestModels: string[];
	requestCount: number;
	checkpointCount: number;
	mutationCount: number;
	assertions: string[];
}
export function buildEvidenceSummary(input: EvidenceInput): EvidenceSummary;
export function writeEvidence(directory: string, summary: EvidenceSummary): Promise<string>;
export function pruneEvidence(directory: string, now?: Date): Promise<string[]>;
