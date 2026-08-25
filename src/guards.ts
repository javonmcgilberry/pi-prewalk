export type BoundaryValue = null | boolean | number | string | object | undefined;
export type DomainObject<T = BoundaryValue> = { [key: string]: T };

export function isRecord<T>(value: T): value is T & DomainObject {
	return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function isPrimitiveWithTag<T>(value: T, tag: string): boolean {
	return Object(value) !== value && Object.prototype.toString.call(value) === tag;
}

export function isString<T>(value: T): value is Extract<T, string> {
	return isPrimitiveWithTag(value, "[object String]");
}

export function isNumber<T>(value: T): value is Extract<T, number> {
	return isPrimitiveWithTag(value, "[object Number]");
}

export function isBoolean<T>(value: T): value is Extract<T, boolean> {
	return isPrimitiveWithTag(value, "[object Boolean]");
}

export function parseBoundaryValue<T>(value: T): BoundaryValue {
	if (value === null) return null;
	if (value === undefined) return undefined;
	if (
		isString(value) ||
		isNumber(value) ||
		isBoolean(value) ||
		isRecord(value) ||
		Array.isArray(value)
	)
		return value;
	return undefined;
}
