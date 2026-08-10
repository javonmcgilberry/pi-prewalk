import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ANALYTICS_CONFIG } from "../../src/analytics/index.js";
import { PrewalkAnalytics } from "../../src/analytics/run-accounting.js";
import {
	createPrewalkRun,
	DEFAULT_EXECUTOR,
	DEFAULT_PLANNER,
} from "../../src/orchestration/coordinator.js";

const roots: string[] = [];
const usage: Usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};

const host = {
	sessionId: "session-1",
	findModel: (provider: string, model: string) => ({
		provider,
		id: model,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	}),
};

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PrewalkAnalytics", () => {
	it("owns an active journal through usage and receipt promotion", async () => {
		const root = await mkdtemp(`${tmpdir()}/prewalk-analytics-facade-`);
		roots.push(root);
		const analytics = new PrewalkAnalytics(root);
		const run = createPrewalkRun(
			"run-1",
			"epoch-1",
			"manual",
			true,
			{ ...DEFAULT_PLANNER, reasoning: "high" },
			{ executor: { ...DEFAULT_EXECUTOR }, analytics: DEFAULT_ANALYTICS_CONFIG },
		);
		await analytics.open(run, host);
		expect(analytics.hasStateFor(run)).toBe(true);
		await analytics.recordUsage(
			"assistant",
			"message-1",
			"provider",
			"planner",
			"planner-primary",
			usage,
			run,
		);
		await analytics.finalize("succeeded", run);
		expect(analytics.active).toBe(false);
		expect((await analytics.listReceipts()).map((receipt) => receipt.runId)).toEqual(["run-1"]);
	});
});
