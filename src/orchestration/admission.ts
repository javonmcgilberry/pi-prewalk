export type AutomaticAdmission = "admit" | "bypass";

const BYPASS_PATTERNS = [
	/\b(do not|don't|without)\s+(chang(?:e|ing)|modif(?:y|ying)|edit(?:ing)?|implement(?:ing)?|writ(?:e|ing))\b/i,
	/\b(install|configure|configuration|setup|set up|upgrade|update settings)\b/i,
	/\b(research|explain|investigate|analyze|analysis|why|how does)\b/i,
	/\bdiagnos(?:e|is)\b(?!.*\b(fix|implement|build)\b)/i,
	/\b(git status|npm install|pnpm install|one-off|operational command)\b/i,
	/\b(one|single|small)\s+(file|edit|change|label|copy|line)\b/i,
];

const IMPLEMENTATION_PATTERN =
	/\b(implement|build|fix|refactor|migrate|migration|feature|execute)\b/i;
const SUBSTANTIAL_PATTERNS = [
	/\b(approved|exact)\b.*\bplan\b/i,
	/\b(cross[- ]cutting|end[- ]to[- ]end|multiple[- ]concerns|across)\b/i,
	/\b(reproduction|regression test)\b/i,
	/\b(substantial|large)\s+(refactor|migration|feature)\b/i,
];

export function admitAutomaticPrewalk(text: string): AutomaticAdmission {
	const withoutQuotedText = text.replace(/["'`][^"'`]*["'`]/g, "");
	if (BYPASS_PATTERNS.some((pattern) => pattern.test(withoutQuotedText))) return "bypass";
	if (!IMPLEMENTATION_PATTERN.test(withoutQuotedText)) return "bypass";
	return SUBSTANTIAL_PATTERNS.some((pattern) => pattern.test(withoutQuotedText))
		? "admit"
		: "bypass";
}
