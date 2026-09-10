export function nextImagePlaceholder(text: string, images: readonly { readonly placeholder: string }[]): string {
	const occupied = new Set(images.map((image) => image.placeholder));
	for (const match of text.matchAll(/\[image #\d+\]/gu)) occupied.add(match[0]);
	let largest = 0;
	for (const placeholder of occupied) {
		const value = Number(/^\[image #(\d+)\]$/u.exec(placeholder)?.[1]);
		if (Number.isSafeInteger(value) && value < Number.MAX_SAFE_INTEGER) largest = Math.max(largest, value);
	}
	let next = largest + 1;
	if (occupied.has(`[image #${next}]`)) {
		next = 1;
		while (occupied.has(`[image #${next}]`)) next += 1;
	}
	return `[image #${next}]`;
}
