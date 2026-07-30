interface RecipientModel {
	provider: string;
	id: string;
	api: string;
	baseUrl?: string;
}

interface RecipientDescriptor {
	provider: string;
	providerBaseUrl?: string;
	modelBaseUrl?: string;
	api: string;
	model: string;
	streamImplementationId?: string;
}

interface RecipientRegistry {
	getRecipientDescriptor(model: RecipientModel): RecipientDescriptor;
}

export function normalizeBaseUrl(value: string | undefined): string;
export function recipientFingerprint(
	modelRegistry: RecipientRegistry,
	selected: RecipientModel,
	options?: { requireStreamIdentity?: boolean },
): string | undefined;
/** undefined = same provider; null = cross-provider identity unavailable. */
export function recipientPair(
	modelRegistry: RecipientRegistry,
	planner: RecipientModel,
	target: RecipientModel,
): string | null | undefined;
