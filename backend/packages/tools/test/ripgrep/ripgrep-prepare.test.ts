import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import AdmZip from "adm-zip";
import { create as createTar } from "tar";
import {
	extractRipgrepMember,
	prepareUserRipgrep,
	ripgrepOutputPath,
	verifyRipgrepArchive,
} from "../../src/index.ts";

test("prepare reuses an existing user-vendored binary without network work", async (t) => {
	const destinationRoot = await temporaryDirectory(t);
	const outputPath = ripgrepOutputPath(destinationRoot, "macos-aarch64");
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, "existing", "utf8");
	let downloads = 0;

	const result = await prepareUserRipgrep({
		target: "macos-aarch64",
		destinationRoot,
		downloadArchive: async () => { downloads += 1; },
	});

	assert.deepEqual(result, { path: outputPath, installed: false });
	assert.equal(downloads, 0);
});

test("prepare rejects invalid custom download timeouts before network work", async (t) => {
	const destinationRoot = await temporaryDirectory(t);
	let downloads = 0;

	await assert.rejects(() => prepareUserRipgrep({
		destinationRoot,
		downloadTimeoutMs: 300_001,
		downloadArchive: async () => { downloads += 1; },
	}), /download timeout must be between/u);
	assert.equal(downloads, 0);
	assert.deepEqual(await readdir(destinationRoot), []);
});

test("prepare retries a failed download after removing the partial archive", async (t) => {
	const destinationRoot = await temporaryDirectory(t);
	let downloads = 0;
	const result = await prepareUserRipgrep({
		target: "linux-x86_64",
		destinationRoot,
		downloadAttempts: 2,
		downloadArchive: async (_url, destination) => {
			downloads += 1;
			await writeFile(destination, downloads === 1 ? "partial" : "archive", "utf8");
			if (downloads === 1) throw new Error("transient download failure");
		},
		verifyArchive: async (path) => {
			assert.equal(await readFile(path, "utf8"), "archive");
		},
		extractMember: async (_archive, member, root) => {
			const extracted = join(root, member);
			await mkdir(dirname(extracted), { recursive: true });
			await writeFile(extracted, "ripgrep", "utf8");
			return extracted;
		},
	});

	assert.equal(downloads, 2);
	assert.equal(await readFile(result.path, "utf8"), "ripgrep");
});

test("prepare verifies, extracts, permissions, and atomically installs the binary", async (t) => {
	const destinationRoot = await temporaryDirectory(t);
	const calls: string[] = [];
	const result = await prepareUserRipgrep({
		target: "linux-x86_64",
		destinationRoot,
		downloadArchive: async (url, destination, signal) => {
			assert.equal(signal.aborted, false);
			assert.match(url, /ripgrep-15\.1\.0-x86_64-unknown-linux-musl\.tar\.gz$/u);
			calls.push("download");
			await writeFile(destination, "archive", "utf8");
		},
		verifyArchive: async (path, expected) => {
			calls.push("verify");
			assert.equal(await readFile(path, "utf8"), "archive");
			assert.equal(expected, "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599");
		},
		extractMember: async (_archive, member, root) => {
			calls.push("extract");
			assert.equal(member, "ripgrep-15.1.0-x86_64-unknown-linux-musl/rg");
			const extracted = join(root, member);
			await mkdir(dirname(extracted), { recursive: true });
			await writeFile(extracted, "#!/bin/sh\nprintf 'ripgrep 15.1.0'\n", "utf8");
			return extracted;
		},
	});

	assert.deepEqual(calls, ["download", "verify", "extract"]);
	assert.equal(result.installed, true);
	assert.equal(await readFile(result.path, "utf8"), "#!/bin/sh\nprintf 'ripgrep 15.1.0'\n");
	if (process.platform !== "win32") {
		assert.equal((await stat(result.path)).mode & 0o111, 0o111);
	}
	assert.deepEqual((await readdir(dirname(result.path))).filter((name) => name.startsWith(".")), []);
});

test("a failed forced refresh preserves the previously installed binary", async (t) => {
	const destinationRoot = await temporaryDirectory(t);
	const outputPath = ripgrepOutputPath(destinationRoot, "linux-x86_64");
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, "previous-ripgrep", "utf8");

	await assert.rejects(() => prepareUserRipgrep({
		target: "linux-x86_64",
		destinationRoot,
		force: true,
		downloadArchive: async (_url, destination) => {
			await writeFile(destination, "new-archive", "utf8");
		},
		verifyArchive: async () => { throw new Error("checksum mismatch"); },
	}), /checksum mismatch/u);

	assert.equal(await readFile(outputPath, "utf8"), "previous-ripgrep");
	assert.deepEqual((await readdir(dirname(outputPath))).filter((name) => name.startsWith(".")), []);
});

test("sha256 verification rejects mismatched archives without leaking digests", async (t) => {
	const root = await temporaryDirectory(t);
	const archive = join(root, "archive.tar.gz");
	await writeFile(archive, "content", "utf8");
	const expected = createHash("sha256").update("different").digest("hex");

	await assert.rejects(
		() => verifyRipgrepArchive(archive, expected),
		(error: unknown) => error instanceof Error
			&& /sha256 mismatch/u.test(error.message)
			&& !error.message.includes(expected),
	);
});

test("archive extraction reads only the requested tar and zip member", async (t) => {
	const root = await temporaryDirectory(t);
	const source = join(root, "source");
	const member = "ripgrep-test/rg";
	const sourceBinary = join(source, member);
	await mkdir(dirname(sourceBinary), { recursive: true });
	await writeFile(sourceBinary, "ripgrep-test", "utf8");

	const tarPath = join(root, "ripgrep.tar.gz");
	await createTar({ cwd: source, file: tarPath, gzip: true }, [member]);
	const tarOutput = await extractRipgrepMember(tarPath, member, join(root, "tar-output"));
	assert.equal(await readFile(tarOutput, "utf8"), "ripgrep-test");

	const zipPath = join(root, "ripgrep.zip");
	const zip = new AdmZip();
	zip.addFile(member, Buffer.from("ripgrep-test"));
	await zip.writeZipPromise(zipPath);
	const zipOutput = await extractRipgrepMember(zipPath, member, join(root, "zip-output"));
	assert.equal(await readFile(zipOutput, "utf8"), "ripgrep-test");

	await assert.rejects(
		() => extractRipgrepMember(zipPath, "../rg", join(root, "blocked")),
		/archive member escapes destination/u,
	);
	await access(zipOutput);
});

async function temporaryDirectory(t: TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "mycli-ripgrep-prepare-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}
