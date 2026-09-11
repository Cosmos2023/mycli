import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicPrivateFileUpdate } from "../src/index.ts";

test("private atomic writer rejects non-file names before creating state", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-private-writer-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "private");
	let buildCalls = 0;

	for (const fileName of ["", ".hidden", "../escape.json", "..\\escape.json", "nested/file.json"]) {
		await assert.rejects(atomicPrivateFileUpdate({
			directory,
			fileName,
			buildContent: () => {
				buildCalls += 1;
				return "private";
			},
		}), /invalid_private_file_name/u);
	}

	assert.equal(buildCalls, 0);
	await assert.rejects(stat(directory), { code: "ENOENT" });
});
