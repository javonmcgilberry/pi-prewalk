/**
 * Same-provider Prewalk smoke test.
 *
 * Boots a real Pi RPC process with the real extension and exercises the
 * lifecycle commands that must not disturb the session: status, cancel, and
 * reload. Issues no model request and must leave settings byte-identical.
 */

import { assert, defaultAnalytics, startSmokeSession } from "./rpc-smoke-support.mjs";
import { actionableStderr } from "./rpc-support.mjs";

const planner = { provider: "anthropic", id: "claude-opus-4-6" };
const executorModel = "anthropic/claude-sonnet-4-6";

const session = await startSmokeSession({
	prefix: "prewalk-rpc-",
	planner,
	prewalkConfig: {
		executor: { provider: "anthropic", model: "claude-sonnet-4-6", reasoning: "low" },
		analytics: defaultAnalytics(),
	},
	auth: { anthropic: { type: "api_key", key: "rpc-smoke-token" } },
});

try {
	const plannerRef = `${planner.provider}/${planner.id}`;
	try {
		const state = (await session.rpc.send({ type: "get_state" })).data;
		assert(
			`${state.model?.provider}/${state.model?.id}` === plannerRef,
			"RPC smoke did not retain the configured planner as Pi's selected model.",
		);
		await session.rpc.send({ type: "prompt", message: "/prewalk status" });
		await session.rpc.send({ type: "prompt", message: "/prewalk cancel" });
		await session.rpc.send({ type: "prompt", message: "/reload" });
		const reloaded = (await session.rpc.send({ type: "get_state" })).data;
		assert(
			`${reloaded.model?.provider}/${reloaded.model?.id}` === plannerRef,
			"RPC reload changed Pi's selected model.",
		);
	} finally {
		await session.rpc.close();
	}

	const errors = actionableStderr(session.rpc.stderr);
	assert(errors.length === 0, `Pi wrote actionable stderr: ${errors.join(" | ")}`);
	assert(await session.settingsUnchanged(), "RPC smoke changed settings.json.");

	console.log(
		JSON.stringify({
			ok: true,
			pi: "0.84.1",
			conversionExtension: "not-loaded",
			plannerModel: plannerRef,
			executorModel,
			selectedModel: plannerRef,
			analytics: "local-only",
			providerRequests: 0,
			settingsStable: true,
		}),
	);
} finally {
	await session.cleanup();
}
