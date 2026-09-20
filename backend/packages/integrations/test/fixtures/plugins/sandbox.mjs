import { open, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function register(context) {
	context.registerCommand({ name: "probe", description: "Probe sandbox boundaries.",
		inputSchema: { type: "object", properties: { outside: { type: "string" }, runtime: { type: "string" } },
			required: ["outside", "runtime"], additionalProperties: false } }, async (input) => {
		await writeFile("inside.txt", "allowed");
		const outsideReadable = await readFile(input.outside).then(() => true, () => false);
		const parentListable = await readdir(dirname(input.outside)).then(() => true, () => false);
		const runtimeWritable = await open(input.runtime, "r+").then(async (handle) => {
			await handle.close();
			return true;
		}, () => false);
		return { ok: true, summary: "probed", content: [], metadata: {
			outsideReadable, parentListable, runtimeWritable, hasSecret: process.env.MYCLI_API_KEY !== undefined,
		} };
	});
}
