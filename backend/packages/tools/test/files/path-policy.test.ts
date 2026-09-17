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
import * as tools from "../../src/index.ts";

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

test("resolves outside files only with unrestricted path access", async (t) => {
	const fixture = await workspaceFixture(t);
	const resolveReadableWorkspaceFile = requiredResolver();
	const outside = join(fixture.parent, "outside.txt");
	await writeFile(outside, "outside", "utf8");
	await symlink(outside, join(fixture.root, "outside-link"));
	const unrestricted = { allowOutsideWorkspace: true };

	assert.equal(
		await resolveReadableWorkspaceFile(fixture.root, "../outside.txt", unrestricted),
		await realpath(outside),
	);
	assert.equal(
		await resolveReadableWorkspaceFile(fixture.root, "outside-link", unrestricted),
		await realpath(outside),
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

test("resolves existing and new mutation targets under the real workspace", async (t) => {
	const fixture = await workspaceFixture(t);
	const resolveWritableWorkspaceFile = requiredWritableResolver();
	const expectedExisting = await realpath(fixture.file);

	const existing = await resolveWritableWorkspaceFile(fixture.root, "src/a.ts");
	const created = await resolveWritableWorkspaceFile(fixture.root, "generated/deep/a.ts");

	assert.deepEqual(existing, {
		workspaceRoot: await realpath(fixture.root),
		target: expectedExisting,
		relativePath: "src/a.ts",
		existed: true,
	});
	assert.equal(created.workspaceRoot, await realpath(fixture.root));
	assert.equal(created.target, join(await realpath(fixture.root), "generated", "deep", "a.ts"));
	assert.equal(created.relativePath, "generated/deep/a.ts");
	assert.equal(created.existed, false);
});

test("allows internal symlinks and resolves their real mutation target", async (t) => {
	const fixture = await workspaceFixture(t);
	const resolveWritableWorkspaceFile = requiredWritableResolver();
	await symlink(fixture.file, join(fixture.root, "internal-link"));

	const resolved = await resolveWritableWorkspaceFile(fixture.root, "internal-link");

	assert.equal(resolved.target, await realpath(fixture.file));
	assert.equal(resolved.relativePath, "src/a.ts");
	assert.equal(resolved.existed, true);
});

test("rejects traversal absolute escape and symbolic-link mutation escape", async (t) => {
	const fixture = await workspaceFixture(t);
	const resolveWritableWorkspaceFile = requiredWritableResolver();
	const outside = join(fixture.parent, "outside-secret.txt");
	await writeFile(outside, "private", "utf8");
	await symlink(outside, join(fixture.root, "outside-link"));

	for (const path of ["../outside-secret.txt", outside, "outside-link"] as const) {
		await assert.rejects(
			() => resolveWritableWorkspaceFile(fixture.root, path),
			hasKind("workspace_escape"),
		);
	}
});

test("resolves existing and new outside mutation targets only with unrestricted access", async (t) => {
	const fixture = await workspaceFixture(t);
	const resolveWritableWorkspaceFile = requiredWritableResolver();
	const outside = join(fixture.parent, "outside.txt");
	const createdPath = join(fixture.parent, "generated", "new.txt");
	await writeFile(outside, "outside", "utf8");
	const unrestricted = { allowOutsideWorkspace: true };

	const existing = await resolveWritableWorkspaceFile(fixture.root, outside, unrestricted);
	const created = await resolveWritableWorkspaceFile(fixture.root, createdPath, unrestricted);
	const canonicalCreatedPath = join(await realpath(fixture.parent), "generated", "new.txt");

	assert.equal(existing.target, await realpath(outside));
	assert.equal(existing.relativePath, await realpath(outside));
	assert.equal(existing.existed, true);
	assert.equal(created.target, canonicalCreatedPath);
	assert.equal(created.relativePath, canonicalCreatedPath);
	assert.equal(created.existed, false);
});

test("confines outside mutations to exact granted writable roots", async (t) => {
	const fixture = await workspaceFixture(t);
	const resolveWritableWorkspaceFile = requiredWritableResolver();
	const grantedRoot = join(fixture.parent, "exports");
	const denied = join(fixture.parent, "private.txt");
	await mkdir(grantedRoot);
	await writeFile(denied, "private", "utf8");
	await symlink(denied, join(grantedRoot, "escape-link"));
	const options = { allowedRoots: [await realpath(grantedRoot)] };

	const granted = await resolveWritableWorkspaceFile(
		fixture.root,
		join(grantedRoot, "report.txt"),
		options,
	);
	assert.equal(granted.target, join(await realpath(grantedRoot), "report.txt"));
	await assert.rejects(
		() => resolveWritableWorkspaceFile(fixture.root, denied, options),
		hasKind("workspace_escape"),
	);
	await assert.rejects(
		() => resolveWritableWorkspaceFile(fixture.root, join(grantedRoot, "escape-link"), options),
		hasKind("workspace_escape"),
	);
});

test("rejects directories workspace root and blank mutation paths", async (t) => {
	const fixture = await workspaceFixture(t);
	const resolveWritableWorkspaceFile = requiredWritableResolver();

	await assert.rejects(
		() => resolveWritableWorkspaceFile(fixture.root, "src"),
		hasKind("is_directory"),
	);
	await assert.rejects(
		() => resolveWritableWorkspaceFile(fixture.root, "."),
		hasKind("is_directory"),
	);
	await assert.rejects(
		() => resolveWritableWorkspaceFile(fixture.root, " "),
		hasKind("invalid_path"),
	);
});

test("explicit empty writable roots deny existing and new workspace files", async (t) => {
	const fixture = await workspaceFixture(t);
	const resolveWritableWorkspaceFile = requiredWritableResolver();
	for (const path of [fixture.file, "src/a.ts", "generated/deep/new.ts"]) {
		await assert.rejects(() => resolveWritableWorkspaceFile(fixture.root, path, { allowedRoots: [] }), hasKind("workspace_escape"));
	}
	assert.equal(await requiredResolver()(fixture.root, "src/a.ts", { allowedRoots: [] }), await realpath(fixture.file));
});

test("explicit write grants exclude the rest of the workspace", async (t) => {
	const fixture = await workspaceFixture(t);
	const resolveWritableWorkspaceFile = requiredWritableResolver();
	const grantedRoot = await realpath(join(fixture.root, "src"));
	const options = { allowedRoots: [grantedRoot] };
	assert.equal((await resolveWritableWorkspaceFile(fixture.root, "src/a.ts", options)).target, await realpath(fixture.file));
	assert.equal((await resolveWritableWorkspaceFile(fixture.root, "src/new/deep.ts", options)).target, join(grantedRoot, "new/deep.ts"));
	for (const path of ["new.ts", "src-other/new.ts", "src/../new.ts"]) {
		await assert.rejects(() => resolveWritableWorkspaceFile(fixture.root, path, options), hasKind("workspace_escape"));
	}
	const onlyFile = { allowedRoots: [await realpath(fixture.file)] };
	assert.equal((await resolveWritableWorkspaceFile(fixture.root, "src/a.ts", onlyFile)).target, await realpath(fixture.file));
	await assert.rejects(() => resolveWritableWorkspaceFile(fixture.root, "src/new.ts", onlyFile), hasKind("workspace_escape"));
});

interface ResolutionOptions {
	readonly allowOutsideWorkspace?: boolean;
	readonly allowedRoots?: readonly string[];
}

type Resolver = (
	workspaceRoot: string,
	rawPath: string,
	options?: ResolutionOptions,
) => Promise<string>;

interface WritableWorkspaceFile {
	readonly workspaceRoot: string;
	readonly target: string;
	readonly relativePath: string;
	readonly existed: boolean;
}

type WritableResolver = (
	workspaceRoot: string,
	rawPath: string,
	options?: ResolutionOptions,
) => Promise<WritableWorkspaceFile>;

function requiredResolver(): Resolver {
	const value = Reflect.get(tools, "resolveReadableWorkspaceFile");
	assert.equal(typeof value, "function", "resolveReadableWorkspaceFile must be exported");
	return value as Resolver;
}

function requiredWritableResolver(): WritableResolver {
	const value = Reflect.get(tools, "resolveWritableWorkspaceFile");
	assert.equal(typeof value, "function", "resolveWritableWorkspaceFile must be exported");
	return value as WritableResolver;
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
