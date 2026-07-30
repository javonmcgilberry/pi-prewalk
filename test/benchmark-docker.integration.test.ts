import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerBenchmarkSandbox } from "../scripts/benchmark-docker.mjs";

const enabled = process.env.PREWALK_RUN_DOCKER_INTEGRATION === "1";
const baseImage = process.env.PREWALK_DOCKER_BASE_IMAGE;
const runDockerIntegration = enabled && Boolean(baseImage) ? describe : describe.skip;

function docker(
	args: string[],
	options: { input?: string; timeoutMs?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.once("error", reject);
		const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 60_000);
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve({
				exitCode: code ?? 1,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		});
		child.stdin.end(options.input);
	});
}

runDockerIntegration("real Docker benchmark worker", () => {
	let root = "";
	let localWorkerImage = "";
	let localEvaluatorImage = "";
	const pinnedWorkerImage = `local/prewalk-worker@sha256:${"b".repeat(64)}`;
	const pinnedEvaluatorImage = `local/prewalk-evaluator@sha256:${"c".repeat(64)}`;
	const task = {
		id: "integration-task",
		repository: "https://github.com/example/integration",
		revision: "a".repeat(40),
		sourceDigest: "f".repeat(64),
		workerImage: pinnedWorkerImage,
		evaluatorImage: pinnedEvaluatorImage,
		testCommand: 'test "$(cat fixture.txt)" = after',
		timeoutSeconds: 60,
	};

	beforeAll(async () => {
		root = await mkdtemp(path.join(tmpdir(), "prewalk-docker-integration-"));
		const imageSuffix = randomUUID();
		localWorkerImage = `prewalk-worker-integration:${imageSuffix}`;
		localEvaluatorImage = `prewalk-evaluator-integration:${imageSuffix}`;
		const context = path.join(root, "context");
		await Promise.all([
			mkdir(path.join(context, "task"), { recursive: true }),
			mkdir(path.join(context, "scripts"), { recursive: true }),
		]);
		await writeFile(path.join(context, "task", "fixture.txt"), "before\n");
		await Promise.all([
			cp(
				path.resolve("scripts/benchmark-worker.mjs"),
				path.join(context, "scripts", "benchmark-worker.mjs"),
			),
			cp(
				path.resolve("scripts/benchmark-evaluator.mjs"),
				path.join(context, "scripts", "benchmark-evaluator.mjs"),
			),
			cp(path.resolve("benchmark/task-image.Dockerfile"), path.join(context, "Dockerfile")),
		]);
		for (const [role, image] of [
			["worker", localWorkerImage],
			["evaluator", localEvaluatorImage],
		]) {
			const built = await docker(
				[
					"build",
					"--pull=false",
					"--build-arg",
					`BASE_IMAGE=${baseImage}`,
					"--build-arg",
					`TASK_ID=${task.id}`,
					"--build-arg",
					`TASK_REPOSITORY=${task.repository}`,
					"--build-arg",
					`TASK_REVISION=${task.revision}`,
					"--build-arg",
					`TASK_SOURCE_DIGEST=${task.sourceDigest}`,
					"--build-arg",
					`IMAGE_ROLE=${role}`,
					"--build-arg",
					"TASK_SOURCE=task",
					"--tag",
					image,
					context,
				],
				{ timeoutMs: 120_000 },
			);
			if (built.exitCode !== 0) {
				throw new Error(`Docker integration image failed: ${built.stderr}`);
			}
		}
	}, 130_000);

	afterAll(async () => {
		for (const image of [localWorkerImage, localEvaluatorImage]) {
			if (image) await docker(["image", "rm", "--force", image]);
		}
		if (root) await rm(root, { recursive: true, force: true });
	});

	it("prepares, mutates, seals, and evaluates a disposable networkless worker", async () => {
		const run = async (args: string[], options?: { input?: string; timeoutMs?: number }) => {
			const pinnedImage = args[2];
			if (
				args[0] === "image" &&
				args[1] === "inspect" &&
				(pinnedImage === pinnedWorkerImage || pinnedImage === pinnedEvaluatorImage)
			) {
				const localImage =
					pinnedImage === pinnedWorkerImage ? localWorkerImage : localEvaluatorImage;
				const actual = await docker(["image", "inspect", localImage], options);
				const inspected = JSON.parse(actual.stdout);
				inspected[0].RepoDigests = [pinnedImage];
				return { ...actual, stdout: JSON.stringify(inspected) };
			}
			const mapped =
				args[0] === "create"
					? args.map((value) => {
							if (value === pinnedWorkerImage) return localWorkerImage;
							if (value === pinnedEvaluatorImage) return localEvaluatorImage;
							return value;
						})
					: args;
			const result = await docker(mapped, options);
			if (mapped[0] === "exec" && result.exitCode !== 0) {
				throw new Error(
					`Docker integration bridge failed: ${result.stderr.trim()} ${result.stdout.trim()}`,
				);
			}
			return result;
		};
		const sandbox = new DockerBenchmarkSandbox({ run });
		try {
			const worker = await sandbox.createWorker(task, "integration-run");
			const mutation = await sandbox.request(worker, {
				method: "apply_patch",
				input: "*** Begin Patch\n*** Update File: fixture.txt\n@@\n-before\n+after\n*** End Patch\n",
			});
			expect(mutation).toMatchObject({ ok: true });
			const sealed = await sandbox.request(worker, { method: "seal" });
			expect(sealed).toMatchObject({
				ok: true,
				patchDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			});
			if (typeof sealed.patchBase64 !== "string") {
				throw new Error("Worker seal is missing.");
			}
			expect(Buffer.from(sealed.patchBase64, "base64").toString("utf8")).toContain("+after");
			await sandbox.destroy(worker);
			const evaluated = await sandbox.evaluate(task, "integration-run", sealed.patchBase64);
			expect(evaluated).toMatchObject({ ok: true, outcome: "passed" });
		} finally {
			await sandbox.cleanup();
		}
	}, 30_000);
});
