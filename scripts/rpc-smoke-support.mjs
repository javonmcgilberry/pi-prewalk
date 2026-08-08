/**
 * Shared scaffolding for the RPC smoke tests.
 *
 * Both smoke tests stand up the same disposable environment: an agent directory
 * holding a Prewalk config, an auth file, and settings; a seeded session file;
 * and a Pi RPC process pointed at the real extension. Only the model pairing
 * and the assertions differ, so that setup lives here rather than being copied.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRpcLaunchArgs, RpcProcess } from "./rpc-support.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");

export function assert(condition, message) {
	if (!condition) throw new Error(message);
}

export function defaultAnalytics() {
	return {
		enabled: true,
		catalogFallbackEnabled: false,
		recentReceiptCount: 10,
		schemaVersion: 1,
	};
}

/**
 * Creates the disposable agent directory, session file, and RPC process.
 *
 * Returns the live process plus a `settingsUnchanged()` check and a `cleanup()`
 * that removes the temporary tree. Callers own closing the process.
 */
export async function startSmokeSession({
	prefix,
	prewalkConfig,
	auth,
	planner,
	thinking = "high",
}) {
	const temporaryRoot = await mkdtemp(path.join(tmpdir(), prefix));
	const agentDir = path.join(temporaryRoot, "agent");
	const sessionPath = path.join(temporaryRoot, "session.jsonl");
	const settingsPath = path.join(agentDir, "settings.json");

	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	await writeFile(path.join(agentDir, "prewalk.json"), `${JSON.stringify(prewalkConfig)}\n`, {
		mode: 0o600,
	});
	await writeFile(path.join(agentDir, "auth.json"), `${JSON.stringify(auth)}\n`, { mode: 0o600 });
	await writeFile(
		settingsPath,
		`${JSON.stringify({
			defaultProvider: planner.provider,
			defaultModel: planner.id,
			defaultThinkingLevel: thinking,
			packages: [],
		})}\n`,
		{ mode: 0o600 },
	);
	const settingsBefore = await readFile(settingsPath);
	await writeFile(
		sessionPath,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			cwd: packageRoot,
		})}\n`,
		{ mode: 0o600 },
	);

	const rpc = new RpcProcess({
		executable:
			process.env.PREWALK_PI_EXECUTABLE ??
			path.join(
				packageRoot,
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				"dist",
				"cli.js",
			),
		args: buildRpcLaunchArgs({
			extensionPath: path.join(packageRoot, "extensions", "prewalk.ts"),
			extraExtensions: [],
			sessionPath,
			model: `${planner.provider}/${planner.id}`,
			thinking,
		}),
		cwd: packageRoot,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
	});

	return {
		rpc,
		agentDir,
		sessionPath,
		settingsUnchanged: async () => (await readFile(settingsPath)).equals(settingsBefore),
		cleanup: () => rm(temporaryRoot, { recursive: true, force: true }),
	};
}

/**
 * Prewalk's audit records for the session, newest last.
 *
 * Assertions belong here rather than on stderr: a refused arm is reported
 * through a UI notice and the audit trail, so a stderr-only check reports
 * success for a build that never armed.
 */
export async function readAuditRecords(sessionPath) {
	const records = [];
	for (const line of (await readFile(sessionPath, "utf8")).split("\n").filter(Boolean)) {
		try {
			const entry = JSON.parse(line);
			if (entry?.customType === "prewalk-audit" && entry.data) records.push(entry.data);
		} catch {
			// Session files carry non-audit lines too.
		}
	}
	return records;
}
