type RpcValue =
	| null
	| boolean
	| number
	| string
	| RpcValue[]
	| { [key: string]: RpcValue }
	| undefined;
type RpcRecord = { [key: string]: RpcValue };

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
		onEvent?: (event: RpcRecord, process: RpcProcess) => void;
	});
	readonly child: import("node:child_process").ChildProcessWithoutNullStreams;
	readonly events: RpcRecord[];
	stderr: string;
	send(command: RpcRecord, timeoutMs?: number): Promise<RpcRecord>;
	waitFor(
		predicate: (event: RpcRecord) => boolean,
		timeoutMs?: number,
		startIndex?: number,
	): Promise<RpcRecord>;
	close(): Promise<void>;
}
export function actionableStderr(stderr: string): string[];
