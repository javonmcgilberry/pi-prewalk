export function dispatchEvaluatorRequest(
	request: {
		method: "evaluate";
		patchBase64: string;
		testCommand: string;
		timeoutMs: number;
	},
	options?: { source?: string; workspace?: string },
): Promise<{
	ok: true;
	outcome: "passed" | "failed" | "timeout";
	elapsedMs: number;
	evaluatorDigest: string;
}>;
