# Node Runtime M4 File Mutation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Node-native `Write`, `Edit`, and `Patch` turns with Python-compatible workspace safety, read-snapshot conflict detection, bounded diffs, durable metadata, and no Python fallback.

**Architecture:** Extend `packages/tools` with a shared snapshot store, mutation path policy, safety/diff helpers, and one mutation runtime used by three thin adapters. Keep provider orchestration generic; extend the existing tool-result persistence input so bounded mutation metadata reaches SQLite and the gateway without teaching `packages/runtime` how files are modified.

**Tech Stack:** Node.js 22.19+, strict TypeScript/ESM, Node standard filesystem APIs, `diff@^9.0.0`, Ajv Draft 2020-12 schemas, `better-sqlite3`, Node test runner, pytest parity tests.

---

## File Map

- Create `packages/tools/src/file-snapshot-store.ts`: process-local complete-file snapshots shared by `Read`, `Edit`, and `Patch`.
- Modify `packages/tools/src/read-tool.ts`: record each successful complete-file snapshot in the shared store.
- Modify `packages/tools/src/path-policy.ts`: resolve existing and new mutation targets under the real workspace root.
- Create `packages/tools/src/file-diff.ts`: unified diff generation, line counts, and 200,000-character/5,000-line bounding.
- Create `packages/tools/src/file-mutation-runtime.ts`: content safety, exact replacement, conflict checks, temporary sibling commits, and stable errors.
- Create `packages/tools/src/mutation-result.ts`: bounded model receipts and safe metadata projection.
- Create `packages/tools/src/write-tool.ts`: full-file `Write` adapter.
- Create `packages/tools/src/edit-tool.ts`: exact replacement `Edit` adapter.
- Create `packages/tools/src/patch-tool.ts`: first-class `Patch` adapter using the shared replacement kernel.
- Modify `packages/tools/src/manifest.ts`: expose `Read`, `Edit`, `Patch`, `Write` in stable order.
- Modify `packages/tools/src/index.ts`: export the new public tool boundaries.
- Modify `packages/providers/test/responses-provider.test.ts`: verify all optional mutation schemas project without strict mode.
- Modify `packages/providers/test/chat-provider.test.ts`: verify mutation declarations, calls, results, and continuation.
- Modify `packages/tools/package.json` and `package-lock.json`: add `diff@^9.0.0`.
- Modify `packages/storage/src/session-store.ts`: accept bounded tool-result metadata.
- Modify `packages/storage/src/sqlite-session-store.ts`: persist safe mutation metadata in existing JSON payloads.
- Modify `packages/runtime/src/node-turn-runtime.ts`: pass router metadata to storage unchanged.
- Modify `apps/mycli/src/node-runtime/node-backend.ts`: construct one shared snapshot store/runtime and register four adapters.
- Modify `apps/mycli/src/node-runtime/node-gateway.ts`: project bounded mutation metadata through existing tool events.
- Create `tests/fixtures/node_runtime_m4/mutation_contract.json`: stable parity cases and transcript fields.
- Create `tests/integration/node_runtime_m4_parity_helper.ts`: Node half of mutation parity probes.
- Create `tests/integration/test_node_runtime_m4_parity.py`: Python/Node tool and transcript parity.
- Create `apps/mycli/test/m4-file-mutation.integration.test.ts`: complete Node-only provider/tool turn.
- Create `scripts/smoke_node_m4_mutation.mjs`: sanitized live Responses smoke.
- Modify `package.json`, `apps/mycli/package.json`, `tests/unit/cli/node_tui/test_package_scripts.py`, and `docs/node-runtime-rollout.md`: M4 commands, packaging, and rollout documentation.

### Task 1: Shared Read Snapshot Store

**Files:**
- Create: `packages/tools/src/file-snapshot-store.ts`
- Modify: `packages/tools/src/read-tool.ts`
- Modify: `packages/tools/src/index.ts`
- Test: `packages/tools/test/file-snapshot-store.test.ts`
- Test: `packages/tools/test/read-tool.test.ts`

- [ ] **Step 1: Write failing snapshot-store and Read integration tests**

Add tests that exercise replacement by normalized path and prove duplicate `Read` calls refresh the mutation snapshot:

```ts
test("stores the latest complete-file snapshot by workspace path", () => {
	const store = requiredSnapshotStore();
	store.record({ path: "src/a.ts", sha256: "a".repeat(64), mtimeNs: "1", size: 1, capturedAt: "t1" });
	store.record({ path: "src/a.ts", sha256: "b".repeat(64), mtimeNs: "2", size: 2, capturedAt: "t2" });
	assert.equal(store.latest("src/a.ts")?.sha256, "b".repeat(64));
	assert.equal(store.latest("./src/a.ts")?.sha256, "b".repeat(64));
});

test("Read records and refreshes the shared mutation snapshot", async (t) => {
	const fixture = await workspaceFixture(t);
	const snapshots = new FileSnapshotStore();
	const read = new ReadTool({ workspaceRoot: fixture.root, snapshots });
	await read.execute({ file_path: "README.md", offset: 1, limit: 20 }, options());
	const first = snapshots.latest("README.md");
	await writeFile(join(fixture.root, "README.md"), "changed\n", "utf8");
	await read.execute({ file_path: "README.md", offset: 1, limit: 20 }, options());
	assert.notEqual(snapshots.latest("README.md")?.sha256, first?.sha256);
});
```

- [ ] **Step 2: Run the targeted tests and verify the missing export failure**

Run: `node --import tsx --test packages/tools/test/file-snapshot-store.test.ts packages/tools/test/read-tool.test.ts`

Expected: FAIL because `FileSnapshotStore` and the `snapshots` option do not exist.

- [ ] **Step 3: Implement the store and connect it to successful reads**

Create the immutable snapshot contract and normalized map:

```ts
export interface FileSnapshot {
	readonly path: string;
	readonly sha256: string;
	readonly mtimeNs: string;
	readonly size: number;
	readonly capturedAt: string;
}

export class FileSnapshotStore {
	readonly #snapshots = new Map<string, FileSnapshot>();

	record(snapshot: FileSnapshot): void {
		this.#snapshots.set(normalizeSnapshotPath(snapshot.path), Object.freeze({ ...snapshot }));
	}

	latest(path: string): FileSnapshot | undefined {
		return this.#snapshots.get(normalizeSnapshotPath(path));
	}
}
```

Extend `ReadToolOptions` with `readonly snapshots?: FileSnapshotStore`, default it in the constructor, and call `record()` immediately after `readTextWindow` or `readDelimitedFile` returns a validated payload. Keep range dedup in its existing private map and record before the duplicate-result branch.

- [ ] **Step 4: Run tools tests and typecheck**

Run: `npm run test --workspace @mycli/tools && npm run typecheck --workspace @mycli/tools`

Expected: all `@mycli/tools` tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit the snapshot boundary**

```bash
git add packages/tools/src/file-snapshot-store.ts packages/tools/src/read-tool.ts packages/tools/src/index.ts packages/tools/test/file-snapshot-store.test.ts packages/tools/test/read-tool.test.ts
git commit -m "feat(node-tools): share Read mutation snapshots"
```

### Task 2: Mutation Path Policy

**Files:**
- Modify: `packages/tools/src/path-policy.ts`
- Modify: `packages/tools/src/index.ts`
- Test: `packages/tools/test/path-policy.test.ts`

- [ ] **Step 1: Write failing tests for existing, new, and escaped mutation targets**

Cover a normal existing file, nested missing parents, an internal symlink, parent traversal, an
absolute outside path, an outside symlink, a directory, and the workspace root:

```ts
test("resolves existing and new mutation targets under the real workspace", async (t) => {
	const fixture = await workspaceFixture(t);
	const existing = await resolveWritableWorkspaceFile(fixture.root, "src/a.ts");
	const created = await resolveWritableWorkspaceFile(fixture.root, "generated/deep/a.ts");
	assert.equal(existing.relativePath, "src/a.ts");
	assert.equal(existing.existed, true);
	assert.equal(created.relativePath, "generated/deep/a.ts");
	assert.equal(created.existed, false);
});

test("rejects traversal and symbolic-link mutation escape", async (t) => {
	const fixture = await workspaceFixture(t);
	await symlink(join(fixture.parent, "outside.txt"), join(fixture.root, "outside-link"));
	for (const path of ["../outside.txt", join(fixture.parent, "outside.txt"), "outside-link"]) {
		await assert.rejects(() => resolveWritableWorkspaceFile(fixture.root, path), hasKind("workspace_escape"));
	}
});
```

- [ ] **Step 2: Run the path-policy test and verify it fails**

Run: `node --import tsx --test packages/tools/test/path-policy.test.ts`

Expected: FAIL because `resolveWritableWorkspaceFile` is not exported.

- [ ] **Step 3: Implement writable target resolution**

Add this public result and resolver:

```ts
export interface WritableWorkspaceFile {
	readonly workspaceRoot: string;
	readonly target: string;
	readonly relativePath: string;
	readonly existed: boolean;
}

export async function resolveWritableWorkspaceFile(
	workspaceRoot: string,
	rawPath: string,
): Promise<WritableWorkspaceFile> {
	const unresolvedRoot = resolve(workspaceRoot);
	const realRoot = await realpath(unresolvedRoot);
	const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(unresolvedRoot, rawPath);
	if (!rawPath.trim() || candidate === unresolvedRoot || isOutside(unresolvedRoot, candidate)) {
		throw new WorkspacePathError(rawPath.trim() ? "workspace_escape" : "invalid_path");
	}
	const located = await locateExistingAncestor(candidate);
	const realAncestor = await realpath(located.ancestor);
	const target = resolve(realAncestor, ...located.missingSegments);
	if (isOutside(realRoot, target)) throw new WorkspacePathError("workspace_escape");
	if (located.existed && !(await stat(target)).isFile()) throw new WorkspacePathError("is_directory");
	return { workspaceRoot: realRoot, target, relativePath: posixRelative(realRoot, target), existed: located.existed };
}
```

`locateExistingAncestor()` must walk upward only on `ENOENT`, retain missing segments in original
order, and classify permission errors. Export a `revalidateWritableWorkspaceFile()` helper that
reruns the same checks immediately before commit.

- [ ] **Step 4: Run path tests and package typecheck**

Run: `node --import tsx --test packages/tools/test/path-policy.test.ts && npm run typecheck --workspace @mycli/tools`

Expected: PASS.

- [ ] **Step 5: Commit the mutation path policy**

```bash
git add packages/tools/src/path-policy.ts packages/tools/src/index.ts packages/tools/test/path-policy.test.ts
git commit -m "feat(node-tools): confine mutation targets"
```

### Task 3: Diff, Safety, And Atomic Mutation Kernel

**Files:**
- Create: `packages/tools/src/file-diff.ts`
- Create: `packages/tools/src/file-mutation-runtime.ts`
- Modify: `packages/tools/src/index.ts`
- Modify: `packages/tools/package.json`
- Modify: `package-lock.json`
- Test: `packages/tools/test/file-diff.test.ts`
- Test: `packages/tools/test/file-mutation-runtime.test.ts`

- [ ] **Step 1: Write failing tests for diff bounds and validation-before-commit**

```ts
test("bounds unified diffs while retaining counts", () => {
	const result = createBoundedUnifiedDiff("a.txt", "old\n", `${"new\n".repeat(6_000)}`);
	assert.ok(result.diff.length <= 200_000);
	assert.ok(result.diff.split("\n").length <= 5_000);
	assert.equal(result.addedLines, 6_000);
	assert.equal(result.removedLines, 1);
	assert.equal(result.truncated, true);
});

test("rejects secret-like content without changing the target", async (t) => {
	const fixture = await mutationFixture(t, "old\n");
	const runtime = new FileMutationRuntime({ workspaceRoot: fixture.root, snapshots: new FileSnapshotStore() });
	await assert.rejects(
		() => runtime.write({ path: "a.txt", content: "API_KEY = 'sk-1234567890abcdef'", signal: signal() }),
		hasMutationKind("secret_like_content"),
	);
	assert.equal(await readFile(fixture.target, "utf8"), "old\n");
});
```

Also test NUL binary detection, suspicious control ratio, invalid UTF-8, 1,000,001-byte content,
1,000,001-byte edit targets, no-op writes, temp cleanup, permission-mode preservation, abort before
commit, and stale baseline detection.

- [ ] **Step 2: Run the new tests and verify missing modules**

Run: `node --import tsx --test packages/tools/test/file-diff.test.ts packages/tools/test/file-mutation-runtime.test.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 3: Install the proven unified-diff dependency**

Run: `npm_config_cache=/tmp/mycli-npm-cache npm install diff@^9.0.0 --workspace @mycli/tools`

Expected: `packages/tools/package.json` contains `"diff": "^9.0.0"`; `package-lock.json` changes and no other dependency is added.

- [ ] **Step 4: Implement bounded diff generation**

Use `createTwoFilesPatch()` from `diff`, normalize CRLF, count `+`/`-` lines excluding headers,
then retain head and tail lines until both limits are satisfied:

```ts
export interface BoundedFileDiff {
	readonly diff: string;
	readonly addedLines: number;
	readonly removedLines: number;
	readonly truncated: boolean;
	readonly omittedChars: number;
}

export function createBoundedUnifiedDiff(path: string, before: string, after: string): BoundedFileDiff {
	const full = createTwoFilesPatch(`${path}:before`, `${path}:after`, normalize(before), normalize(after), "", "", { context: 3 });
	const { addedLines, removedLines } = countChanges(full);
	const bounded = boundHeadAndTail(full, 200_000, 5_000);
	return { diff: bounded.value, addedLines, removedLines, truncated: bounded.omittedChars > 0, omittedChars: bounded.omittedChars };
}
```

- [ ] **Step 5: Implement the mutation runtime**

Define stable result/error types and two public operations:

```ts
export class FileMutationError extends Error {
	constructor(readonly kind: MutationErrorKind) {
		super(`file_mutation_error: ${kind}`);
		this.name = "FileMutationError";
	}
}

export interface MutationOutcome extends BoundedFileDiff {
	readonly path: string;
	readonly status: "created" | "overwritten" | "unchanged" | "edited";
	readonly matches?: number;
}

export class FileMutationRuntime {
	async write(input: { path: string; content: string; expectedSha256?: string; signal: AbortSignal }): Promise<MutationOutcome>;
	async replace(input: { path: string; oldString: string; newString: string; replaceAll: boolean; signal: AbortSignal }): Promise<MutationOutcome>;
}
```

Implement these ordered phases in both operations: resolve target, abort check, load existing bytes,
binary/UTF-8/size validation, content/secret validation, snapshot or expected-hash comparison,
compute new content, return unchanged/no-op as specified, create parents for `write` only, create an
exclusive temporary sibling, write and sync it, copy existing permission mode, revalidate path and
baseline, abort check, rename, remove temp in `finally`, and return the bounded diff. Do not refresh
the shared `Read` snapshot after mutation.

- [ ] **Step 6: Run kernel tests and typecheck**

Run: `node --import tsx --test packages/tools/test/file-diff.test.ts packages/tools/test/file-mutation-runtime.test.ts && npm run typecheck --workspace @mycli/tools`

Expected: PASS with no leaked temporary files.

- [ ] **Step 7: Commit the shared mutation kernel**

```bash
git add packages/tools/src/file-diff.ts packages/tools/src/file-mutation-runtime.ts packages/tools/src/index.ts packages/tools/package.json package-lock.json packages/tools/test/file-diff.test.ts packages/tools/test/file-mutation-runtime.test.ts
git commit -m "feat(node-tools): add safe mutation kernel"
```

### Task 4: Write Adapter And Mutation Results

**Files:**
- Create: `packages/tools/src/mutation-result.ts`
- Create: `packages/tools/src/write-tool.ts`
- Modify: `packages/tools/src/index.ts`
- Test: `packages/tools/test/write-tool.test.ts`

- [ ] **Step 1: Write failing `Write` adapter tests**

Cover create, nested parent creation, overwrite, unchanged, matching/stale/missing
`expected_sha256`, binary target, directory, secret, invalid UTF-8, size limit, escape, and abort:

```ts
test("creates a file and returns a compact receipt with bounded metadata", async (t) => {
	const fixture = await workspaceFixture(t);
	const write = createWriteTool(fixture.root);
	const result = await write.execute({ file_path: "src/new.ts", content: "export {};\n" }, options());
	assert.equal(result.success, true);
	assert.equal(result.modelOutput, "Success. Updated the following files:\nA src/new.ts");
	assert.equal(result.metadata.path, "src/new.ts");
	assert.equal(result.metadata.status, "created");
	assert.ok(typeof result.metadata.diff === "string");
});

test("returns stale_write_snapshot without overwriting", async (t) => {
	const fixture = await workspaceFixture(t, "current\n");
	const result = await createWriteTool(fixture.root).execute({
		file_path: "a.txt", content: "new\n", expected_sha256: "0".repeat(64),
	}, options());
	assert.equal(result.success, false);
	assert.equal(result.errorKind, "stale_write_snapshot");
	assert.equal(await readFile(fixture.target, "utf8"), "current\n");
});
```

- [ ] **Step 2: Run the adapter test and verify the missing export**

Run: `node --import tsx --test packages/tools/test/write-tool.test.ts`

Expected: FAIL because `WriteTool` is not exported.

- [ ] **Step 3: Implement bounded mutation result projection**

Add `mutationSuccess(toolName, outcome)` and `mutationFailure(toolName, displayPath, error)`.
Success metadata contains only `path`, `status`, optional `matches`, bounded `diff`, `addedLines`,
`removedLines`, `diffTruncated`, and optional `omittedChars`. Failure model output names the stable
error kind and a corrective public message; it never includes submitted content, hashes, or an
absolute resolved path. Cap every model output at 8,000 characters.

- [ ] **Step 4: Implement `WriteTool`**

```ts
export interface WriteToolOptions {
	readonly runtime: FileMutationRuntime;
}

export class WriteTool implements ToolAdapter {
	readonly definition = WRITE_TOOL_DEFINITION;
	constructor(private readonly options: WriteToolOptions) {}
	async execute(argumentsValue: Readonly<Record<string, unknown>>, options: ToolExecutionOptions): Promise<ToolAdapterResult> {
		const path = stringArgument(argumentsValue.file_path);
		const content = stringArgument(argumentsValue.content);
		try {
			const outcome = await this.options.runtime.write({ path, content, expectedSha256: optionalString(argumentsValue.expected_sha256), signal: options.signal });
			return mutationSuccess("Write", outcome);
		} catch (error) {
			if (isAbort(error)) throw error;
			return mutationFailure("Write", displayMutationPath(path), error);
		}
	}
}
```

- [ ] **Step 5: Run Write tests and the tools suite**

Run: `node --import tsx --test packages/tools/test/write-tool.test.ts && npm run test --workspace @mycli/tools`

Expected: PASS.

- [ ] **Step 6: Commit Write**

```bash
git add packages/tools/src/mutation-result.ts packages/tools/src/write-tool.ts packages/tools/src/index.ts packages/tools/test/write-tool.test.ts
git commit -m "feat(node-tools): implement workspace-safe Write"
```

### Task 5: Edit, Patch, And Stable Manifest

**Files:**
- Create: `packages/tools/src/edit-tool.ts`
- Create: `packages/tools/src/patch-tool.ts`
- Modify: `packages/tools/src/manifest.ts`
- Modify: `packages/tools/src/index.ts`
- Modify: `packages/tools/test/manifest.test.ts`
- Modify: `packages/tools/test/router.test.ts`
- Modify: `packages/providers/test/responses-provider.test.ts`
- Modify: `packages/providers/test/chat-provider.test.ts`
- Test: `packages/tools/test/edit-patch-tool.test.ts`

- [ ] **Step 1: Write failing exact-replacement tests**

Cover missing/stale `Read`, one match, multiple matches, `replace_all`, missing string, identical
strings, existing empty file with empty `old_string`, missing file with empty `old_string`, Markdown
whitespace preservation, non-Markdown trailing horizontal whitespace normalization, and distinct
`edited`/`patched` statuses:

```ts
test("Edit requires a current shared Read snapshot", async (t) => {
	const fixture = await workspaceFixture(t, "value = 1\n");
	const tools = createMutationTools(fixture.root);
	const missing = await tools.edit.execute({ file_path: "a.ts", old_string: "1", new_string: "2" }, options());
	assert.equal(missing.errorKind, "missing_read_snapshot");
	await tools.read.execute({ file_path: "a.ts", offset: 1, limit: 20 }, options());
	await writeFile(fixture.target, "value = 3\n", "utf8");
	const stale = await tools.edit.execute({ file_path: "a.ts", old_string: "3", new_string: "4" }, options());
	assert.equal(stale.errorKind, "stale_read_snapshot");
});

test("Patch remains a distinct first-class tool", async (t) => {
	const fixture = await workspaceFixture(t, "value = 1\n");
	const tools = createMutationTools(fixture.root);
	await tools.read.execute({ file_path: "a.ts", offset: 1, limit: 20 }, options());
	const result = await tools.patch.execute({ file_path: "a.ts", old_string: "1", new_string: "2" }, options());
	assert.equal(result.success, true);
	assert.equal(result.metadata.status, "patched");
	assert.equal(result.modelOutput, "Success. Updated the following files:\nM a.ts");
});
```

- [ ] **Step 2: Update manifest tests before implementation**

Assert exact order `Read`, `Edit`, `Patch`, `Write`; medium risk; filesystem write effects;
`supports_parallel_tool_calls=false`; `approval_policy=auto_allow_or_request`; required/optional
schema properties; stable ids; and continued absence of `LS`, `Glob`, and `Grep`.

- [ ] **Step 3: Run targeted tests and verify failures**

Run: `node --import tsx --test packages/tools/test/edit-patch-tool.test.ts packages/tools/test/manifest.test.ts packages/tools/test/router.test.ts`

Expected: FAIL because Edit/Patch definitions and the four-tool manifest are missing.

- [ ] **Step 4: Implement exact replacement adapters**

Create one internal `ExactReplaceTool` that receives `toolName` and success status, calls
`FileMutationRuntime.replace()`, and maps results through `mutation-result.ts`. Export thin concrete
classes:

```ts
export class EditTool extends ExactReplaceTool {
	constructor(runtime: FileMutationRuntime) { super("Edit", "edited", EDIT_TOOL_DEFINITION, runtime); }
}

export class PatchTool extends ExactReplaceTool {
	constructor(runtime: FileMutationRuntime) { super("Patch", "patched", PATCH_TOOL_DEFINITION, runtime); }
}
```

After a successful replacement, override the kernel's internal `edited` status with the adapter's
stable status before result projection. Propagate aborts and convert every `FileMutationError` to a
failed tool result.

- [ ] **Step 5: Expand the manifest and router coverage**

Define schemas from frozen parameter rows and build the manifest in this exact order:

```ts
const BUILTIN_MANIFEST = deepFreeze({
	schema_version: 1,
	source: "builtin",
	toolsets: [{ id: "file", tool_count: 4 }],
	tools: [READ_MANIFEST_ENTRY, EDIT_MANIFEST_ENTRY, PATCH_MANIFEST_ENTRY, WRITE_MANIFEST_ENTRY],
});
```

Use `additionalProperties:false`, require all non-optional fields, leave `replace_all` and
`expected_sha256` optional, and do not add `strict:true` in provider projections.

- [ ] **Step 6: Run the full tools package gate**

Add provider assertions that the Responses body contains ordinary function entries named
`Read`, `Edit`, `Patch`, and `Write` with no `strict` property, while Chat contains the same names
under `function`. Decode an `Edit` call and project its compact result through a second request in
both protocols.

Run: `npm run test --workspace @mycli/tools && npm run test --workspace @mycli/providers && npm run typecheck --workspace @mycli/tools && npm run build --workspace @mycli/tools`

Expected: PASS.

- [ ] **Step 7: Commit Edit, Patch, and manifest exposure**

```bash
git add packages/tools/src/edit-tool.ts packages/tools/src/patch-tool.ts packages/tools/src/manifest.ts packages/tools/src/index.ts packages/tools/test/edit-patch-tool.test.ts packages/tools/test/manifest.test.ts packages/tools/test/router.test.ts packages/providers/test/responses-provider.test.ts packages/providers/test/chat-provider.test.ts
git commit -m "feat(node-tools): expose Edit Patch and Write"
```

### Task 6: Durable Mutation Metadata And Gateway Projection

**Files:**
- Modify: `packages/storage/src/session-store.ts`
- Modify: `packages/storage/src/sqlite-session-store.ts`
- Modify: `packages/storage/test/sqlite-session-store.test.ts`
- Modify: `packages/runtime/src/node-turn-runtime.ts`
- Modify: `packages/runtime/test/node-turn-runtime.test.ts`
- Modify: `apps/mycli/src/node-runtime/node-gateway.ts`
- Modify: `apps/mycli/test/node-gateway.test.ts`

- [ ] **Step 1: Write failing storage tests for safe metadata round trips**

```ts
store.appendToolResult({
	sessionId, clientTurnId,
	result: { callId: "call-write", toolName: "Write", output: "Success. Updated...", success: true },
	summary: "Wrote a.ts",
	metadata: { path: "a.ts", status: "overwritten", diff: "--- a\n+++ b", addedLines: 1, removedLines: 1, diffTruncated: false },
});
const payload = readToolPayload(database, sessionId, "call-write");
assert.deepEqual(payload.metadata.file_changes[0].path, "a.ts");
assert.equal(JSON.stringify(payload).includes("submitted secret"), false);
```

Also test rejection of arrays, nested objects outside the file-change shape, paths over 240
characters, diffs over 200,000 characters, and more than one change for the single-file M4 tools.

- [ ] **Step 2: Write failing runtime and gateway projection tests**

Assert `NodeTurnRuntime` passes `result.metadata` to `appendToolResult`; `tool.complete` includes the
normalized file change; `tool.failed` includes path/error kind; and neither event includes content,
hashes, or raw arguments.

- [ ] **Step 3: Run targeted tests and verify missing metadata flow**

Run: `node --import tsx --test packages/storage/test/sqlite-session-store.test.ts packages/runtime/test/node-turn-runtime.test.ts apps/mycli/test/node-gateway.test.ts`

Expected: FAIL because `AppendToolResultInput` has no metadata and the gateway drops file-change fields.

- [ ] **Step 4: Extend storage with a bounded metadata contract**

Add `readonly metadata?: Readonly<Record<string, unknown>>` to `AppendToolResultInput`. In
`SQLiteSessionStore`, parse only the allowlisted mutation fields into this Python-compatible shape:

```ts
{
	file_changes: [{
		version: 1,
		kind: status === "created" ? "add" : "update",
		path,
		diff,
		added_lines: addedLines,
		removed_lines: removedLines,
		...(diffTruncated ? { truncated: true, omitted_chars: omittedChars } : {}),
	}],
}
```

Merge it into conversation block metadata and history metadata. Keep canonical provider
conversation loading unchanged so the compact receipt, not the diff, is replayed to providers.

- [ ] **Step 5: Pass metadata through runtime and gateway**

Change the runtime call to:

```ts
this.#options.store.appendToolResult({
	sessionId: this.#options.sessionId,
	clientTurnId: submission.clientTurnId,
	result: toCanonicalResult(result),
	summary: result.summary,
	metadata: result.metadata,
	...(result.errorKind ? { errorKind: result.errorKind } : {}),
});
```

In the gateway, copy only bounded `path`, `status`, `matches`, `file_changes`, and `errorKind` into
existing `tool.complete`/`tool.failed` payloads. Do not create approval events or new gateway methods.

- [ ] **Step 6: Run storage/runtime/gateway tests and typecheck**

Run: `node --import tsx --test packages/storage/test/sqlite-session-store.test.ts packages/runtime/test/node-turn-runtime.test.ts apps/mycli/test/node-gateway.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit durable mutation projection**

```bash
git add packages/storage/src/session-store.ts packages/storage/src/sqlite-session-store.ts packages/storage/test/sqlite-session-store.test.ts packages/runtime/src/node-turn-runtime.ts packages/runtime/test/node-turn-runtime.test.ts apps/mycli/src/node-runtime/node-gateway.ts apps/mycli/test/node-gateway.test.ts
git commit -m "feat(node-runtime): persist mutation file changes"
```

### Task 7: Node Backend Composition And End-To-End Turn

**Files:**
- Modify: `apps/mycli/src/node-runtime/node-backend.ts`
- Create: `apps/mycli/test/m4-file-mutation.integration.test.ts`
- Modify: `apps/mycli/test/package.test.ts`

- [ ] **Step 1: Write failing Responses and Chat integration tests**

Build a fake SSE provider sequence with `Read`, then `Edit`, then a final answer. Assert:

```ts
assert.deepEqual(toolNames(requestBodies[0]?.tools), ["Read", "Edit", "Patch", "Write"]);
assert.equal(await readFile(join(workspace, "README.md"), "utf8"), "alpha\ngamma\n");
assert.equal(existsSync(pythonMarker), false);
assert.equal(events(messages, "tool.start").length, 2);
assert.equal(events(messages, "tool.complete").length, 2);
assert.equal(events(messages, "tool.failed").length, 0);
assert.deepEqual(store.loadConversationItems(sessionId).map((item) => item.type), [
	"user", "assistant_tool_calls", "tool_result", "assistant_tool_calls", "tool_result", "assistant",
]);
```

Add a second scenario where `Edit` is requested before `Read`, returns
`missing_read_snapshot`, and the provider recovers by calling `Read` then `Edit` in the same turn.
Add a Chat Completions scenario whose assistant tool-call message invokes `Write`, whose next
request contains the matching ordered `tool_call_id`, and whose final assistant message completes
the turn with the expected file on disk and `python_started=false`.

- [ ] **Step 2: Run the integration test and verify only Read is registered**

Run: `node --import tsx --test apps/mycli/test/m4-file-mutation.integration.test.ts`

Expected: FAIL for both protocols because the backend advertises and registers only `Read`.

- [ ] **Step 3: Compose the shared mutation tools**

Construct one store and runtime in `startNodeBackend()`:

```ts
const snapshots = new FileSnapshotStore();
const mutationRuntime = new FileMutationRuntime({ workspaceRoot: config.workspaceRoot, snapshots });
const adapters = [
	new ReadTool({ workspaceRoot: config.workspaceRoot, snapshots }),
	new EditTool(mutationRuntime),
	new PatchTool(mutationRuntime),
	new WriteTool({ runtime: mutationRuntime }),
];
const toolExposure = planToolExposure(builtinToolManifest());
const toolRouter = new ToolRouter({ adapters, exposure: toolExposure });
```

Do not add a Python fallback, approval handler, external root, or runtime tool-name branch.

- [ ] **Step 4: Run M4 integration and all app tests**

Run: `node --import tsx --test apps/mycli/test/m4-file-mutation.integration.test.ts && npm run test --workspace @cosmos2023/mycli`

Expected: PASS.

- [ ] **Step 5: Commit backend composition**

```bash
git add apps/mycli/src/node-runtime/node-backend.ts apps/mycli/test/m4-file-mutation.integration.test.ts apps/mycli/test/package.test.ts
git commit -m "feat(node-runtime): complete M4 mutation turns"
```

### Task 8: Python/Node Parity, Smoke, Rollout, And Full Gate

**Files:**
- Create: `tests/fixtures/node_runtime_m4/mutation_contract.json`
- Create: `tests/integration/node_runtime_m4_parity_helper.ts`
- Create: `tests/integration/test_node_runtime_m4_parity.py`
- Create: `scripts/smoke_node_m4_mutation.mjs`
- Modify: `package.json`
- Modify: `apps/mycli/package.json`
- Modify: `tests/unit/cli/node_tui/test_package_scripts.py`
- Modify: `docs/node-runtime-rollout.md`
- Modify: `.trellis/spec/backend/file-mutation-tool-contract.md`

- [ ] **Step 1: Write the shared M4 parity fixture**

Record only deterministic inputs and structural expectations: inventory/order, parameter names,
success statuses, stable error kinds, match counts, compact receipts, bounded file-change metadata,
canonical transcript item types, and Python-compatible raw message shape. Do not include credentials,
absolute temporary paths, timestamps, or nondeterministic temp filenames.

- [ ] **Step 2: Write failing Python/Node parity tests**

The Node helper must run fixture cases through one shared router/runtime and write/read a SQLite
mutation transcript. The pytest test must run the same cases through Python `ReadTool`, `WriteTool`,
`EditTool`, and `PatchTool`, then compare normalized results and verify each backend reads the
other backend's call IDs, tool names, receipt, success/error kind, and `file_changes` metadata.

Run: `uv run pytest tests/integration/test_node_runtime_m4_parity.py -q`

Expected: FAIL until the fixture/helper and storage metadata are complete.

- [ ] **Step 3: Implement the parity helper and normalize intentional representation differences**

Normalize only field naming differences such as `mtime_ns` versus `mtimeNs`. Do not normalize
behavioral differences in statuses, error kinds, matches, inventory, provider output, or file
contents. Assert all escape and validation failures preserve the target bytes.

- [ ] **Step 4: Add deterministic M4 scripts and package coverage**

Add root scripts:

```json
"test:m4": "npm run build && node --import tsx --test apps/mycli/test/m4-file-mutation.integration.test.ts && uv run pytest tests/integration/test_node_runtime_m4_parity.py -q",
"smoke:m4": "node scripts/smoke_node_m4_mutation.mjs --protocol responses"
```

Ensure the packed app includes the new integration-visible runtime modules and the package-script
pytest assertion checks `test:m4` and `smoke:m4`.

- [ ] **Step 5: Implement the sanitized live smoke**

Clone the M3 smoke's config precedence and redaction discipline. Use a unique temporary workspace
with one small public file, unique temporary SQLite DB, `gpt-5.5`, Responses, zero retries, a
64-token output cap, and a 45-second deadline. Require one successful mutation lifecycle and print
only:

```json
{"protocol":"responses","status":"completed","mutation_start":1,"mutation_complete":1,"persisted":true,"file_updated":true,"python_started":false}
```

Support `--dry-run`; exit `77` when authorized endpoint credentials are unavailable. Never print
the base URL, API key, prompt, arguments, original/final file content, diff, hash, or model text.

- [ ] **Step 6: Update rollout and executable mutation contracts**

Change the rollout title/status to M4; list `Read`, `Edit`, `Patch`, and `Write`; document
workspace-local auto-allow, conflict guards, stable failure behavior, explicit rollback to
`python-sidecar`, M4 commands, and deferred interactive approvals. Add Node M4 signatures,
workspace-boundary behavior, snapshot lifetime, metadata limits, and required parity cases to
`.trellis/spec/backend/file-mutation-tool-contract.md`.

- [ ] **Step 7: Run the complete offline quality gate**

Run:

```bash
npm run lint
npm run typecheck
npm run contracts:check
npm run build
npm test
npm run test:m3
npm run test:m4
npm run smoke:package
uv run pytest tests/integration/test_node_runtime_m3_parity.py tests/integration/test_node_runtime_m4_parity.py -q
```

Expected: every command exits 0; M3 remains green; Node test count does not decrease.

- [ ] **Step 8: Run the authorized real Responses smoke after offline gates pass**

Run the smoke with the user's configured non-official compatible endpoint and key supplied only via
process environment. Use `gpt-5.5`, zero retries, the disposable workspace, and sanitized output.

Expected sanitized output has `status=completed`, `mutation_start>=1`,
`mutation_complete>=1`, `persisted=true`, `file_updated=true`, and `python_started=false`.

- [ ] **Step 9: Commit parity, smoke, docs, and contracts**

```bash
git add tests/fixtures/node_runtime_m4 tests/integration/node_runtime_m4_parity_helper.ts tests/integration/test_node_runtime_m4_parity.py scripts/smoke_node_m4_mutation.mjs package.json apps/mycli/package.json tests/unit/cli/node_tui/test_package_scripts.py docs/node-runtime-rollout.md .trellis/spec/backend/file-mutation-tool-contract.md
git commit -m "feat(node-runtime): verify M4 mutation parity"
```

## Final Verification

- [ ] Confirm `git status --short` contains only pre-existing untracked Trellis bookkeeping.
- [ ] Confirm `git log --oneline -9` shows the design, plan, and coherent M4 implementation commits.
- [ ] Confirm no tracked file contains the authorized API key or endpoint string.
- [ ] Confirm Node remains an explicit preview and Python remains the default backend.
- [ ] Record exact test counts and the sanitized live-smoke result in the M4 completion summary.
