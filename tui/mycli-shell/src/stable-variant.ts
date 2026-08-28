export function stableVariantIndex(value: string, count: number): number {
	if (!Number.isInteger(count) || count <= 0) {
		throw new RangeError("Variant count must be a positive integer");
	}

	let hash = 2_166_136_261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return (hash >>> 0) % count;
}
