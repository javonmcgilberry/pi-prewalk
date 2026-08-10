import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPrewalkExtension } from "../src/pi/create-prewalk-extension.js";

export default function prewalkExtension(pi: ExtensionAPI): void {
	createPrewalkExtension(pi);
}
