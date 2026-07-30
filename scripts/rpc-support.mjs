import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline";

const MODEL_REF = /^([a-z0-9][a-z0-9._-]*)\/(.+)$/i;

export function parseModelRef(value) {
	const match = typeof value === "string" ? MODEL_REF.exec(value) : undefined;
	if (!match || !match[2]?.trim()) throw new Error("Model must be provider/model.");
	return { provider: match[1], id: match[2] };
}

export function buildRpcLaunchArgs({
	extensionPath,
	sessionPath,
	model,
	thinking = "off",
	extraExtensions = [],
}) {
	parseModelRef(model);
	if (!path.isAbsolute(extensionPath) || !path.isAbsolute(sessionPath)) {
		throw new Error("RPC smoke paths must be absolute.");
	}
	return [
		"--mode",
		"rpc",
		"--session",
		sessionPath,
		"--model",
		model,
		"--thinking",
		thinking,
		"-e",
		extensionPath,
		...extraExtensions.flatMap((entry) => ["-e", entry]),
	];
}

export function resolvePiLaunch(executable, args) {
	const resolved = path.resolve(executable);
	return resolved.endsWith(".js") || resolved.endsWith(".mjs")
		? { command: process.execPath, args: [resolved, ...args] }
		: { command: resolved, args };
}

export class RpcProcess {
	constructor({ executable, args, cwd, env, timeoutMs = 30_000, onEvent }) {
		const launch = resolvePiLaunch(executable, args);
		this.timeoutMs = timeoutMs;
		this.events = [];
		this.stderr = "";
		this.pending = new Map();
		this.waiters = new Set();
		this.child = spawn(launch.command, launch.args, {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stderr.on("data", (chunk) => {
			this.stderr += chunk.toString();
		});
		this.child.once("exit", (code, signal) => {
			const error = new Error(
				`Pi RPC exited before completion (code=${code}, signal=${signal}). ${this.stderr.slice(-2_000)}`,
			);
			for (const pending of this.pending.values()) pending.reject(error);
			this.pending.clear();
			for (const waiter of this.waiters) waiter.reject(error);
			this.waiters.clear();
		});
		const lines = readline.createInterface({ input: this.child.stdout });
		lines.on("line", (line) => {
			let value;
			try {
				value = JSON.parse(line);
			} catch {
				return;
			}
			if (value.type === "response" && value.id && this.pending.has(value.id)) {
				const pending = this.pending.get(value.id);
				this.pending.delete(value.id);
				if (value.success === false)
					pending.reject(new Error(value.error ?? `${value.command} failed`));
				else pending.resolve(value);
				return;
			}
			this.events.push(value);
			onEvent?.(value, this);
			for (const waiter of [...this.waiters]) {
				if (!waiter.predicate(value)) continue;
				this.waiters.delete(waiter);
				clearTimeout(waiter.timer);
				waiter.resolve(value);
			}
		});
	}

	async send(command, timeoutMs = this.timeoutMs) {
		const id = command.id ?? randomUUID();
		const response = new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new Error(`RPC command ${command.type} timed out. ${this.stderr.slice(-2_000)}`),
				);
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
		});
		this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		return response;
	}

	waitFor(predicate, timeoutMs = this.timeoutMs, startIndex = 0) {
		const existing = this.events.slice(startIndex).find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const waiter = { predicate, resolve, reject, timer: undefined };
			waiter.timer = setTimeout(() => {
				this.waiters.delete(waiter);
				reject(new Error(`RPC event timed out. ${this.stderr.slice(-2_000)}`));
			}, timeoutMs);
			this.waiters.add(waiter);
		});
	}

	async close() {
		if (this.child.exitCode !== null) return;
		this.child.stdin.end();
		const exited = new Promise((resolve) => this.child.once("exit", resolve));
		const timer = setTimeout(() => this.child.kill("SIGTERM"), 2_000);
		await exited;
		clearTimeout(timer);
	}
}

export function actionableStderr(stderr) {
	return stderr
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((line) => /\b(error|failed|unknown option|uncaught|exception)\b/i.test(line));
}
