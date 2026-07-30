export interface DetectedInstallation {
	packagePath: string;
	executablePath: string;
	packageName: string;
	version: string;
	platform: string;
	arch: string;
	manager: "npm";
	topology: "npm-global";
}

export function listTarArchive(
	bytes: Buffer | Uint8Array,
): Promise<Array<{ path: string; type?: string; linkPath?: string }>>;
export function extractTarArchive(input: {
	bytes: Buffer | Uint8Array;
	destination: string;
	entries: Array<{ path: string; type?: string; linkPath?: string }>;
	stripComponents?: number;
}): Promise<void>;
export function hashPackageTree(root: string): Promise<string>;
export function acquireProcessLock(
	lockPath: string,
	hooks?: { beforeStaleUnlink?(): void | Promise<void> },
): Promise<() => Promise<void>>;
export function detectPiInstallation(input?: {
	executablePath?: string;
	envPath?: string;
	platform?: string;
	arch?: string;
}): Promise<DetectedInstallation>;
export function createNodeAdapters(input: any): any;
export function migrateLegacyArtifacts(input: {
	artifacts: string[];
	knownHashes: string[];
}): Promise<{ removed: string[]; preserved: string[] }>;
export function defaultAgentPaths(env?: Record<string, string | undefined>): {
	agentDir: string;
	configPath: string;
	settingsPath: string;
	legacyArtifacts: string[];
};
