import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerBenchmarkSandbox, dockerContainerCreateArgs } from "../scripts/benchmark-docker.mjs";
import { dispatchEvaluatorRequest } from "../scripts/benchmark-evaluator.mjs";

let root: string | undefined;

afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

const task = {
	id: "task-1",
	repository: "https://github.com/example/project",
	revision: "a".repeat(40),
	sourceDigest: "f".repeat(64),
	workerImage: `ghcr.io/example/worker@sha256:${"b".repeat(64)}`,
	evaluatorImage: `ghcr.io/example/evaluator@sha256:${"c".repeat(64)}`,
	testCommand: 'test "$(cat fixture.txt)" = after',
	timeoutSeconds: 600,
};

const frozenEnvironment = [
	"GIT_CONFIG_GLOBAL=/dev/null",
	"GIT_CONFIG_NOSYSTEM=1",
	"HOME=/tmp/home",
	"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
];
const tmpDirectoryPolicy = "rw,noexec,nosuid,nodev,size=1g,uid=65532,gid=65532,mode=0700";
const workspacePolicy = "rw,nosuid,nodev,size=8g,uid=65532,gid=65532,mode=0700";

function imageInspection(image: string, role: "worker" | "evaluator") {
	return JSON.stringify([
		{
			RepoDigests: [image],
			Config: {
				Labels: {
					"dev.prewalk.benchmark.task-id": task.id,
					"dev.prewalk.benchmark.repository": task.repository,
					"dev.prewalk.benchmark.revision": task.revision,
					"dev.prewalk.benchmark.source-digest": task.sourceDigest,
					"dev.prewalk.benchmark.image-role": role,
				},
			},
		},
	]);
}

describe("Docker benchmark sandbox", () => {
	it("creates worker and evaluator containers with the same locked policy", () => {
		for (const role of ["worker", "evaluator"]) {
			const args = dockerContainerCreateArgs(
				role === "worker" ? task.workerImage : task.evaluatorImage,
				`prewalk-${role}`,
				role,
			);
			expect(args).toEqual(
				expect.arrayContaining([
					"create",
					"--pull",
					"never",
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
				]),
			);
			expect(args).not.toContain("--mount");
			expect(args).not.toContain("--volume");
			expect(args.join(" ")).not.toMatch(/docker\.sock|credential|auth|Users/i);
		}
	});

	it("attests a digest-pinned image and effective container before starting it", async () => {
		const calls: string[][] = [];
		const run = vi.fn(async (args: string[], _options?: { input?: string }) => {
			calls.push(args);
			if (args[0] === "image") {
				return {
					exitCode: 0,
					stdout: imageInspection(task.workerImage, "worker"),
					stderr: "",
				};
			}
			if (args[0] === "create") return { exitCode: 0, stdout: "container-id\n", stderr: "" };
			if (args[0] === "inspect") {
				return {
					exitCode: 0,
					stdout: JSON.stringify([
						{
							HostConfig: {
								NetworkMode: "none",
								ReadonlyRootfs: true,
								CapDrop: ["ALL"],
								SecurityOpt: ["no-new-privileges"],
								PidsLimit: 256,
								Memory: 4 * 1024 ** 3,
								NanoCpus: 2 * 10 ** 9,
								Binds: null,
								Tmpfs: {
									"/tmp": tmpDirectoryPolicy,
									"/workspace": workspacePolicy,
								},
							},
							Config: { User: "65532:65532", Env: frozenEnvironment },
							Mounts: [],
						},
					]),
					stderr: "",
				};
			}
			if (args[0] === "start") return { exitCode: 0, stdout: "", stderr: "" };
			if (args[0] === "exec") {
				return {
					exitCode: 0,
					stdout: `${JSON.stringify({
						ok: true,
						attestation: {
							commitCount: 1,
							remoteCount: 0,
							reflogCount: 0,
							alternateCount: 0,
							credentialHelperCount: 0,
							unreachableObjectCount: 0,
						},
					})}\n`,
					stderr: "",
				};
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		const sandbox = new DockerBenchmarkSandbox({ run });
		const handle = await sandbox.createWorker(task, "run-1");
		expect(handle.containerId).toBe("container-id");
		expect(calls.map((args) => args[0])).toEqual(["image", "create", "inspect", "start", "exec"]);
		expect(run.mock.calls.at(-1)?.[1]?.input).toBe('{"method":"prepare"}');
	});

	it("reuses a successful immutable image attestation", async () => {
		const run = vi.fn(async () => ({
			exitCode: 0,
			stdout: imageInspection(task.workerImage, "worker"),
			stderr: "",
		}));
		const sandbox = new DockerBenchmarkSandbox({ run });
		const expected = { task, role: "worker" as const };

		await sandbox.assertImage(task.workerImage, expected);
		await sandbox.assertImage(task.workerImage, expected);

		expect(run).toHaveBeenCalledOnce();
	});

	it.each(["OPENAI_API_KEY=secret", "DATABASE_URL=postgres://secret", "HTTP_PROXY=http://proxy"])(
		"rejects an unexpected container environment entry before starting: %s",
		async (unexpectedEnvironment) => {
			const calls: string[][] = [];
			const run = vi.fn(async (args: string[]) => {
				calls.push(args);
				if (args[0] === "image") {
					return {
						exitCode: 0,
						stdout: imageInspection(task.workerImage, "worker"),
						stderr: "",
					};
				}
				if (args[0] === "create") {
					return { exitCode: 0, stdout: "container-id\n", stderr: "" };
				}
				if (args[0] === "inspect") {
					return {
						exitCode: 0,
						stdout: JSON.stringify([
							{
								HostConfig: {
									NetworkMode: "none",
									ReadonlyRootfs: true,
									CapDrop: ["ALL"],
									SecurityOpt: ["no-new-privileges"],
									PidsLimit: 256,
									Memory: 4 * 1024 ** 3,
									NanoCpus: 2 * 10 ** 9,
									Binds: null,
									Tmpfs: {
										"/tmp": tmpDirectoryPolicy,
										"/workspace": workspacePolicy,
									},
								},
								Config: {
									User: "65532:65532",
									Env: [...frozenEnvironment, unexpectedEnvironment],
								},
								Mounts: [],
							},
						]),
						stderr: "",
					};
				}
				return { exitCode: 0, stdout: "", stderr: "" };
			});
			const sandbox = new DockerBenchmarkSandbox({ run });

			await expect(sandbox.createWorker(task, "run-1")).rejects.toThrow("frozen sandbox policy");
			expect(calls.map((args) => args[0])).not.toContain("start");
		},
	);

	it("rejects an image whose task identity labels do not match the manifest", async () => {
		const run = vi.fn(async () => ({
			exitCode: 0,
			stdout: JSON.stringify([
				{
					RepoDigests: [task.workerImage],
					Config: {
						Labels: {
							"dev.prewalk.benchmark.task-id": "different-task",
							"dev.prewalk.benchmark.repository": task.repository,
							"dev.prewalk.benchmark.revision": task.revision,
							"dev.prewalk.benchmark.source-digest": task.sourceDigest,
							"dev.prewalk.benchmark.image-role": "worker",
						},
					},
				},
			]),
			stderr: "",
		}));
		const sandbox = new DockerBenchmarkSandbox({ run });

		await expect(sandbox.assertImage(task.workerImage, { task, role: "worker" })).rejects.toThrow(
			/frozen digest/,
		);
	});

	it("destroys the worker before creating the evaluator", async () => {
		const calls: string[][] = [];
		let createCount = 0;
		const run = vi.fn(async (args: string[]) => {
			calls.push(args);
			if (args[0] === "image") {
				const image = args.at(-1);
				const role = image === task.workerImage ? "worker" : "evaluator";
				return {
					exitCode: 0,
					stdout: imageInspection(image ?? "", role),
					stderr: "",
				};
			}
			if (args[0] === "create") {
				createCount += 1;
				return { exitCode: 0, stdout: `container-${createCount}\n`, stderr: "" };
			}
			if (args[0] === "inspect") {
				return {
					exitCode: 0,
					stdout: JSON.stringify([
						{
							HostConfig: {
								NetworkMode: "none",
								ReadonlyRootfs: true,
								CapDrop: ["ALL"],
								SecurityOpt: ["no-new-privileges"],
								PidsLimit: 256,
								Memory: 4 * 1024 ** 3,
								NanoCpus: 2 * 10 ** 9,
								Binds: null,
								Tmpfs: {
									"/tmp": tmpDirectoryPolicy,
									"/workspace": workspacePolicy,
								},
							},
							Config: { User: "65532:65532", Env: frozenEnvironment },
							Mounts: [],
						},
					]),
					stderr: "",
				};
			}
			if (args[0] === "exec") {
				return {
					exitCode: 0,
					stdout: `${JSON.stringify({
						ok: true,
						attestation: {
							commitCount: 1,
							remoteCount: 0,
							reflogCount: 0,
							alternateCount: 0,
							credentialHelperCount: 0,
							unreachableObjectCount: 0,
						},
						outcome: "passed",
						elapsedMs: 10,
						evaluatorDigest: "e".repeat(64),
					})}\n`,
					stderr: "",
				};
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		const sandbox = new DockerBenchmarkSandbox({ run });
		const worker = await sandbox.createWorker(task, "run-1");
		await sandbox.destroy(worker);
		await sandbox.evaluate(task, "run-1", Buffer.from("patch").toString("base64"));
		const workerRemoval = calls.findIndex(
			(args) => args[0] === "rm" && args.includes("container-1"),
		);
		const evaluatorCreate = calls.findIndex(
			(args) => args[0] === "create" && args.includes(task.evaluatorImage),
		);
		expect(workerRemoval).toBeGreaterThan(-1);
		expect(evaluatorCreate).toBeGreaterThan(workerRemoval);
	});

	it("retries tracked container cleanup after a transient removal failure", async () => {
		let removalAttempts = 0;
		const run = vi.fn(async (args: string[], _options?: { input?: string }) => {
			if (args[0] === "image") {
				return {
					exitCode: 0,
					stdout: imageInspection(task.workerImage, "worker"),
					stderr: "",
				};
			}
			if (args[0] === "create") {
				return { exitCode: 0, stdout: "container-id\n", stderr: "" };
			}
			if (args[0] === "inspect") {
				return {
					exitCode: 0,
					stdout: JSON.stringify([
						{
							HostConfig: {
								NetworkMode: "none",
								ReadonlyRootfs: true,
								CapDrop: ["ALL"],
								SecurityOpt: ["no-new-privileges"],
								PidsLimit: 256,
								Memory: 4 * 1024 ** 3,
								NanoCpus: 2 * 10 ** 9,
								Binds: null,
								Tmpfs: {
									"/tmp": tmpDirectoryPolicy,
									"/workspace": workspacePolicy,
								},
							},
							Config: { User: "65532:65532", Env: frozenEnvironment },
							Mounts: [],
						},
					]),
					stderr: "",
				};
			}
			if (args[0] === "exec") {
				return {
					exitCode: 0,
					stdout: `${JSON.stringify({
						ok: true,
						attestation: {
							commitCount: 1,
							remoteCount: 0,
							reflogCount: 0,
							alternateCount: 0,
							credentialHelperCount: 0,
							unreachableObjectCount: 0,
						},
					})}\n`,
					stderr: "",
				};
			}
			if (args[0] === "rm") {
				removalAttempts += 1;
				return { exitCode: removalAttempts === 1 ? 1 : 0, stdout: "", stderr: "" };
			}
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		const sandbox = new DockerBenchmarkSandbox({ run });
		await sandbox.createWorker(task, "run-cleanup");

		await expect(sandbox.cleanup()).resolves.toBeUndefined();
		expect(removalAttempts).toBe(2);
	});
});

describe("benchmark evaluator", () => {
	it("applies a sealed candidate patch and runs the fixed test", async () => {
		root = await mkdtemp(path.join(tmpdir(), "prewalk-evaluator-"));
		const source = path.join(root, "source");
		const workspace = path.join(root, "workspace");
		await mkdir(source);
		await writeFile(path.join(source, "fixture.txt"), "before\n");
		const patch = [
			"diff --git a/fixture.txt b/fixture.txt",
			"index 90a36e4..e019be0 100644",
			"--- a/fixture.txt",
			"+++ b/fixture.txt",
			"@@ -1 +1 @@",
			"-before",
			"+after",
			"",
		].join("\n");
		const result = await dispatchEvaluatorRequest(
			{
				method: "evaluate",
				patchBase64: Buffer.from(patch).toString("base64"),
				testCommand: task.testCommand,
				timeoutMs: 60_000,
			},
			{ source, workspace },
		);
		expect(result).toMatchObject({
			ok: true,
			outcome: "passed",
			evaluatorDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
	});
});
