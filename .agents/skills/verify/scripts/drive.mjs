#!/usr/bin/env node
/**
 * Drives Prewalk through a real Pi RPC process and writes evidence.
 *
 *   node .agents/skills/verify/scripts/drive.mjs --journey handoff
 *   node .agents/skills/verify/scripts/drive.mjs --journey cancel --evidence /abs/dir
 *
 * Every run gets its own scratch agent directory, workspace, and session file
 * in the OS temp directory, so it never reads or writes ~/.pi/agent and two
 * runs can execute side by side. The scratch tree is removed on exit; the
 * evidence directory (default evidence/verify/<journey>-<timestamp>/, which
 * Git ignores) is kept. Exit code 0 means every check passed.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { readAuditRecords } from "../../../../scripts/rpc-smoke-support.mjs";
import { actionableStderr, RpcProcess, resolvePiLaunch } from "../../../../scripts/rpc-support.mjs";

const repo = path.resolve(import.meta.dirname, "../../../..");
const { values } = parseArgs({
	options: {
		journey: { type: "string", default: "handoff" },
		evidence: { type: "string" },
	},
});
const journey = values.journey;
if (!["handoff", "cancel"].includes(journey)) {
	console.error("--journey must be handoff or cancel");
	process.exit(2);
}
const evidenceDir = path.resolve(
	values.evidence ??
		path.join(
			repo,
			"evidence",
			"verify",
			`${journey}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
		),
);
const piExecutable =
	process.env.PREWALK_PI_EXECUTABLE ??
	path.join(repo, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

const scratch = await mkdtemp(path.join(tmpdir(), "prewalk-verify-"));
const agentDir = path.join(scratch, "agent");
const workDir = path.join(scratch, "workspace");
const sessionPath = path.join(scratch, "session.jsonl");
const tracePath = path.join(scratch, "provider-trace.jsonl");
const settingsPath = path.join(agentDir, "settings.json");
const target = "prewalk-verify.txt";
await mkdir(agentDir, { recursive: true, mode: 0o700 });
await mkdir(workDir, { recursive: true });
await mkdir(evidenceDir, { recursive: true });
await writeFile(
	path.join(agentDir, "prewalk.json"),
	`${JSON.stringify({ executor: { provider: "fixture", model: "executor", reasoning: "low" } })}\n`,
);
await writeFile(
	settingsPath,
	`${JSON.stringify({ defaultProvider: "fixture", defaultModel: "planner", defaultThinkingLevel: "high", packages: [] })}\n`,
);
const settingsBefore = await readFile(settingsPath);
await writeFile(
	sessionPath,
	`${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: workDir })}\n`,
);

const rpc = new RpcProcess({
	executable: piExecutable,
	args: [
		"--mode",
		"rpc",
		"--session",
		sessionPath,
		"--model",
		"fixture/planner",
		"--thinking",
		"high",
		"--no-mcp",
		"-e",
		path.join(repo, "extensions", "prewalk.ts"),
		"-e",
		path.join(import.meta.dirname, "fixture-provider.mjs"),
	],
	cwd: workDir,
	env: {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		PREWALK_VERIFY_TRACE: tracePath,
		PREWALK_VERIFY_TARGET: target,
	},
	timeoutMs: 30_000,
});

const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });
const notices = () =>
	rpc.events
		.filter((event) => event.type === "extension_ui_request" && event.method === "notify")
		.map((event) => event.message);
const readTrace = async () =>
	(await readFile(tracePath, "utf8").catch(() => ""))
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [{ type: "unparsable-trace-line", line }];
			}
		});
const prompt = async (message) => {
	const start = rpc.events.length;
	const response = await rpc.send({ type: "prompt", message });
	if (response.data?.disposition !== "handled")
		await rpc.waitFor((event) => event.type === "agent_settled", 60_000, start);
	return response.data?.disposition;
};

let piVersion = "unknown";
try {
	const launch = resolvePiLaunch(piExecutable, ["--version"]);
	piVersion = execFileSync(launch.command, launch.args, { encoding: "utf8" }).trim();
} catch {
	// The summary records "unknown"; the journey checks still decide the verdict.
}
try {
	const startModel = (await rpc.send({ type: "get_state" })).data?.model;
	check(
		"Pi selected the fixture planner",
		`${startModel?.provider}/${startModel?.id}` === "fixture/planner",
		startModel,
	);

	check("/prewalk run is handled as a command", (await prompt("/prewalk run")) === "handled");

	if (journey === "handoff") {
		await prompt("Write the verification file.");
		// The checklist triggers the executor turn after the planner run settles.
		const deadline = Date.now() + 60_000;
		while (
			Date.now() < deadline &&
			!(await readTrace()).some((call) => call.model === "fixture/executor")
		)
			await new Promise((resolve) => setTimeout(resolve, 200));
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		const trace = await readTrace();
		const firstExecutor = trace.findIndex((call) => call.model === "fixture/executor");
		check(
			"planner served the checklist and write before the executor",
			firstExecutor >= 2 &&
				trace.slice(0, firstExecutor).every((call) => call.model === "fixture/planner"),
			trace.map((call) => call.model),
		);
		check(
			"executor served exactly one request",
			trace.filter((call) => call.model === "fixture/executor").length === 1,
		);
		const written = await readFile(path.join(workDir, target), "utf8").catch(() => null);
		check(
			"planner write landed in the session workspace",
			written === "written by the planner\n",
			written,
		);
		const events = (await readAuditRecords(sessionPath)).map((record) => record.event);
		for (const event of [
			"armed",
			"plan-injected",
			"handoff-triggered",
			"executor-active",
			"handoff-completed",
		])
			check(
				`audit records ${event} once`,
				events.filter((e) => e === event).length === 1,
				events,
			);
	} else {
		await prompt("/prewalk cancel");
		const events = (await readAuditRecords(sessionPath)).map((record) => record.event);
		check(
			"audit records armed then cancelled",
			events.includes("armed") && events.at(-1) === "cancelled",
			events,
		);
		check("cancel issued no provider request", (await readTrace()).length === 0);
	}

	await prompt("/prewalk status");
	check("/prewalk status produced a notice", notices().length > 0, notices().at(-1));
	const endModel = (await rpc.send({ type: "get_state" })).data?.model;
	const expectedEnd = journey === "handoff" ? "fixture/executor" : "fixture/planner";
	check(
		`selected model is ${expectedEnd} for the rest of the run`,
		`${endModel?.provider}/${endModel?.id}` === expectedEnd,
		endModel,
	);
	if (journey === "handoff") {
		await prompt("/prewalk release");
		const released = (await rpc.send({ type: "get_state" })).data?.model;
		check(
			"/prewalk release restores the planner",
			`${released?.provider}/${released?.id}` === "fixture/planner",
			released,
		);
		const events = (await readAuditRecords(sessionPath)).map((record) => record.event);
		check("audit ends with manual-release", events.at(-1) === "manual-release", events);
	}
} catch (error) {
	check("journey completed without a driver error", false, String(error?.stack ?? error));
} finally {
	await rpc.close().catch(() => undefined);
	const stderrErrors = actionableStderr(rpc.stderr);
	check("Pi wrote no actionable stderr", stderrErrors.length === 0, stderrErrors);
	check("settings.json is byte-identical", (await readFile(settingsPath)).equals(settingsBefore));
	await writeFile(
		path.join(evidenceDir, "rpc-events.jsonl"),
		rpc.events.map((e) => JSON.stringify(e)).join("\n"),
	);
	await writeFile(path.join(evidenceDir, "stderr.txt"), rpc.stderr);
	await copyFile(sessionPath, path.join(evidenceDir, "session.jsonl")).catch(() => undefined);
	await copyFile(tracePath, path.join(evidenceDir, "provider-trace.jsonl")).catch(() => undefined);
	await copyFile(path.join(workDir, target), path.join(evidenceDir, target)).catch(
		() => undefined,
	);
	await writeFile(
		path.join(evidenceDir, "audit.json"),
		`${JSON.stringify(await readAuditRecords(sessionPath).catch(() => []), null, 2)}\n`,
	);
	const ok = checks.every((entry) => entry.pass);
	const summary = {
		ok,
		journey,
		piVersion,
		piExecutable,
		evidenceDir,
		notices: notices(),
		checks,
	};
	await writeFile(path.join(evidenceDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
	await rm(scratch, { recursive: true, force: true });
	for (const entry of checks) console.log(`${entry.pass ? "PASS" : "FAIL"} ${entry.name}`);
	console.log(`${ok ? "OK" : "FAILED"} ${journey} · evidence: ${evidenceDir}`);
	process.exitCode = ok ? 0 : 1;
}
