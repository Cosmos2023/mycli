// A failed step's log needs authentication to download, so the only failure
// evidence an anonymous reader can fetch is a check annotation. GitHub renders
// `::error::` workflow commands as annotations.
export function reportFailingTests(output) {
	if (process.env.GITHUB_ACTIONS !== "true") return;
	const lines = output.split(/\r?\n/u);
	const messages = [];
	for (let index = 0; index < lines.length && messages.length < 40; index += 1) {
		const line = lines[index];
		if (!/^(?:✖ |test at )/u.test(line)) continue;
		messages.push(line);
		for (let extra = 1; extra <= 12 && index + extra < lines.length; extra += 1) {
			const raw = lines[index + extra];
			if (/^(?:✖ |ℹ |test at )/u.test(raw)) break;
			const detail = raw.trim();
			if (detail !== "") messages.push(`  ${detail}`);
		}
	}
	for (const message of messages.slice(0, 60)) {
		process.stdout.write(`::error::${message.replaceAll("%", "%25")}\n`);
	}
}