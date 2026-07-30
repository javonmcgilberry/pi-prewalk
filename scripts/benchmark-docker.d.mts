export interface DockerTask {
	id: string;
	repository: string;
	revision: string;
	sourceDigest: string;
	workerImage: string;
	evaluatorImage: string;
	testCommand: string;
	timeoutSeconds: number;
}

export interface DockerHandle {
	containerId: string;
	role: "worker" | "evaluator";
}

export interface DockerRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type DockerRunner = (
	args: string[],
	options?: { input?: string; timeoutMs?: number },
) => Promise<DockerRunResult>;

export function dockerContainerCreateArgs(
	image: string,
	containerName: string,
	role: "worker" | "evaluator" | string,
): string[];
export function dockerWorkerCreateArgs(task: DockerTask, containerName: string): string[];

export class DockerBenchmarkSandbox {
	constructor(options?: { run?: DockerRunner });
	assertImage(
		image: string,
		expected?: { task: DockerTask; role: "worker" | "evaluator" },
	): Promise<void>;
	createWorker(task: DockerTask, runId: string): Promise<DockerHandle>;
	request(
		handle: DockerHandle,
		request: Record<string, unknown>,
		timeoutMs?: number,
	): Promise<Record<string, unknown>>;
	evaluate(
		task: DockerTask,
		runId: string,
		patchBase64: string,
	): Promise<{
		ok: true;
		outcome: "passed" | "failed" | "timeout";
		elapsedMs: number;
		evaluatorDigest: string;
	}>;
	destroy(handle: DockerHandle): Promise<void>;
	cleanup(): Promise<void>;
}
