import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { loadGitReviewContext, MAX_REVIEW_CONTEXT_BYTES } from "../../src/review/git-context.ts";
import { prepareReview } from "../../src/review/review.ts";
import { readGitReviewFile } from "../../src/review/git-context.ts";
import { runCli } from "../../src/cli.ts";

const executeFile = promisify(execFile);

test("review targets cover combined changes, untracked paths, renames, base, and a single commit", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "old name.mjs"), "export const value = 1;\n");
	await writeFile(join(root, "deleted.mjs"), "export const old = true;\n");
	await git(root, ["add", "."]);
	await git(root, ["commit", "-qm", "base"]);
	const base = (await git(root, ["rev-parse", "HEAD"])).trim();
	await rename(join(root, "old name.mjs"), join(root, "new name.mjs"));
	await rm(join(root, "deleted.mjs"));
	await git(root, ["add", "."]);
	await git(root, ["commit", "-qm", "rename and delete"]);
	await writeFile(join(root, "new name.mjs"), "export const value = 2;\n");
	await git(root, ["add", "."]);
	await writeFile(join(root, "new name.mjs"), "export const value = 3;\n");
	await writeFile(join(root, "untracked file.mjs"), "export const untracked = true;\n");
	const before = await git(root, ["status", "--porcelain=v1", "-z"]);
	const dirty = await loadGitReviewContext(root, { kind: "uncommitted" }, new AbortController().signal);
	assert.match(dirty.diff, /value = 3/u);
	assert.doesNotMatch(dirty.diff, /value = 2/u);
	assert.equal(dirty.untracked[0]?.path, "untracked file.mjs");
	for (const target of [{ kind: "base", ref: base }, { kind: "commit", ref: "HEAD" }] as const) {
		const context = await loadGitReviewContext(root, target, new AbortController().signal);
		assert.match(context.diff, /rename from old name.mjs/u);
		assert.match(context.diff, /deleted file mode/u);
		assert.doesNotMatch(context.diff, /value = 3/u);
		assert.deepEqual(context.untracked, []);
	}
	assert.equal(await git(root, ["status", "--porcelain=v1", "-z"]), before);
	assert.equal(await readFile(join(root, "new name.mjs"), "utf8"), "export const value = 3;\n");
});

test("review handles an unborn repository and rejects excessive context and invalid refs", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "new.mjs"), "export const answer = 42;\n");
	await git(root, ["add", "."]);
	const context = await loadGitReviewContext(root, { kind: "uncommitted" }, new AbortController().signal);
	assert.match(context.diff, /answer = 42/u);
	await assert.rejects(loadGitReviewContext(root, { kind: "commit", ref: "--output=/tmp/invalid" }, new AbortController().signal), /review_git_failed/u);
	await writeFile(join(root, "large.txt"), "x".repeat(MAX_REVIEW_CONTEXT_BYTES + 1));
	await assert.rejects(loadGitReviewContext(root, { kind: "uncommitted" }, new AbortController().signal), /review_context_too_large/u);
});

test("review validates finding paths and concise line ranges against the actual diff", async (t) => {
	const root = await fixture(t);
	await writeFile(join(root, "changed.mjs"), "export const answer = 41;\n");
	const prepared = await prepareReview({ cwd: root, target: { kind: "uncommitted" }, signal: new AbortController().signal });
	const finding = { severity: "P2", title: "Wrong value", body: "A caller receives 41 instead of 42.", location: { path: "changed.mjs", start_line: 1, end_line: 1 } };
	assert.doesNotThrow(() => prepared.schema.validate(JSON.stringify({ summary: "One finding.", findings: [finding] })));
	for (const location of [{ path: "../outside", start_line: 1, end_line: 1 }, { path: "changed.mjs", start_line: 2, end_line: 1 }, { path: "changed.mjs", start_line: 1, end_line: 30 }, { path: "changed.mjs", start_line: 900, end_line: 901 }]) {
		assert.throws(() => prepared.schema.validate(JSON.stringify({ summary: "One finding.", findings: [{ ...finding, location }] })), /review_location_invalid/u);
	}
});

test("historical review reads Git blobs and validates paths independently of working-tree edits", async (t) => {
	const root = await fixture(t);
	const path = "file with spaces.mjs";
	await writeFile(join(root, path), "export const answer = 42;\n");
	await git(root, ["add", "."]);
	await git(root, ["commit", "-qm", "initial"]);
	const revision = (await git(root, ["rev-parse", "HEAD"])).trim();
	await writeFile(join(root, path), "export const answer = 99;\n");
	const signal = new AbortController().signal;
	assert.equal(await readGitReviewFile(root, revision, path, signal), "export const answer = 42;\n");
	await assert.rejects(readGitReviewFile(root, revision, "../outside", signal), /review_path_invalid/u);
	const prepared = await prepareReview({ cwd: root, target: { kind: "commit", ref: revision }, signal });
	assert.equal(prepared.revision, revision);
	assert.doesNotThrow(() => prepared.schema.validate(JSON.stringify({ summary: "One issue.", findings: [{ severity: "P2", title: "Issue", body: "Evidence", location: { path, start_line: 1, end_line: 1 } }] })));
});

test("empty reviews return without backend or provider startup", async (t) => {
	const root = await fixture(t);
	const output: string[] = [];
	const code = await runCli({ argv: ["review", "--json"], cwd: root, stdout: { write: (text) => output.push(text) }, startNodeBackend: () => assert.fail("unexpected backend startup") });
	assert.equal(code, 0);
	assert.deepEqual((JSON.parse(output.at(-1)!) as { structured_output: unknown }).structured_output, { summary: "No changes to review.", findings: [] });
});

async function fixture(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mycli-review-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "src"));
	await git(root, ["init", "-q"]);
	return root;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
	return (await executeFile("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-C", cwd, ...args], { encoding: "utf8" })).stdout;
}
