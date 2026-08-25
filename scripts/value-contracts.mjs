const objectTag = Object.prototype.toString;

export function isRecord(value) {
	return value !== null && objectTag.call(value) === "[object Object]";
}

function isPrimitiveWithTag(value, tag) {
	return Object(value) !== value && objectTag.call(value) === tag;
}

export function isString(value) {
	return isPrimitiveWithTag(value, "[object String]");
}

export function isNumber(value) {
	return isPrimitiveWithTag(value, "[object Number]");
}

export function isBoolean(value) {
	return isPrimitiveWithTag(value, "[object Boolean]");
}

export function isFunction(value) {
	return objectTag.call(value).endsWith("Function]");
}
