import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
	createWorkspaceWorktree,
	listWorkspaceWorktrees,
	removeWorkspaceWorktree,
	WorktreeError,
} from "../src/node-runtime/workspace-worktree.ts";
import { GatewayFailure } from "../src/node-runtime/node-gateway-errors.ts";
import { workspaceWorktreeCommands } from "../src/node-runtime/workspace-slash-workflows.ts";

const executeFile = promisify(execFile);

test("managed worktrees live under the mycli home and can be created, reused and listed", async (t) => {
	const { repo, home } = await fixture(t);
	const signal = new AbortController().signal;

	const created = await createWorkspaceWorktree({ workspaceRoot: repo, homeDir: home, name: "feature", signal });
	assert.equal(created.created, true);
	assert.equal(created.name, "feature");
	assert.equal(created.branch, "feature");
	assert.equal(basename(created.path), `${basename(repo)}-feature`);
	assert.equal(created.path, join(await realpath(home), "worktrees", `${basename(repo)}-feature`));
	assert.equal(existsSync(join(created.path, ".git")), true);

	const reused = await createWorkspaceWorktree({ workspaceRoot: repo, homeDir: home, name: "feature", signal });
	assert.equal(reused.created, false);
	assert.equal(reused.path, created.path);

	const listed = await listWorkspaceWorktrees({ workspaceRoot: repo, homeDir: home, signal });
	assert.deepEqual(listed.map((worktree) => worktree.name), ["feature"]);
	assert.equal(listed[0]?.branch, "feature");
	// Another repository sharing the same pool never leaks into this repository's view.
	const other = await repository(t, join(home, ".."), "other-repo");
	assert.deepEqual(
		await listWorkspaceWorktrees({ workspaceRoot: other, homeDir: home, signal }),
		[],
	);
});

test("managed worktrees default to a generated name and reject unsafe names", async (t) => {
	const { repo, home } = await fixture(t);
	const signal = new AbortController().signal;
	const created = await createWorkspaceWorktree({
		workspaceRoot: repo,
		homeDir: home,
		signal,
		clock: () => new Date("2026-10-12T08:09:10.000Z"),
	});
	assert.equal(created.name, "wt-20261012080910");

	await assert.rejects(
		createWorkspaceWorktree({ workspaceRoot: repo, homeDir: home, name: "bad name!", signal }),
		(error: unknown) => error instanceof WorktreeError && error.code === "worktree_invalid_name",
	);
});

test("a workspace outside Git and a plain directory both refuse to create a worktree", async (t) => {
	const { home } = await fixture(t);
	const plain = await mkdtemp(join(tmpdir(), "mycli-worktree-plain-"));
	t.after(() => rm(plain, { recursive: true, force: true }));
	await assert.rejects(
		createWorkspaceWorktree({
			workspaceRoot: plain,
			homeDir: home,
			name: "feature",
			signal: new AbortController().signal,
		}),
		(error: unknown) => error instanceof WorktreeError && error.code === "worktree_not_a_repository",
	);
});

test("removal refuses local changes, refuses the checkout in use, then removes the worktree", async (t) => {
	const { repo, home } = await fixture(t);
	const signal = new AbortController().signal;
	const created = await createWorkspaceWorktree({ workspaceRoot: repo, homeDir: home, name: "cleanup", signal });

	await writeFile(join(created.path, "scratch.txt"), "uncommitted\n");
	await assert.rejects(
		removeWorkspaceWorktree({ workspaceRoot: repo, homeDir: home, path: created.path, signal }),
		(error: unknown) => error instanceof WorktreeError && error.code === "worktree_local_changes",
	);

	await rm(join(created.path, "scratch.txt"));
	await assert.rejects(
		removeWorkspaceWorktree({ workspaceRoot: created.path, homeDir: home, path: created.path, signal }),
		(error: unknown) => error instanceof WorktreeError && error.code === "worktree_current",
	);
	await assert.rejects(
		removeWorkspaceWorktree({ workspaceRoot: repo, homeDir: home, path: repo, signal }),
		(error: unknown) => error instanceof WorktreeError && error.code === "worktree_not_managed",
	);

	await removeWorkspaceWorktree({ workspaceRoot: repo, homeDir: home, path: created.path, signal });
	assert.equal(existsSync(created.path), false);
	assert.deepEqual(await listWorkspaceWorktrees({ workspaceRoot: repo, homeDir: home, signal }), []);
});

test("the gateway worktree commands follow the session workspace and map refusals to invalid_params", async (t) => {
	const { repo, home } = await fixture(t);
	const commands = workspaceWorktreeCommands({ workspaceRoot: () => repo, homeDir: home });
	const signal = new AbortController().signal;

	const created = await commands.create({ name: "feature", signal });
	assert.equal(created.created, true);
	assert.deepEqual((await commands.list(signal)).map((worktree) => worktree.name), ["feature"]);

	await commands.remove(created.path, signal);
	assert.deepEqual(await commands.list(signal), []);

	await assert.rejects(
		commands.create({ name: "not a name", signal }),
		(error: unknown) => error instanceof GatewayFailure && error.code === "invalid_params",
	);
	await assert.rejects(
		commands.remove(repo, signal),
		(error: unknown) => error instanceof GatewayFailure && error.code === "invalid_params",
	);
});

async function fixture(t: test.TestContext): Promise<{ readonly repo: string; readonly home: string }> {
	const root = await mkdtemp(join(tmpdir(), "mycli-worktree-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const home = join(root, "home");
	return { repo: await repository(t, root, "repo"), home };
}

async function repository(t: test.TestContext, parent: string, name: string): Promise<string> {
	const repo = join(parent, name);
	await git(parent, ["init", "-q", repo]);
	await writeFile(join(repo, "readme.md"), "# fixture\n");
	await git(repo, ["add", "."]);
	await git(repo, ["commit", "-qm", "base"]);
	return repo;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
	return (await executeFile(
		"git",
		["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-C", cwd, ...args],
		{ encoding: "utf8" },
	)).stdout;
}
