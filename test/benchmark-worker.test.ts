import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { countUnreachableObjects, dispatchWorkerRequest } from "../scripts/benchmark-worker.mjs";

let root: string | undefined;

afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

async function fixture() {
	root = await mkdtemp(path.join(tmpdir(), "prewalk-worker-"));
	const source = path.join(root, "source");
	const workspace = path.join(root, "workspace");
	await mkdir(source);
	await writeFile(path.join(source, "fixture.txt"), "before\n");
	return { source, workspace };
}

describe("benchmark worker protocol", () => {
	it("ignores git fsck diagnostics when counting unreachable objects", () => {
		expect(
			countUnreachableObjects(
				[
					"Checking object directories: 100% (256/256), done.",
					"unreachable blob 0123456789abcdef0123456789abcdef01234567",
					"unreachable commit 89abcdef0123456789abcdef0123456789abcdef",
				].join("\n"),
			),
		).toBe(2);
	});

	it("creates one clean root commit and seals a binary candidate patch", async () => {
		const { source, workspace } = await fixture();
		const prepared = await dispatchWorkerRequest({ method: "prepare" }, { source, workspace });
		expect(prepared).toMatchObject({
			ok: true,
			attestation: {
				commitCount: 1,
				remoteCount: 0,
				reflogCount: 0,
				alternateCount: 0,
				credentialHelperCount: 0,
				unreachableObjectCount: 0,
			},
		});

		const patched = await dispatchWorkerRequest(
			{
				method: "apply_patch",
				input: "*** Begin Patch\n*** Update File: fixture.txt\n@@\n-before\n+after\n*** End Patch\n",
			},
			{ source, workspace },
		);
		expect(patched).toMatchObject({ ok: true });
		expect(await readFile(path.join(workspace, "fixture.txt"), "utf8")).toBe("after\n");

		const sealed = await dispatchWorkerRequest({ method: "seal" }, { source, workspace });
		expect(sealed).toMatchObject({
			ok: true,
			patchDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			workspaceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		if (!sealed.patchBase64) throw new Error("Expected a sealed patch.");
		expect(Buffer.from(sealed.patchBase64, "base64").toString("utf8")).toContain("+after");
	});

	it("runs bounded shell work in the workspace without persistent sessions", async () => {
		const { source, workspace } = await fixture();
		await dispatchWorkerRequest({ method: "prepare" }, { source, workspace });
		const result = await dispatchWorkerRequest(
			{ method: "exec_command", cmd: "pwd && git status --short" },
			{ source, workspace },
		);
		expect(result).toMatchObject({ ok: true, exitCode: 0 });
		expect(result).not.toHaveProperty("sessionId");
		expect(result.output).toContain(workspace);
	});

	it.each([
		"git log --all",
		"git reflog",
		"git remote -v",
		"git ls-remote https://example.com/repo.git",
		"curl https://example.com",
		'python3 -c "import socket; socket.create_connection((\\"example.com\\", 443))"',
		"cat /opt/task-base/solution.patch",
	])("blocks solution or network lookup commands: %s", async (cmd) => {
		const { source, workspace } = await fixture();
		const result = await dispatchWorkerRequest(
			{ method: "exec_command", cmd },
			{ source, workspace },
		);
		expect(result).toMatchObject({
			ok: false,
			code: "prohibited-lookup",
			lookupAttempts: 1,
		});
	});

	it("rejects unknown methods, traversal, symlink escape, and oversized frames", async () => {
		const { source, workspace } = await fixture();
		await dispatchWorkerRequest({ method: "prepare" }, { source, workspace });
		await expect(
			dispatchWorkerRequest({ method: "unknown" }, { source, workspace }),
		).rejects.toThrow(/unknown worker method/i);
		await expect(
			dispatchWorkerRequest(
				{
					method: "apply_patch",
					input: "*** Begin Patch\n*** Delete File: ../x\n*** End Patch",
				},
				{ source, workspace },
			),
		).rejects.toThrow(/path/);
		await expect(
			dispatchWorkerRequest(
				{ method: "exec_command", cmd: "x".repeat(1_000_001) },
				{ source, workspace },
			),
		).rejects.toThrow(/frame/);
	});
});
