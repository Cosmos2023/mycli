import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("tools load without an image decoder and contain decoder failures", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-image-decoder-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "image.png"), Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==",
		"base64",
	));
	const hook = dataUrl(`
		export async function resolve(specifier, context, nextResolve) {
			if (specifier === "sharp") throw new Error("decoder-missing /private/decoder-path");
			return nextResolve(specifier, context);
		}
	`);
	const register = dataUrl(`
		import { register } from "node:module";
		register(${JSON.stringify(hook)}, import.meta.url);
	`);
	const script = `
		import assert from "node:assert/strict";
		const { ViewImageTool, ToolRouter } = await import(${JSON.stringify(new URL("../../src/index.ts", import.meta.url).href)});
		const tool = new ViewImageTool({ workspaceRoot: ${JSON.stringify(root)}, homeDir: ${JSON.stringify(root)} });
		const router = new ToolRouter({ adapters: [tool], exposure: [tool.definition] });
		const result = await router.execute({ callId: "image", name: "view_image", argumentsJson: JSON.stringify({ path: "image.png" }) }, {
			signal: new AbortController().signal, ownerSessionId: "session", callId: "image", publishLifecycle: () => undefined,
		});
		assert.equal(result.success, false);
		assert.equal(result.errorKind, "invalid_image");
		assert.equal(result.images, undefined);
		assert.doesNotMatch(JSON.stringify(result), /decoder-missing|private|decoder-path/u);
		process.stdout.write("decoder-failure-contained");
	`;
	const result = await execFileAsync(process.execPath, [
		"--conditions=mycli-source", "--import", register, "--import", "tsx", "--input-type=module", "--eval", script,
	], { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 });
	assert.equal(result.stdout, "decoder-failure-contained");
});

function dataUrl(source: string): string {
	return `data:text/javascript,${encodeURIComponent(source)}`;
}
