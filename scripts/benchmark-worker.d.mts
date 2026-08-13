export interface WorkerRequest {
	method: string;
	cmd?: string;
	input?: string;
	timeoutMs?: number;
}

export interface WorkerResponse {
	ok: boolean;
	code?: string;
	output?: string;
	exitCode?: number;
	sessionId?: number;
	lookupAttempts?: number;
	sandboxViolations?: number;
	patchBase64?: string;
	patchDigest?: string;
	workspaceDigest?: string;
	attestation?: {
		commitCount: number;
		remoteCount: number;
		reflogCount: number;
		alternateCount: number;
		credentialHelperCount: number;
		unreachableObjectCount: number;
	};
}

export function countUnreachableObjects(output: string): number;

export function dispatchWorkerRequest(
	request: WorkerRequest,
	options?: { source?: string; workspace?: string },
): Promise<WorkerResponse>;
