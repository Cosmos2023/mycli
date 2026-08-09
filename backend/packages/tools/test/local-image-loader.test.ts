import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	loadLocalImages,
	LocalImageInputError,
} from "../src/local-image-loader.ts";

test("loads supported local images as bounded canonical data", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-images-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "sample.png"), Buffer.from("image-data"));

	const result = loadLocalImages(["~/sample.png"], { cwd: root, homeDir: root });

	assert.deepEqual(result, [{
		mediaType: "image/png",
		data: Buffer.from("image-data").toString("base64"),
	}]);
});

test("rejects unsupported, missing, and oversized attachments without exposing paths", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-images-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const unsupported = join(root, "private-name.txt");
	await writeFile(unsupported, "not an image", "utf8");

	for (const [path, expected] of [
		[unsupported, "image attachment has an unsupported file type"],
		[join(root, "private-missing.png"), "image attachment is not a readable file"],
	] as const) {
		assert.throws(
			() => loadLocalImages([path], { cwd: root, homeDir: root }),
			(error: unknown) => error instanceof LocalImageInputError
				&& error.code === "invalid_params"
				&& error.message === expected
				&& !error.message.includes("private"),
		);
	}

	await writeFile(join(root, "large.webp"), Buffer.alloc(5));
	assert.throws(
		() => loadLocalImages(["large.webp"], {
			cwd: root,
			homeDir: root,
			maxImageBytes: 4,
		}),
		/image attachment exceeds the per-file size limit/,
	);
});
