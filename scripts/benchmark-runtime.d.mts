import type { BenchmarkProtocol } from "./benchmark-contract.mjs";
import type { BenchmarkRuntimeResult, ScheduledRun } from "./benchmark-controller.mjs";

type RuntimeValue =
	| null
	| boolean
	| number
	| string
	| RuntimeValue[]
	| { [key: string]: RuntimeValue }
	| undefined;
type RuntimeRecord = { [key: string]: RuntimeValue };
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
		request: RuntimeRecord,
		timeoutMs?: number,
	): Promise<RuntimeRecord>;
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
		events: RuntimeRecord[];
		stderr: string;
		send(command: RuntimeRecord): Promise<RuntimeRecord>;
		waitFor(
			predicate: (event: RuntimeRecord) => boolean,
			timeoutMs: number,
			startIndex: number,
		): Promise<RuntimeRecord>;
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
