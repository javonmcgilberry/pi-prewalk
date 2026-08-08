/**
 * Cross-provider Prewalk smoke test.
 *
 * Arms a run whose planner and executor sit on different providers and
 * different Pi APIs, inside a real Pi RPC process running the real extension.
 * No model request is issued: arming needs registry metadata and a configured
 * auth entry, nothing more.
 *
 * Asserts against the audit trail rather than stderr. A refused arm never
 * reaches stderr, so a stderr-only check reports success for a broken build.
 */

import {
	assert,
	defaultAnalytics,
	readAuditRecords,
	startSmokeSession,
} from "./rpc-smoke-support.mjs";
import { actionableStderr } from "./rpc-support.mjs";

// anthropic-messages (1,000,000) to google-generative-ai (1,048,576): a
// different provider, a different API, and an executor that clears the context
// floor. Both authenticate with a plain key, so no token refresh is involved.
const planner = { provider: "anthropic", id: "claude-opus-4-6" };
const executor = { provider: "google", id: "gemini-3.5-flash" };

const session = await startSmokeSession({
	prefix: "prewalk-xprov-",
	planner,
	prewalkConfig: {
		executor: { provider: executor.provider, model: executor.id, reasoning: "low" },
		executorFallbacks: [{ provider: "anthropic", model: "claude-sonnet-4-6", reasoning: "low" }],
		analytics: defaultAnalytics(),
	},
	auth: {
		anthropic: { type: "api_key", key: "xprov-smoke-anthropic" },
		google: { type: "api_key", key: "xprov-smoke-google" },
	},
});

try {
	const plannerRef = `${planner.provider}/${planner.id}`;
	try {
		const state = (await session.rpc.send({ type: "get_state" })).data;
		assert(
			`${state.model?.provider}/${state.model?.id}` === plannerRef,
			`Planner not selected: ${state.model?.provider}/${state.model?.id}`,
		);
		// Arming runs planner validation, the executor chain, and overlay install.
		await session.rpc.send({ type: "prompt", message: "/prewalk run" });
		const after = (await session.rpc.send({ type: "get_state" })).data;
		assert(
			`${after.model?.provider}/${after.model?.id}` === plannerRef,
			"Arming changed Pi's selected model; Prewalk must leave the planner selected.",
		);
	} finally {
		await session.rpc.close();
	}

	const errors = actionableStderr(session.rpc.stderr);
	assert(errors.length === 0, `Pi wrote actionable stderr: ${errors.join(" | ")}`);
	assert(await session.settingsUnchanged(), "Smoke changed settings.json.");

	const audits = await readAuditRecords(session.sessionPath);
	const events = audits.map((record) => record.event);
	const armed = audits.find((record) => record.event === "armed");
	assert(armed !== undefined, `Prewalk never armed. Events seen: ${events.join(", ") || "none"}`);
	assert(armed.reasonCode === undefined, `Prewalk armed with a failure: ${armed.reasonCode}`);
	assert(
		armed.executor?.provider === executor.provider && armed.executor?.model === executor.id,
		`Prewalk chose ${armed.executor?.provider}/${armed.executor?.model}, expected ${executor.provider}/${executor.id}`,
	);
	assert(
		armed.planner?.provider === planner.provider && armed.planner?.model === planner.id,
		`Prewalk recorded planner ${armed.planner?.provider}/${armed.planner?.model}`,
	);
	const failed = audits.filter((record) => record.event === "failed");
	assert(failed.length === 0, `Prewalk failed: ${failed.map((f) => f.reasonCode).join(", ")}`);

	console.log(
		JSON.stringify({
			ok: true,
			plannerModel: plannerRef,
			plannerApi: "anthropic-messages",
			executorModel: `${executor.provider}/${executor.id}`,
			executorApi: "google-generative-ai",
			crossProvider: true,
			crossApi: true,
			auditEvents: events,
			selectedModelUnchanged: true,
			settingsStable: true,
			providerRequests: 0,
		}),
	);
} finally {
	await session.cleanup();
}
