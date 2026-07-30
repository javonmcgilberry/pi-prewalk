import { createHash } from "node:crypto";

export function normalizeBaseUrl(value) {
	if (!value) return "";
	try {
		const url = new URL(value);
		url.username = "";
		url.password = "";
		url.hash = "";
		url.pathname = url.pathname.replace(/\/+$/, "") || "/";
		url.searchParams.sort();
		return url.toString();
	} catch {
		return value.trim().replace(/\/+$/, "");
	}
}

export function recipientFingerprint(modelRegistry, selected, options = {}) {
	const descriptor = modelRegistry.getRecipientDescriptor(selected);
	if (options.requireStreamIdentity && !descriptor.streamImplementationId) return undefined;
	const identity = JSON.stringify({
		provider: descriptor.provider,
		providerBaseUrl: normalizeBaseUrl(descriptor.providerBaseUrl),
		modelBaseUrl: normalizeBaseUrl(descriptor.modelBaseUrl),
		api: descriptor.api,
		model: descriptor.model,
		streamImplementationId: descriptor.streamImplementationId ?? "",
	});
	return createHash("sha256").update(identity).digest("hex");
}

// undefined means same-provider (no disclosure boundary); null means the exact
// cross-provider stream recipient cannot be identified and consent must fail.
export function recipientPair(modelRegistry, planner, target) {
	if (planner.provider === target.provider) return undefined;
	const plannerFingerprint = recipientFingerprint(modelRegistry, planner, {
		requireStreamIdentity: true,
	});
	const targetFingerprint = recipientFingerprint(modelRegistry, target, {
		requireStreamIdentity: true,
	});
	if (!plannerFingerprint || !targetFingerprint) return null;
	return `${plannerFingerprint}->${targetFingerprint}`;
}
