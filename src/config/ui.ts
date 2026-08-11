import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONFIG_PAGE_SIZE = 8;

/** Keep long model lists readable without hiding a choice below the fold. */
export async function selectPaged(
	ctx: ExtensionContext,
	title: string,
	choices: string[],
): Promise<string | undefined> {
	if (choices.length <= CONFIG_PAGE_SIZE) return ctx.ui.select(title, choices);
	const pageCount = Math.ceil(choices.length / CONFIG_PAGE_SIZE);
	let page = 0;
	while (true) {
		const start = page * CONFIG_PAGE_SIZE;
		const visible = choices.slice(start, start + CONFIG_PAGE_SIZE);
		const previous = "← Previous page";
		const next = "Next page →";
		const options = [
			...visible,
			...(page > 0 ? [previous] : []),
			...(page < pageCount - 1 ? [next] : []),
		];
		const selected = await ctx.ui.select(`${title} (${page + 1}/${pageCount})`, options);
		if (!selected) return undefined;
		if (selected === previous) {
			page -= 1;
			continue;
		}
		if (selected === next) {
			page += 1;
			continue;
		}
		return selected;
	}
}
