import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_SOURCE = "/opt/task-base";
const DEFAULT_WORKSPACE = "/workspace";
const MAX_FRAME_BYTES = 10_000_000;
const MAX_TEST_MS = 30 * 60 * 1_000;

function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}

function environment(workspace) {
	return {
		HOME: "/tmp/home",
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		PREWALK_WORKSPACE: workspace,
	};
}

async function run(command, args, { cwd, input, timeoutMs = 60_000 } = {}) {
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: environment(cwd),
			stdio: ["pipe", "ignore", "ignore"],
		});
		child.once("error", reject);
		const started = Date.now();
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({
				exitCode: code ?? 1,
				timedOut: signal === "SIGKILL",
				elapsedMs: Date.now() - started,
			});
		});
		child.stdin.end(input);
	});
}

async function prepare(source, workspace) {
	await mkdir(workspace, { recursive: true });
	for (const entry of await readdir(workspace)) {
		await rm(path.join(workspace, entry), { recursive: true, force: true });
	}
	await cp(source, workspace, { recursive: true, dereference: false });
	await rm(path.join(workspace, ".git"), { recursive: true, force: true });
}

export async function dispatchEvaluatorRequest(
	request,
	{ source = DEFAULT_SOURCE, workspace = DEFAULT_WORKSPACE } = {},
) {
	const serialized = JSON.stringify(request);
	if (Buffer.byteLength(serialized) > MAX_FRAME_BYTES) {
		throw new Error("Evaluator frame exceeds the maximum size.");
	}
	if (
		!request ||
		request.method !== "evaluate" ||
		typeof request.patchBase64 !== "string" ||
		typeof request.testCommand !== "string" ||
		request.testCommand.length === 0 ||
		!Number.isInteger(request.timeoutMs) ||
		request.timeoutMs <= 0
	) {
		throw new Error("Evaluator request is invalid.");
	}
	const patch = Buffer.from(request.patchBase64, "base64");
	if (patch.toString("base64") !== request.patchBase64) {
		throw new Error("Evaluator patch encoding is invalid.");
	}
	await prepare(source, workspace);
	const applied = await run("git", ["apply", "--binary", "--whitespace=nowarn", "-"], {
		cwd: workspace,
		input: patch,
	});
	if (applied.exitCode !== 0) {
		return {
			ok: true,
			outcome: "failed",
			elapsedMs: applied.elapsedMs,
			evaluatorDigest: digest(`apply-failed:${digest(patch)}`),
		};
	}
	const evaluated = await run("/bin/sh", ["-lc", request.testCommand], {
		cwd: workspace,
		timeoutMs: Math.min(request.timeoutMs, MAX_TEST_MS),
	});
	const outcome = evaluated.timedOut ? "timeout" : evaluated.exitCode === 0 ? "passed" : "failed";
	return {
		ok: true,
		outcome,
		elapsedMs: applied.elapsedMs + evaluated.elapsedMs,
		evaluatorDigest: digest(`${digest(patch)}:${outcome}:${evaluated.exitCode}`),
	};
}

async function main() {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of process.stdin) {
		bytes += chunk.length;
		if (bytes > MAX_FRAME_BYTES) throw new Error("Evaluator frame exceeds the maximum size.");
		chunks.push(chunk);
	}
	const response = await dispatchEvaluatorRequest(
		JSON.parse(Buffer.concat(chunks).toString("utf8")),
	);
	process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
	main().catch((error) => {
		process.stdout.write(
			`${JSON.stringify({
				ok: false,
				code: "evaluator-failed",
				message: error instanceof Error ? error.message : "Evaluator failed.",
			})}\n`,
		);
		process.exitCode = 1;
	});
}
