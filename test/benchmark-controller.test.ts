import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ARMS,
	BENCHMARK_CONFIRMATION,
	type BenchmarkManifest,
	FROZEN_BENCHMARK_PROTOCOL,
	taskEnvironmentDigest,
} from "../scripts/benchmark-contract.mjs";
import { createBlindedSchedule, executeBenchmark } from "../scripts/benchmark-controller.mjs";
import { dockerWorkerCreateArgs } from "../scripts/benchmark-docker.mjs";

function task(index: number) {
	const entry = {
		id: `task-${index}`,
		repository: "https://github.com/example/project",
		revision: `${index}`.padStart(40, "a").slice(-40),
		sourceDigest: "f".repeat(64),
		prompt: `Fix task ${index}.`,
		testCommand: "npm test",
		timeoutSeconds: 600,
		workerImage: `ghcr.io/example/prewalk-worker@sha256:${`${index}`.padStart(64, "b").slice(-64)}`,
		evaluatorImage: `ghcr.io/example/prewalk-evaluator@sha256:${`${index}`.padStart(64, "c").slice(-64)}`,
		validation: {
			goldPatchPassed: true,
			baselineReviewed: true,
			promptReviewed: true,
			environmentReproduced: true,
		},
	};
	return { ...entry, environmentDigest: taskEnvironmentDigest(entry) };
}

function manifest(): BenchmarkManifest {
	return {
		schemaVersion: 2,
		protocol: FROZEN_BENCHMARK_PROTOCOL,
		analysisFrozen: true,
		corpusFrozen: true,
		repetitions: 1,
		arms: ARMS,
		targets: {
			maxPassRateGapFromSolPoints: 5,
			minCostOrTimeImprovementPercent: 15,
			minPassRateLeadOverLunaPoints: 10,
			maxNonWinningMetricRegressionPercent: 5,
			maxLookupAttemptRateGapFromSolPoints: 0,
		},
		tasks: Array.from({ length: 20 }, (_, index) => task(index + 1)),
	};
}

let root: string | undefined;

afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

describe("trusted benchmark controller", () => {
	it("creates a complete schedule without exposing arm identities", () => {
		let random = 0;
		let identifier = 0;
		const schedule = createBlindedSchedule(manifest(), {
			randomInt: (maximum) => random++ % maximum,
			runId: () => `run-${identifier++}`,
			commitmentNonce: () => "f".repeat(64),
		});

		expect(schedule.runs).toHaveLength(60);
		expect(new Set(schedule.runs.map((entry) => entry.runId))).toHaveLength(60);
		expect(schedule.runs.every((entry) => !("arm" in entry))).toBe(true);
		expect(JSON.stringify(schedule.runs)).not.toMatch(/"sol"|"luna"|"prewalk"/);
		expect(Object.values(schedule.unblinding).sort()).toEqual([...ARMS].sort());
		for (const entry of manifest().tasks) {
			for (let repetition = 1; repetition <= 1; repetition += 1) {
				const group = schedule.runs.filter(
					(runEntry) => runEntry.taskId === entry.id && runEntry.repetition === repetition,
				);
				expect(group).toHaveLength(3);
				expect(new Set(group.map((runEntry) => runEntry.blindArm))).toHaveLength(3);
			}
		}
	});

	it("salts the arm commitment with a private 256-bit nonce", () => {
		const options = {
			randomInt: () => 0,
			runId: (() => {
				let identifier = 0;
				return () => `run-${identifier++}`;
			})(),
			commitmentNonce: () => "a".repeat(64),
		};
		const first = createBlindedSchedule(manifest(), options);
		let identifier = 0;
		const second = createBlindedSchedule(manifest(), {
			...options,
			runId: () => `run-${identifier++}`,
			commitmentNonce: () => "b".repeat(64),
		});
		expect(first.scheduleDigest).toBe(second.scheduleDigest);
		expect(first.unblinding).toEqual(second.unblinding);
		expect(first.unblindingCommitment).not.toBe(second.unblindingCommitment);
		expect(() =>
			createBlindedSchedule(manifest(), {
				randomInt: () => 0,
				runId: (() => {
					let value = 0;
					return () => `invalid-${value++}`;
				})(),
				commitmentNonce: () => "predictable",
			}),
		).toThrow(/256 bits/);
	});

	it("uses a network-denied, mount-free, resource-bounded worker container", () => {
		const args = dockerWorkerCreateArgs(task(1), "prewalk-run-1");

		expect(args).toEqual(
			expect.arrayContaining([
				"create",
				"--network",
				"none",
				"--read-only",
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
				"--tmpfs",
				"/workspace:rw,nosuid,nodev,size=8g,uid=65532,gid=65532,mode=0700",
			]),
		);
		expect(args).not.toContain("--mount");
		expect(args).not.toContain("--volume");
		expect(args.join(" ")).not.toMatch(/Users|credential|auth/i);
		expect(args.at(-1)).toBe(task(1).workerImage);
	});

	it("runs every tuple, seals blinded rows, and cleans every worker", async () => {
		root = await mkdtemp(path.join(tmpdir(), "prewalk-benchmark-controller-"));
		const outputDirectory = path.join(root, "results");
		let randomCounter = 0;
		let runCounter = 0;
		const runtime = {
			preflight: vi.fn(async () => {}),
			run: vi.fn(async ({ run: scheduledRun }) => ({
				outcome: "passed" as const,
				cost: 1,
				elapsedMs: 2,
				lookupAttempts: scheduledRun.sequence === 0 ? 1 : 0,
				sandboxViolations: 0,
				patchDigest: "d".repeat(64),
				evaluatorDigest: "e".repeat(64),
			})),
			cleanup: vi.fn(async () => {}),
		};

		const result = await executeBenchmark({
			manifest: manifest(),
			outputDirectory,
			controlDirectory: path.join(root, "control"),
			confirmation: BENCHMARK_CONFIRMATION,
			runtime,
			randomInt: (maximum) => randomCounter++ % maximum,
			runId: () => `run-${runCounter++}`,
		});

		expect(runtime.run).toHaveBeenCalledTimes(60);
		expect(runtime.preflight).toHaveBeenCalledOnce();
		expect(runtime.cleanup).toHaveBeenCalledTimes(60);
		expect(result.runCount).toBe(60);
		const rows = (await readFile(result.resultsPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(rows).toHaveLength(60);
		expect(rows.every((row) => !("arm" in row))).toBe(true);
		expect(JSON.stringify(rows)).not.toMatch(/"sol"|"luna"|"prewalk"/);
		const files = await readdir(outputDirectory);
		expect(files.sort()).toEqual(
			[
				"blinded-metrics.json",
				"blinded-schedule.json",
				"raw-results.jsonl",
				"raw-results.lock.json",
			].sort(),
		);
		expect(await readdir(path.join(root, "control"))).toEqual(["unblinding.json"]);
	}, 15_000);

	it("retains invalid runs and still cleans up after runtime failure", async () => {
		root = await mkdtemp(path.join(tmpdir(), "prewalk-benchmark-failure-"));
		let call = 0;
		const runtime = {
			preflight: vi.fn(async () => {}),
			run: vi.fn(async () => {
				call += 1;
				if (call === 1) throw new Error("provider-secret");
				return {
					outcome: "failed" as const,
					cost: 0,
					elapsedMs: 1,
					lookupAttempts: 0,
					sandboxViolations: 0,
					patchDigest: "d".repeat(64),
					evaluatorDigest: "e".repeat(64),
				};
			}),
			cleanup: vi.fn(async () => {}),
		};

		const result = await executeBenchmark({
			manifest: manifest(),
			outputDirectory: path.join(root, "results"),
			controlDirectory: path.join(root, "control"),
			confirmation: BENCHMARK_CONFIRMATION,
			runtime,
			randomInt: () => 0,
			runId: (() => {
				let value = 0;
				return () => `run-${value++}`;
			})(),
		});

		const first = JSON.parse((await readFile(result.resultsPath, "utf8")).split("\n")[0]);
		expect(first).toMatchObject({
			outcome: "invalid",
			cost: 0,
			lookupAttempts: 0,
			sandboxViolations: 0,
			failureCode: "runtime-failed",
		});
		expect(JSON.stringify(first)).not.toContain("provider-secret");
		expect(runtime.cleanup).toHaveBeenCalledTimes(60);
	}, 15_000);

	it("refuses an output directory containing prior evidence", async () => {
		root = await mkdtemp(path.join(tmpdir(), "prewalk-benchmark-existing-"));
		const outputDirectory = path.join(root, "results");
		await mkdir(outputDirectory);
		await writeFile(path.join(outputDirectory, "raw-results.jsonl"), "{}\n");
		const runtime = {
			preflight: vi.fn(async () => {}),
			run: vi.fn(),
			cleanup: vi.fn(),
		};

		await expect(
			executeBenchmark({
				manifest: manifest(),
				outputDirectory,
				controlDirectory: path.join(root, "control"),
				confirmation: BENCHMARK_CONFIRMATION,
				runtime,
				randomInt: () => 0,
				runId: () => "unused",
			}),
		).rejects.toThrow(/empty output directory/);
		expect(runtime.run).not.toHaveBeenCalled();
	});

	it("refuses symlinked artifact directories before any run", async () => {
		root = await mkdtemp(path.join(tmpdir(), "prewalk-benchmark-symlink-"));
		const target = path.join(root, "target");
		const outputDirectory = path.join(root, "results");
		await mkdir(target);
		await symlink(target, outputDirectory);
		const runtime = {
			preflight: vi.fn(async () => {}),
			run: vi.fn(),
			cleanup: vi.fn(),
		};
		await expect(
			executeBenchmark({
				manifest: manifest(),
				outputDirectory,
				controlDirectory: path.join(root, "control"),
				confirmation: BENCHMARK_CONFIRMATION,
				runtime,
				randomInt: () => 0,
				runId: () => "unused",
			}),
		).rejects.toThrow(/real directory/);
		expect(runtime.run).not.toHaveBeenCalled();
	});

	it("rejects artifact directories that become nested after symlink resolution", async () => {
		root = await mkdtemp(path.join(tmpdir(), "prewalk-benchmark-alias-"));
		const outputDirectory = path.join(root, "results");
		const alias = path.join(root, "alias");
		await mkdir(outputDirectory);
		await symlink(outputDirectory, alias);
		const runtime = {
			preflight: vi.fn(async () => {}),
			run: vi.fn(),
			cleanup: vi.fn(),
		};
		await expect(
			executeBenchmark({
				manifest: manifest(),
				outputDirectory,
				controlDirectory: path.join(alias, "control"),
				confirmation: BENCHMARK_CONFIRMATION,
				runtime,
				randomInt: () => 0,
				runId: () => "unused",
			}),
		).rejects.toThrow(/canonicalization/);
		expect(runtime.run).not.toHaveBeenCalled();
	});
});
