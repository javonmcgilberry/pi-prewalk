import { describe, expect, it } from "vitest";
import { admitAutomaticPrewalk } from "../src/admission.js";

describe("automatic Prewalk admission", () => {
	it.each([
		["Implement the approved migration plan in docs/plans/cam-1.md", "admit"],
		["Build an end-to-end feature that updates the editor, API, and analytics", "admit"],
		["Fix the production bug with reproduction and a regression test", "admit"],
		["Diagnose and fix a cross-cutting regression with reproduction", "admit"],
		["Diagnose the production regression", "bypass"],
		["Refactor the component architecture across the campaign domain", "admit"],
		["Install the Figma skill", "bypass"],
		["Explain how the quoted request 'implement a migration' would work", "bypass"],
		["Diagnose the SSL failure without changing anything", "bypass"],
		[
			"Don't change anything. Implement the approved migration plan with the existing docs.",
			"bypass",
		],
		["Configure the executor reasoning to medium", "bypass"],
		["Run git status", "bypass"],
		["Change the button label in one file", "bypass"],
		["Could you help with this?", "bypass"],
	])("classifies %s as %s", (text, expected) => {
		expect(admitAutomaticPrewalk(text)).toBe(expected);
	});
});
