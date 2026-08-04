import assert from "node:assert/strict";
import {
	mkdtemp,
	mkdir,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as tools from "../src/index.ts";

test("resolves relative and absolute files inside the real workspace", async (t) => {
	const fixture = await workspaceFixture(t);
	const resolveReadableWorkspaceFile = requiredResolver();
	const expected = await realpath(fixture.file);

	assert.equal(await resolveReadableWorkspaceFile(fixture.root, "src/a.ts"), expected);
	assert.equal(await resolveReadableWorkspaceFile(fixture.root, fixture.file), expected);
});

test("rejects parent traversal and symlink escape before reading", async (t) => {
	const fixture = await workspaceFixture(t);
	const resolveReadableWorkspaceFile = requiredResolver();
	const outside = join(fixture.parent, "outside-secret.txt");
	await writeFile(outside, "private", "utf8");
	await symlink(outside, join(fixture.root, "outside-link"));

	await assert.rejects(
		() => resolveReadableWorkspaceFile(fixture.root, "../outside-secret.txt"),
		hasKind("workspace_escape"),
	);
	await assert.rejects(
		() => resolveReadableWorkspaceFile(fixture.root, "outside-link"),
		hasKind("workspace_escape"),
	);
});

test("classifies missing paths and directories", async (t) => {
	const fixture = await workspaceFixture(t);
	const resolveReadableWorkspaceFile = requiredResolver();

	await assert.rejects(
		() => resolveReadableWorkspaceFile(fixture.root, "missing.txt"),
		hasKind("not_found"),
	);
	await assert.rejects(
		() => resolveReadableWorkspaceFile(fixture.root, "src"),
		hasKind("is_directory"),
	);
});

type Resolver = (workspaceRoot: string, rawPath: string) => Promise<string>;

function requiredResolver(): Resolver {
	const value = Reflect.get(tools, "resolveReadableWorkspaceFile");
	assert.equal(typeof value, "function", "resolveReadableWorkspaceFile must be exported");
	return value as Resolver;
}

function hasKind(kind: string): (error: unknown) => boolean {
	return (error) => error instanceof Error
		&& "kind" in error
		&& error.kind === kind
		&& !error.message.includes("private");
}

async function workspaceFixture(t: test.TestContext): Promise<{
	readonly parent: string;
	readonly root: string;
	readonly file: string;
}> {
	const parent = await mkdtemp(join(tmpdir(), "mycli-read-path-"));
	t.after(async () => rm(parent, { recursive: true, force: true }));
	const root = join(parent, "workspace");
	const source = join(root, "src");
	const file = join(source, "a.ts");
	await mkdir(source, { recursive: true });
	await writeFile(file, "export {};\n", "utf8");
	return { parent, root, file };
}
