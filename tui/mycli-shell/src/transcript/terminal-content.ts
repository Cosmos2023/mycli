const C1_INTRODUCERS: Readonly<Partial<Record<number, string>>> = {
	0x90: "P", 0x98: "X", 0x9b: "[", 0x9d: "]", 0x9e: "^", 0x9f: "_",
};

/** Keep external content printable; terminal control belongs to the renderer. */
export function terminalContent(text: string): string {
	const parts: string[] = [];
	let styled = false;
	let start = 0;
	for (let index = 0; index < text.length;) {
		const code = text.charCodeAt(index);
		if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
			index += 1;
			continue;
		}
		parts.push(text.slice(start, index));
		const escapeStart = index;
		const introducer = code === 0x1b ? text[++index] : C1_INTRODUCERS[code];
		if (introducer === "[") {
			index += 1;
			while (index < text.length && /[0-? -/]/u.test(text[index]!)) index += 1;
			if (index < text.length && /[@-~]/u.test(text[index]!)) index += 1;
			const sequence = text.slice(escapeStart, index);
			if (/^\x1b\[[0-9;:]*m$/u.test(sequence)) {
				parts.push(sequence);
				styled = true;
			}
		} else if (introducer && "]PX^_".includes(introducer)) {
			index += 1;
			while (index < text.length) {
				if (text[index] === "\x9c" || (introducer === "]" && text[index] === "\x07")) {
					index += 1;
					break;
				}
				if (text[index] === "\x1b" && text[index + 1] === "\\") {
					index += 2;
					break;
				}
				index += 1;
			}
		} else if (code === 0x1b) {
			while (index < text.length && /[ -/]/u.test(text[index]!)) index += 1;
			if (index < text.length && /[0-~]/u.test(text[index]!)) index += 1;
		} else {
			if (code === 0x0a || (code === 0x0d && text[index + 1] !== "\n")) parts.push("\n");
			if (code === 0x09) parts.push("   ");
			index += 1;
		}
		start = index;
	}
	parts.push(text.slice(start));
	if (styled) parts.push("\x1b[0m");
	return parts.join("");
}
