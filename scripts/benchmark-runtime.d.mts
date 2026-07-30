import type { BenchmarkProtocol } from "./benchmark-contract.mjs";
import type { BenchmarkRuntimeResult, ScheduledRun } from "./benchmark-controller.mjs";
interface RuntimeTask {
	id: string;
	prompt: string;
	repository: string;
	revision: string;
	sourceDigest: string;
	testCommand: string;
	timeoutSeconds: number;
	workerImage: string;
	evaluatorImage: string;
}

interface RuntimeSandbox {
	assertImage(
		image: string,
		expected?: { task: RuntimeTask; role: "worker" | "evaluator" },
	): Promise<void>;
	createWorker(task: RuntimeTask, runId: string): Promise<{ containerId: string; role: string }>;
	request(
		handle: { containerId: string; role: string },
		request: Record<string, unknown>,
		timeoutMs?: number,
	): Promise<Record<string, unknown>>;
	evaluate(
		task: RuntimeTask,
		runId: string,
		patchBase64: string,
	): Promise<{
		ok: boolean;
		outcome: "passed" | "failed" | "timeout";
		elapsedMs: number;
		evaluatorDigest: string;
	}>;
	destroy(handle: { containerId: string; role: string }): Promise<void>;
	cleanup(): Promise<void>;
}

export function createBenchmarkRuntime(options: {
	authFile: string;
	piExecutable: string;
	sandbox?: RuntimeSandbox;
	rpcFactory?: (options: {
		executable: string;
		args: string[];
		cwd: string;
		env: NodeJS.ProcessEnv;
		timeoutMs: number;
	}) => {
		events: Record<string, unknown>[];
		stderr: string;
		send(command: Record<string, unknown>): Promise<Record<string, unknown>>;
		waitFor(
			predicate: (event: Record<string, unknown>) => boolean,
			timeoutMs: number,
			startIndex: number,
		): Promise<Record<string, unknown>>;
		close(): Promise<void>;
	};
	temporaryParent?: string;
	protocol?: BenchmarkProtocol;
}): {
	preflight(manifest: { tasks: RuntimeTask[] }): Promise<void>;
	run(input: {
		task: RuntimeTask;
		arm: string;
		run: Pick<ScheduledRun, "runId">;
	}): Promise<BenchmarkRuntimeResult>;
	cleanup(): Promise<void>;
};
