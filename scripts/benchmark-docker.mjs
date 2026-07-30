import { spawn } from "node:child_process";

const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const PINNED_IMAGE = /^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;
const MAX_DOCKER_OUTPUT = 1_000_000;
const WORKER_BRIDGE = "/opt/prewalk-worker/bridge.mjs";
const EVALUATOR_BRIDGE = "/opt/prewalk-worker/evaluator.mjs";
const FROZEN_ENVIRONMENT = [
	"GIT_CONFIG_GLOBAL=/dev/null",
	"GIT_CONFIG_NOSYSTEM=1",
	"HOME=/tmp/home",
	"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
];
const ALLOWED_RUNTIME_ENVIRONMENT = [
	/^NODE_VERSION=\d+\.\d+\.\d+$/,
	/^YARN_VERSION=\d+\.\d+\.\d+$/,
];
const TMP_DIRECTORY_POLICY = "rw,noexec,nosuid,nodev,size=1g,uid=65532,gid=65532,mode=0700";
const WORKSPACE_POLICY = "rw,nosuid,nodev,size=8g,uid=65532,gid=65532,mode=0700";

function safeName(value) {
	return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80);
}

function assertImage(image) {
	if (typeof image !== "string" || !PINNED_IMAGE.test(image)) {
		throw new Error("Benchmark image must be digest-pinned.");
	}
}

export function dockerContainerCreateArgs(image, containerName, role) {
	assertImage(image);
	if (!CONTAINER_NAME.test(containerName)) {
		throw new Error("Benchmark container name is invalid.");
	}
	if (role !== "worker" && role !== "evaluator") {
		throw new Error("Benchmark container role is invalid.");
	}
	return [
		"create",
		"--pull",
		"never",
		"--name",
		containerName,
		"--label",
		`dev.prewalk.benchmark.role=${role}`,
		"--network",
		"none",
		"--read-only",
		"--user",
		"65532:65532",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--pids-limit",
		"256",
		"--memory",
		"4g",
		"--cpus",
		"2",
		"--ulimit",
		"nofile=1024:1024",
		"--tmpfs",
		`/tmp:${TMP_DIRECTORY_POLICY}`,
		"--tmpfs",
		`/workspace:${WORKSPACE_POLICY}`,
		...FROZEN_ENVIRONMENT.flatMap((entry) => ["--env", entry]),
		"--workdir",
		"/workspace",
		image,
	];
}

export function dockerWorkerCreateArgs(task, containerName) {
	return dockerContainerCreateArgs(task?.workerImage, containerName, "worker");
}

async function defaultDockerRun(args, { input, timeoutMs = 60_000 } = {}) {
	return await new Promise((resolve, reject) => {
		const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
		const stdout = [];
		const stderr = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		const collect = (target, kind) => (chunk) => {
			const used = kind === "stdout" ? stdoutBytes : stderrBytes;
			const remaining = MAX_DOCKER_OUTPUT - used;
			if (remaining <= 0) return;
			const accepted = chunk.subarray(0, remaining);
			target.push(accepted);
			if (kind === "stdout") stdoutBytes += accepted.length;
			else stderrBytes += accepted.length;
		};
		child.stdout.on("data", collect(stdout, "stdout"));
		child.stderr.on("data", collect(stderr, "stderr"));
		child.once("error", reject);
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve({
				exitCode: code ?? 1,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		});
		child.stdin.end(input);
	});
}

function parseJsonOutput(result, operation) {
	if (result.exitCode !== 0) throw new Error(`Docker ${operation} failed.`);
	if (Buffer.byteLength(result.stdout) > MAX_DOCKER_OUTPUT) {
		throw new Error(`Docker ${operation} output exceeded the limit.`);
	}
	let value;
	try {
		value = JSON.parse(result.stdout.trim());
	} catch {
		throw new Error(`Docker ${operation} returned invalid JSON.`);
	}
	if (!value || typeof value !== "object") {
		throw new Error(`Docker ${operation} returned an invalid response.`);
	}
	return value;
}

function validateContainerInspection(value) {
	const inspected = Array.isArray(value) ? value[0] : undefined;
	const host = inspected?.HostConfig;
	const tmpfs = host?.Tmpfs;
	const environment = Array.isArray(inspected?.Config?.Env) ? inspected.Config.Env : [];
	const reject = (field) => {
		throw new Error(`Docker container does not match the frozen sandbox policy: ${field}.`);
	};
	if (!inspected) reject("inspection");
	if (host?.NetworkMode !== "none") reject("network");
	if (host?.ReadonlyRootfs !== true) reject("root filesystem");
	if (!Array.isArray(host?.CapDrop) || !host.CapDrop.includes("ALL")) reject("capabilities");
	if (!Array.isArray(host?.SecurityOpt) || !host.SecurityOpt.includes("no-new-privileges")) {
		reject("security options");
	}
	if (host?.PidsLimit !== 256) reject("process limit");
	if (host?.Memory !== 4 * 1024 ** 3) reject("memory limit");
	if (host?.NanoCpus !== 2 * 10 ** 9) reject("CPU limit");
	if (host?.Binds !== null && host?.Binds !== undefined) reject("bind mounts");
	if (!tmpfs || tmpfs["/tmp"] !== TMP_DIRECTORY_POLICY) reject("temporary directory");
	if (tmpfs["/workspace"] !== WORKSPACE_POLICY) reject("workspace");
	if (inspected.Config?.User !== "65532:65532") reject("user");
	const inheritedEnvironment = environment.filter((entry) => !FROZEN_ENVIRONMENT.includes(entry));
	if (
		FROZEN_ENVIRONMENT.some((entry) => !environment.includes(entry)) ||
		inheritedEnvironment.some(
			(entry) => !ALLOWED_RUNTIME_ENVIRONMENT.some((pattern) => pattern.test(entry)),
		) ||
		new Set(environment.map((entry) => entry.split("=")[0])).size !== environment.length
	) {
		reject("environment");
	}
	if (!Array.isArray(inspected.Mounts) || inspected.Mounts.length !== 0) reject("mounts");
}

function validateWorkerAttestation(value) {
	const attestation = value?.attestation;
	if (
		value?.ok !== true ||
		attestation?.commitCount !== 1 ||
		attestation?.remoteCount !== 0 ||
		attestation?.reflogCount !== 0 ||
		attestation?.alternateCount !== 0 ||
		attestation?.credentialHelperCount !== 0 ||
		attestation?.unreachableObjectCount !== 0
	) {
		throw new Error("Worker checkout attestation failed.");
	}
}

export class DockerBenchmarkSandbox {
	constructor({ run = defaultDockerRun } = {}) {
		this.run = run;
		this.handles = new Map();
		this.verifiedImages = new Set();
	}

	async assertImage(image, expected) {
		assertImage(image);
		const verificationKey = JSON.stringify({
			image,
			taskId: expected?.task.id,
			repository: expected?.task.repository,
			revision: expected?.task.revision,
			sourceDigest: expected?.task.sourceDigest,
			role: expected?.role,
		});
		if (this.verifiedImages.has(verificationKey)) return;
		const result = await this.run(["image", "inspect", image]);
		const value = parseJsonOutput(result, "image inspect");
		const labels = value[0]?.Config?.Labels;
		if (
			!Array.isArray(value) ||
			!Array.isArray(value[0]?.RepoDigests) ||
			!value[0].RepoDigests.includes(image) ||
			(expected &&
				(labels?.["dev.prewalk.benchmark.task-id"] !== expected.task.id ||
					labels?.["dev.prewalk.benchmark.repository"] !== expected.task.repository ||
					labels?.["dev.prewalk.benchmark.revision"] !== expected.task.revision ||
					labels?.["dev.prewalk.benchmark.source-digest"] !== expected.task.sourceDigest ||
					labels?.["dev.prewalk.benchmark.image-role"] !== expected.role))
		) {
			throw new Error("The local benchmark image does not match its frozen digest.");
		}
		this.verifiedImages.add(verificationKey);
	}

	async create(task, runId, role) {
		const image = role === "worker" ? task.workerImage : task.evaluatorImage;
		await this.assertImage(image, { task, role });
		const containerName = safeName(`prewalk-${role}-${runId}`);
		const created = await this.run(dockerContainerCreateArgs(image, containerName, role));
		if (created.exitCode !== 0) throw new Error(`Docker ${role} create failed.`);
		const containerId = created.stdout.trim();
		if (!CONTAINER_NAME.test(containerId))
			throw new Error("Docker returned an invalid container ID.");
		const handle = { containerId, role };
		this.handles.set(containerId, handle);
		try {
			const inspected = await this.run(["inspect", containerId]);
			if (inspected.exitCode !== 0) throw new Error(`Docker ${role} inspect failed.`);
			validateContainerInspection(JSON.parse(inspected.stdout));
			const started = await this.run(["start", containerId]);
			if (started.exitCode !== 0) throw new Error(`Docker ${role} start failed.`);
			return handle;
		} catch (error) {
			await this.destroy(handle);
			throw error;
		}
	}

	async request(handle, request, timeoutMs = 60_000) {
		const bridge = handle.role === "worker" ? WORKER_BRIDGE : EVALUATOR_BRIDGE;
		const result = await this.run(["exec", "--interactive", handle.containerId, "node", bridge], {
			input: JSON.stringify(request),
			timeoutMs,
		});
		return parseJsonOutput(result, `${handle.role} request`);
	}

	async createWorker(task, runId) {
		const handle = await this.create(task, runId, "worker");
		try {
			const response = await this.request(
				handle,
				{ method: "prepare" },
				task.timeoutSeconds * 1000,
			);
			validateWorkerAttestation(response);
			return handle;
		} catch (error) {
			await this.destroy(handle);
			throw error;
		}
	}

	async evaluate(task, runId, patchBase64) {
		const handle = await this.create(task, `${runId}-evaluator`, "evaluator");
		try {
			const response = await this.request(
				handle,
				{
					method: "evaluate",
					patchBase64,
					testCommand: task.testCommand,
					timeoutMs: task.timeoutSeconds * 1000,
				},
				task.timeoutSeconds * 1000 + 5_000,
			);
			if (
				response?.ok !== true ||
				!["passed", "failed", "timeout"].includes(response.outcome) ||
				!Number.isFinite(response.elapsedMs) ||
				!/^[a-f0-9]{64}$/.test(response.evaluatorDigest)
			) {
				throw new Error("Evaluator returned invalid evidence.");
			}
			return response;
		} finally {
			await this.destroy(handle);
		}
	}

	async destroy(handle) {
		if (!handle?.containerId || !CONTAINER_NAME.test(handle.containerId)) return;
		const removed = await this.run(["rm", "--force", handle.containerId]);
		if (removed.exitCode !== 0) throw new Error(`Docker ${handle.role} cleanup failed.`);
		this.handles.delete(handle.containerId);
	}

	async cleanup() {
		for (const handle of [...this.handles.values()]) {
			let removed = false;
			for (let attempt = 0; attempt < 2 && !removed; attempt += 1) {
				try {
					await this.destroy(handle);
					removed = true;
				} catch {}
			}
		}
		if (this.handles.size > 0) {
			throw new Error("Docker benchmark cleanup did not complete cleanly.");
		}
	}
}
