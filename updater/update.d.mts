export interface ArchiveEntry {
	path: string;
	type?: string;
	linkPath?: string;
	[key: string]: unknown;
}

export interface UpdaterReport {
	status:
		| "updated"
		| "noop"
		| "refused"
		| "rolled-back"
		| "recovered"
		| "restored"
		| "recovery-required";
	disposition: string;
	manifestId: string;
	releaseCommit: string;
	patchSha256: string;
	reasonCode?: string;
}

export class UpdaterError extends Error {
	readonly code: string;
	readonly details: unknown;
	constructor(message: string, code?: string, details?: unknown);
}

export class InjectedCrashError extends Error {
	readonly failpoint: string;
	constructor(failpoint: string);
}

export function validateArchiveEntries<T extends ArchiveEntry>(
	entries: T[],
	stripComponents?: number,
): T[];
export function extractPatchPaths(contents: string): string[];
export function attestationMatches(
	value: Record<string, unknown> | undefined,
	manifest: Record<string, unknown>,
): boolean;
export function siblingPath(livePath: string, suffix: string): string;

export function commitOfficialCandidate(input: {
	manifest: Record<string, unknown>;
	installation: Record<string, unknown>;
	candidatePath: string;
	ownerId?: string;
	adapters: object;
}): Promise<UpdaterReport>;

export function restoreOfficialFromSource(input: {
	manifest: Record<string, unknown>;
	installation: Record<string, unknown>;
	patch: { path: string; contents: string };
	adapters: object;
}): Promise<UpdaterReport>;

export function runRecoveredAction<T>(input: {
	manifest: Record<string, unknown>;
	installation: Record<string, unknown>;
	adapters: object;
	action: (context: {
		manifest: Record<string, unknown>;
		installation: Record<string, unknown>;
		adapters: object;
	}) => Promise<T> | T;
}): Promise<{ recovery: UpdaterReport; value?: never } | { recovery: null; value: T }>;

export function runUpdater(input: {
	manifest: Record<string, unknown>;
	installation: Record<string, unknown>;
	patch: { path: string; contents: string };
	adapters: object;
}): Promise<UpdaterReport>;
