import type { ThinkingLevel } from "../src/protocol.mjs";

export interface CliResult {
	status: string;
	disposition?: string;
	reasonCode?: string;
	[key: string]: unknown;
}

export function parseCliArgs(argv: string[]): {
	mode: "update" | "status" | "migrate" | "uninstall" | "recovery-report" | "help";
	json: boolean;
};
export function sanitizeLegacyConfig(value: unknown): {
	enabled: boolean;
	target: string;
	thinkingLevel: ThinkingLevel;
	crossProviderPairs: string[];
};
export function classifyInstallation(input: {
	manifest: Record<string, any>;
	installation: Record<string, any>;
	adapters: any;
}): Promise<CliResult>;
export function migrateInstallation(input: any): Promise<CliResult>;
export function uninstallInstallation(input: any): Promise<CliResult>;
export function executeCliMode(input: any): Promise<CliResult>;
export function runCli(input?: any): Promise<number>;
