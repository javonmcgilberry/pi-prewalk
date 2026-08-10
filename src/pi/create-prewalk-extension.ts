import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPrewalkEvents } from "./register-events.js";

/** Pi's package entry composition hook; product policy lives behind the adapter. */
export function createPrewalkExtension(pi: ExtensionAPI): void {
	registerPrewalkEvents(pi);
}
