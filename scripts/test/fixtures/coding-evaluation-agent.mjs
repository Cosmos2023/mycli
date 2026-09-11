import { writeFile } from "node:fs/promises";

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
if (prompt.includes("range.mjs")) {
	await writeFile("range.mjs", "export function range(start, end, step = 1) { if (step <= 0) throw new RangeError(); return Array.from({ length: Math.max(0, Math.floor((end - start) / step) + 1) }, (_, i) => start + i * step); }\n");
} else if (prompt.includes("src/index.mjs")) {
	await writeFile("src/key.mjs", "export function normalizeKey(key) { return key.trim().toLowerCase(); }\n");
	await writeFile("src/index.mjs", "import { normalizeKey } from './key.mjs'; export function lookup(entries, key) { return new Map(entries.map(([k,v]) => [normalizeKey(k),v])).get(normalizeKey(key)) ?? null; }\n");
} else {
	await writeFile("price.mjs", "export function calculateTotal(unitPrice, quantity) { return Math.round(unitPrice * quantity * 100); }\n");
	await writeFile("compliance.json", JSON.stringify({ currency: "USD", rounding: "half-up", package: "service" }));
}
process.stdout.write(`${JSON.stringify({ type: "tool.started", name: "Write" })}\n`);
process.stdout.write(`${JSON.stringify({ type: "exec.result", status: "completed", usage: { input_tokens: 10, output_tokens: 20 } })}\n`);
