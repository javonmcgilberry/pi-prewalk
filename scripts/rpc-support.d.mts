export interface ModelRef {
	provider: string;
	id: string;
}
export function parseModelRef(value: string | undefined): ModelRef;
export function buildRpcLaunchArgs(options: {
	extensionPath: string;
	sessionPath: string;
	model: string;
	thinking?: string;
	extraExtensions?: string[];
	noBuiltinTools?: boolean;
}): string[];
export function resolvePiLaunch(
	executable: string,
	args: string[],
): { command: string; args: string[] };
export class RpcProcess {
	constructor(options: {
		executable: string;
		args: string[];
		cwd: string;
		env: NodeJS.ProcessEnv;
		timeoutMs?: number;
		onEvent?: (event: Record<string, unknown>, process: RpcProcess) => void;
	});
	readonly child: import("node:child_process").ChildProcessWithoutNullStreams;
	readonly events: Record<string, unknown>[];
	stderr: string;
	send(command: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
	waitFor(
		predicate: (event: Record<string, unknown>) => boolean,
		timeoutMs?: number,
		startIndex?: number,
	): Promise<Record<string, unknown>>;
	close(): Promise<void>;
}
export function actionableStderr(stderr: string): string[];
