import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cp,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_SOURCE = "/opt/task-base";
const DEFAULT_WORKSPACE = "/workspace";
const MAX_FRAME_BYTES = 1_000_000;
const MAX_OUTPUT_BYTES = 200_000;
const MAX_COMMAND_MS = 10 * 60 * 1_000;
const PROHIBITED_COMMAND =
	/(?:^|[;&|(\s])(?:curl|wget|ssh|scp|nc|ncat|telnet|ftp|dig|nslookup|ping|git\s+(?:log|show|reflog|remote|fetch|pull|clone|rev-list|fsck|ls-remote|submodule)\b|(?:npm|pnpm|yarn|pip|pip3|uv|gem|cargo|go)\s+(?:add|install|fetch|get|update)|(?:python|python3)\b[^;&|]*(?:urllib|socket|requests|httpx|aiohttp)|node\b[^;&|]*(?:fetch\s*\(|require\s*\(\s*["'](?:https?|net)["']|from\s+["'](?:https?|net)["'])|ruby\b[^;&|]*(?:net\/http|open-uri)|perl\b[^;&|]*LWP)|https?:\/\/|git@|\/dev\/tcp\/|(?:gold|solution|answer)[-_.]?(?:patch|diff|json|txt)?|\/opt\/task-base/i;

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function cleanEnvironment(workspace) {
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

async function runProcess(command, args, { cwd, input, timeoutMs = MAX_COMMAND_MS } = {}) {
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: cleanEnvironment(cwd ?? DEFAULT_WORKSPACE),
			stdio: ["pipe", "pipe", "pipe"],
		});
		const chunks = [];
		let bytes = 0;
		let truncated = false;
		const collect = (chunk) => {
			if (bytes >= MAX_OUTPUT_BYTES) {
				truncated = true;
				return;
			}
			const remaining = MAX_OUTPUT_BYTES - bytes;
			const accepted = chunk.subarray(0, remaining);
			chunks.push(accepted);
			bytes += accepted.length;
			if (accepted.length < chunk.length) truncated = true;
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.once("error", reject);
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({
				exitCode: code ?? 1,
				signal,
				output: Buffer.concat(chunks).toString("utf8"),
				truncated,
				timedOut: signal === "SIGKILL",
			});
		});
		if (input !== undefined) child.stdin.end(input);
		else child.stdin.end();
	});
}

async function git(workspace, args) {
	const result = await runProcess("git", args, { cwd: workspace });
	if (result.exitCode !== 0) {
		throw new Error(`git command failed: ${args[0]}`);
	}
	return result.output.trim();
}

async function containedPath(workspace, relativePath, allowMissing = false) {
	if (
		typeof relativePath !== "string" ||
		relativePath.length === 0 ||
		path.isAbsolute(relativePath) ||
		relativePath.includes("\0")
	) {
		throw new Error("Patch path must be a relative workspace path.");
	}
	const resolvedWorkspace = await realpath(workspace);
	const resolved = path.resolve(resolvedWorkspace, relativePath);
	const prefix = `${resolvedWorkspace}${path.sep}`;
	if (resolved !== resolvedWorkspace && !resolved.startsWith(prefix)) {
		throw new Error("Patch path escapes the workspace.");
	}
	let cursor = allowMissing ? path.dirname(resolved) : resolved;
	while (cursor.startsWith(prefix) || cursor === resolvedWorkspace) {
		try {
			const info = await lstat(cursor);
			if (info.isSymbolicLink()) throw new Error("Patch path crosses a symbolic link.");
			const actual = await realpath(cursor);
			if (actual !== resolvedWorkspace && !actual.startsWith(prefix)) {
				throw new Error("Patch path escapes the workspace.");
			}
			break;
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "ENOENT" &&
				cursor !== resolvedWorkspace
			) {
				cursor = path.dirname(cursor);
				continue;
			}
			throw error;
		}
	}
	return resolved;
}

function parsePatch(patchText) {
	if (typeof patchText !== "string" || Buffer.byteLength(patchText) > MAX_FRAME_BYTES) {
		throw new Error("Worker frame exceeds the maximum size.");
	}
	const lines = patchText.trimEnd().split("\n");
	if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
		throw new Error("Invalid patch envelope.");
	}
	const actions = [];
	let index = 1;
	while (index < lines.length - 1) {
		const header = lines[index++];
		const match = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(header);
		if (!match) throw new Error("Invalid patch file header.");
		const action = match[1].toLowerCase();
		const filePath = match[2];
		let movePath;
		if (action === "update" && lines[index]?.startsWith("*** Move to: ")) {
			movePath = lines[index++].slice("*** Move to: ".length);
		}
		const body = [];
		while (
			index < lines.length - 1 &&
			!lines[index].startsWith("*** Add File: ") &&
			!lines[index].startsWith("*** Delete File: ") &&
			!lines[index].startsWith("*** Update File: ")
		) {
			body.push(lines[index++]);
		}
		actions.push({ action, filePath, movePath, body });
	}
	if (actions.length === 0) throw new Error("Patch contains no actions.");
	return actions;
}

function applyUpdate(original, body) {
	const source = original.endsWith("\n")
		? original.slice(0, -1).split("\n")
		: original.split("\n");
	const output = [];
	let sourceIndex = 0;
	let bodyIndex = 0;
	while (bodyIndex < body.length) {
		if (body[bodyIndex].startsWith("@@")) bodyIndex += 1;
		const hunk = [];
		while (bodyIndex < body.length && !body[bodyIndex].startsWith("@@")) {
			const line = body[bodyIndex++];
			if (!/^[ +-]/.test(line)) throw new Error("Invalid patch hunk line.");
			hunk.push(line);
		}
		if (hunk.length === 0) continue;
		const expected = hunk.filter((line) => line[0] !== "+").map((line) => line.slice(1));
		let found = -1;
		for (
			let candidate = sourceIndex;
			candidate <= source.length - expected.length;
			candidate += 1
		) {
			if (expected.every((line, offset) => source[candidate + offset] === line)) {
				found = candidate;
				break;
			}
		}
		if (found < 0) throw new Error("Failed to find expected patch context.");
		output.push(...source.slice(sourceIndex, found));
		let cursor = found;
		for (const line of hunk) {
			if (line[0] === " ") {
				output.push(source[cursor++]);
			} else if (line[0] === "-") {
				cursor += 1;
			} else {
				output.push(line.slice(1));
			}
		}
		sourceIndex = cursor;
	}
	output.push(...source.slice(sourceIndex));
	return `${output.join("\n")}\n`;
}

async function applyPatch(workspace, patchText) {
	for (const action of parsePatch(patchText)) {
		const target = await containedPath(workspace, action.filePath, action.action === "add");
		if (action.action === "add") {
			if (!action.body.every((line) => line.startsWith("+"))) {
				throw new Error("Added file lines must start with +.");
			}
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, `${action.body.map((line) => line.slice(1)).join("\n")}\n`, {
				flag: "wx",
			});
		} else if (action.action === "delete") {
			await unlink(target);
		} else {
			const original = await readFile(target, "utf8");
			await writeFile(target, applyUpdate(original, action.body), { flag: "w" });
			if (action.movePath) {
				const destination = await containedPath(workspace, action.movePath, true);
				await mkdir(path.dirname(destination), { recursive: true });
				await rename(target, destination);
			}
		}
	}
}

async function walkFiles(root, directory = root) {
	const files = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.name === ".git") continue;
		const filePath = path.join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error("Workspace contains a symbolic link.");
		if (entry.isDirectory()) files.push(...(await walkFiles(root, filePath)));
		else if (entry.isFile()) files.push(path.relative(root, filePath));
	}
	return files.sort();
}

async function workspaceDigest(workspace) {
	const hash = createHash("sha256");
	for (const relativePath of await walkFiles(workspace)) {
		hash.update(relativePath);
		hash.update("\0");
		hash.update(await readFile(path.join(workspace, relativePath)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export function countUnreachableObjects(output) {
	return output.split("\n").filter((line) => line.trimStart().startsWith("unreachable ")).length;
}

async function attest(workspace) {
	const reflogDirectory = path.join(workspace, ".git", "logs");
	let reflogCount = 0;
	try {
		reflogCount = (await walkFiles(reflogDirectory)).length;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	const alternatePath = path.join(workspace, ".git", "objects", "info", "alternates");
	let alternateCount = 0;
	try {
		alternateCount = (await readFile(alternatePath, "utf8")).trim() ? 1 : 0;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	const [unreachable, credentialHelpers, commitCount, remotes] = await Promise.all([
		git(workspace, ["fsck", "--unreachable", "--no-reflogs"]),
		runProcess("git", ["config", "--get-all", "credential.helper"], { cwd: workspace }),
		git(workspace, ["rev-list", "--count", "--all"]),
		git(workspace, ["remote"]),
	]);
	return {
		commitCount: Number(commitCount),
		remoteCount: remotes.split("\n").filter(Boolean).length,
		reflogCount,
		alternateCount,
		credentialHelperCount:
			credentialHelpers.exitCode === 0
				? credentialHelpers.output.split("\n").filter(Boolean).length
				: 0,
		unreachableObjectCount: countUnreachableObjects(unreachable),
	};
}

async function prepare(source, workspace) {
	await mkdir(workspace, { recursive: true });
	for (const entry of await readdir(workspace)) {
		await rm(path.join(workspace, entry), { recursive: true, force: true });
	}
	await cp(source, workspace, { recursive: true, dereference: false });
	await rm(path.join(workspace, ".git"), { recursive: true, force: true });
	await git(workspace, ["init", "--initial-branch=main"]);
	await git(workspace, ["config", "core.logAllRefUpdates", "false"]);
	await git(workspace, ["config", "user.name", "Prewalk Benchmark"]);
	await git(workspace, ["config", "user.email", "benchmark@invalid"]);
	await git(workspace, ["add", "--all"]);
	await git(workspace, ["commit", "--quiet", "-m", "frozen task base"]);
	const attestation = await attest(workspace);
	if (
		attestation.commitCount !== 1 ||
		attestation.remoteCount !== 0 ||
		attestation.reflogCount !== 0 ||
		attestation.alternateCount !== 0 ||
		attestation.credentialHelperCount !== 0 ||
		attestation.unreachableObjectCount !== 0
	) {
		throw new Error("Worker repository attestation failed.");
	}
	return attestation;
}

function assertRequest(request) {
	const serialized = JSON.stringify(request);
	if (Buffer.byteLength(serialized) > MAX_FRAME_BYTES) {
		throw new Error("Worker frame exceeds the maximum size.");
	}
	if (!request || typeof request !== "object" || typeof request.method !== "string") {
		throw new Error("Worker request is invalid.");
	}
}

export async function dispatchWorkerRequest(
	request,
	{ source = DEFAULT_SOURCE, workspace = DEFAULT_WORKSPACE } = {},
) {
	assertRequest(request);
	if (request.method === "health") return { ok: true, protocolVersion: 1 };
	if (request.method === "prepare") {
		return { ok: true, attestation: await prepare(source, workspace) };
	}
	if (request.method === "write_stdin") {
		return {
			ok: false,
			code: "no-persistent-session",
			output: "Commands always run to completion in this benchmark.",
			lookupAttempts: 0,
			sandboxViolations: 0,
		};
	}
	if (request.method === "exec_command") {
		if (typeof request.cmd !== "string") throw new Error("exec_command requires cmd.");
		if (PROHIBITED_COMMAND.test(request.cmd)) {
			return {
				ok: false,
				code: "prohibited-lookup",
				output: "The benchmark blocks solution history and network access.",
				lookupAttempts: 1,
				sandboxViolations: 0,
			};
		}
		const result = await runProcess("/bin/sh", ["-lc", request.cmd], {
			cwd: workspace,
			timeoutMs:
				Number.isInteger(request.timeoutMs) && request.timeoutMs > 0
					? Math.min(request.timeoutMs, MAX_COMMAND_MS)
					: MAX_COMMAND_MS,
		});
		return {
			ok: result.exitCode === 0,
			code: result.timedOut
				? "command-timeout"
				: result.exitCode === 0
					? "ok"
					: "command-failed",
			output: result.output,
			exitCode: result.exitCode,
			truncated: result.truncated,
			lookupAttempts: 0,
			sandboxViolations: 0,
		};
	}
	if (request.method === "apply_patch") {
		await applyPatch(workspace, request.input);
		return {
			ok: true,
			code: "ok",
			output: "Applied patch successfully.",
			lookupAttempts: 0,
			sandboxViolations: 0,
		};
	}
	if (request.method === "seal") {
		await git(workspace, ["add", "--intent-to-add", "--all"]);
		const patch = await runProcess("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--"], {
			cwd: workspace,
		});
		if (patch.exitCode !== 0) throw new Error("Could not seal candidate patch.");
		return {
			ok: true,
			patchBase64: Buffer.from(patch.output).toString("base64"),
			patchDigest: sha256(patch.output),
			workspaceDigest: await workspaceDigest(workspace),
		};
	}
	throw new Error(`Unknown worker method: ${request.method}`);
}

async function main() {
	const input = await new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		process.stdin.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_FRAME_BYTES) {
				reject(new Error("Worker frame exceeds the maximum size."));
				process.stdin.destroy();
				return;
			}
			chunks.push(chunk);
		});
		process.stdin.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		process.stdin.once("error", reject);
	});
	const response = await dispatchWorkerRequest(JSON.parse(input));
	process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
	main().catch((error) => {
		process.stdout.write(
			`${JSON.stringify({
				ok: false,
				code: "worker-failed",
				message: error instanceof Error ? error.message : "Worker failed.",
			})}\n`,
		);
		process.exitCode = 1;
	});
}
