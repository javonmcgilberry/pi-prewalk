import { describe, expect, it } from "vitest";
import {
	isBoolean as isScriptBoolean,
	isNumber as isScriptNumber,
	isString as isScriptString,
} from "../scripts/value-contracts.mjs";
import { isBoolean, isNumber, isString } from "../src/guards.ts";

describe("primitive value contracts", () => {
	it("rejects boxed strings in both runtimes", () => {
		const boxed = Reflect.construct(String, ["value"]);
		expect(isString("value")).toBe(true);
		expect(isString(boxed)).toBe(false);
		expect(isScriptString("value")).toBe(true);
		expect(isScriptString(boxed)).toBe(false);
	});

	it("rejects boxed numbers in both runtimes", () => {
		const boxed = Reflect.construct(Number, [7]);
		expect(isNumber(7)).toBe(true);
		expect(isNumber(boxed)).toBe(false);
		expect(isScriptNumber(7)).toBe(true);
		expect(isScriptNumber(boxed)).toBe(false);
	});

	it("rejects boxed booleans in both runtimes", () => {
		const boxed = Reflect.construct(Boolean, [true]);
		expect(isBoolean(true)).toBe(true);
		expect(isBoolean(boxed)).toBe(false);
		expect(isScriptBoolean(true)).toBe(true);
		expect(isScriptBoolean(boxed)).toBe(false);
	});
});
