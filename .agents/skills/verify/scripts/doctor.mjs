#!/usr/bin/env node
/**
 * Read-only preflight: is this checkout worth driving?
 *
 *   node .agents/skills/verify/scripts/doctor.mjs
 *
 * Reports the Node version, the Pi that the driver will launch, the Pi on
 * PATH that the user runs, whether installed packages match package.json, and
 * whether the live Pi configuration loads this checkout (which means code
 * changes need a Pi restart before they reach the user's sessions). It writes
 * nothing and prints no configuration values beyond package sources.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "../../../..");
const rows = [];
const row = (name, ok, detail) => rows.push({ name, ok, detail });
const readJson = (file) => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
};
const run = (command, args) => {
	try {
		return execFileSync(command, args, { encoding: "utf8", cwd: repo }).trim();
	} catch {
		return undefined;
	}
};

const major = Number(process.versions.node.split(".")[0]);
row("node >= 22", major >= 22, process.versions.node);

const pkg = readJson(path.join(repo, "package.json"));
for (const name of [
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-tui",
	"@howaboua/pi-codex-conversion",
]) {
	const wanted = pkg?.devDependencies?.[name];
	const installed = readJson(path.join(repo, "node_modules", name, "package.json"))?.version;
	row(
		`installed ${name} matches package.json`,
		wanted === installed,
		`${installed ?? "missing"} (wants ${wanted})`,
	);
}

const localCli = path.join(
	repo,
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
	"dist",
	"cli.js",
);
const driverPi = process.env.PREWALK_PI_EXECUTABLE ?? localCli;
const driverVersion = driverPi.endsWith(".js")
	? run(process.execPath, [driverPi, "--version"])
	: run(driverPi, ["--version"]);
row("driver Pi starts", Boolean(driverVersion), `${driverVersion ?? "failed"} · ${driverPi}`);
const pathVersion = run("pi", ["--version"]);
row(
	"Pi on PATH matches the driver Pi",
	pathVersion !== undefined && pathVersion === driverVersion,
	pathVersion ?? "pi not on PATH",
);

const liveSettings = readJson(path.join(homedir(), ".pi", "agent", "settings.json"));
const sources = (liveSettings?.packages ?? []).map((entry) =>
	typeof entry === "string" ? entry : entry?.source,
);
const live = sources.find(
	(source) => typeof source === "string" && path.resolve(source.replace(/^~/, homedir())) === repo,
);
row(
	"live Pi loads this checkout",
	true,
	live ? `yes (${live}); restart Pi after code changes` : "no; the driver is the only consumer",
);

const status = run("git", ["status", "--short", "--branch"]);
row("git status", true, status?.split("\n").slice(0, 8).join(" | "));
row(
	"extension entry exists",
	existsSync(path.join(repo, "extensions", "prewalk.ts")),
	"extensions/prewalk.ts",
);

for (const entry of rows)
	console.log(`${entry.ok ? "ok  " : "FAIL"} ${entry.name}: ${entry.detail ?? ""}`);
process.exitCode = rows.every((entry) => entry.ok) ? 0 : 1;
