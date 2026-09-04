# Node Runtime M3 Read Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete and persist a Node-native provider turn that invokes only the approved `Read` tool without starting Python.

**Architecture:** Add a provider-neutral tool model to `packages/core`, a new `packages/tools` workspace for manifest/routing/filesystem execution, continuation support to both provider adapters, durable tool transcript operations to `packages/storage`, and a bounded tool loop to `packages/runtime`. `apps/mycli` composes these pieces and projects existing TUI lifecycle events; Python remains the default backend and is never a fallback within an accepted Node turn.

**Tech Stack:** Node.js 22.19+, TypeScript 5.9 strict ESM, npm workspaces, Node test runner, Ajv Draft 2020-12 validation, `csv-parse`, OpenAI SDK, better-sqlite3, Python 3.13 parity fixtures, pytest, Ruff, mypy.

---

## File Map

Create:

- `packages/tools/package.json`: workspace package metadata and dependencies.
- `packages/tools/tsconfig.json`: source and test typechecking.
- `packages/tools/tsconfig.build.json`: compiled ESM output.
- `packages/tools/src/types.ts`: tool manifest, execution, and router interfaces.
- `packages/tools/src/manifest.ts`: pure built-in manifest containing only `Read`.
- `packages/tools/src/exposure-planner.ts`: deterministic provider exposure.
- `packages/tools/src/router.ts`: call parsing, schema validation, and dispatch.
- `packages/tools/src/path-policy.ts`: workspace-confined realpath resolution.
- `packages/tools/src/read-text.ts`: bounded streaming UTF-8 line reads.
- `packages/tools/src/read-delimited.ts`: bounded CSV/TSV parsing and summaries.
- `packages/tools/src/read-tool.ts`: concrete adapter and dedup snapshot state.
- `packages/tools/src/index.ts`: package exports.
- `packages/tools/test/manifest.test.ts`: manifest/exposure purity and shape.
- `packages/tools/test/router.test.ts`: validation, unknown, retired, and routing behavior.
- `packages/tools/test/path-policy.test.ts`: traversal and symlink escape cases.
- `packages/tools/test/read-text.test.ts`: text boundaries and snapshots.
- `packages/tools/test/read-delimited.test.ts`: structured CSV/TSV behavior.
- `packages/tools/test/read-tool.test.ts`: model output, failures, and dedup.
- `packages/runtime/src/node-turn-runtime.ts`: bounded provider/tool orchestration.
- `packages/runtime/test/node-turn-runtime.test.ts`: tool-loop behavior.
- `tests/fixtures/node_runtime_m3/tool_contract.json`: sanitized Python/Node parity corpus.
- `tests/integration/test_node_runtime_m3_parity.py`: cross-language contract and transcript checks.
- `apps/mycli/test/m3-read-turn.integration.test.ts`: complete Node-only Read turn.
- `scripts/smoke_node_m3_read.mjs`: bounded live API smoke harness.

Modify:

- `package.json`, `package-lock.json`: workspace build order, scripts, and `@mycli/tools` dependency.
- `packages/contracts/schemas/runtime-turn.schema.json`: M3 terminal error codes.
- `packages/contracts/schemas/gateway-events.schema.json`: matching gateway error enums.
- generated TypeScript/Python contract files via `npm run contracts:generate`.
- `packages/core/src/types.ts`: canonical tool definitions, calls, results, and conversation items.
- `packages/core/src/request-projection.ts`: tool-capable request projection.
- `packages/core/src/index.ts`: new public exports.
- `packages/core/test/request-projection.test.ts`: initial and continuation shapes.
- `packages/providers/src/responses-provider.ts`: tools and Responses continuation serialization.
- `packages/providers/src/chat-provider.ts`: tools and Chat transcript serialization.
- provider tests and sanitized fixtures.
- `packages/storage/src/session-store.ts`: append tool-call/result and recovery interfaces.
- `packages/storage/src/sqlite-session-store.ts`: canonical tool-call/result persistence and parsing.
- `packages/storage/test/sqlite-session-store.test.ts`: durable transcript behavior.
- `packages/storage/test/recovery.test.ts`: unmatched call repair.
- `packages/runtime/src/index.ts`: export `NodeTurnRuntime`.
- `packages/runtime/package.json`: depend on `@mycli/tools`.
- `apps/mycli/src/node-runtime/node-backend.ts`: compose registry/router/runtime.
- `apps/mycli/src/node-runtime/node-gateway.ts`: tool lifecycle projection.
- `apps/mycli/package.json`: depend on `@mycli/tools`.
- app gateway/backend tests.
- `docs/node-runtime-rollout.md`: M3 support and rollback status.

Delete after all imports move in Task 7:

- `packages/runtime/src/no-tool-runtime.ts`
- `packages/runtime/test/no-tool-runtime.test.ts`

Do not stage or commit `.trellis/tasks/08-03-node-runtime-rewrite/` or
`.trellis/workspace/Cosmos/`.

### Task 1: Extend Contracts And Canonical Core Types

**Files:**

- Modify: `packages/contracts/schemas/runtime-turn.schema.json`
- Modify: `packages/contracts/schemas/gateway-events.schema.json`
- Generate: `packages/contracts/src/generated/runtime-turn-record.ts`
- Generate: `packages/contracts/src/generated/gateway-event-notification.ts`
- Generate: `src/mycli/schemas/generated/runtime-turn.schema.json`
- Generate: `src/mycli/schemas/generated/gateway-events.schema.json`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/request-projection.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/contracts/test/runtime-turn.test.ts`
- Test: `packages/core/test/request-projection.test.ts`

- [ ] **Step 1: Write failing contract and projection tests**

Add assertions that both new error codes validate, unknown codes fail, and a projected request
retains ordered tool definitions and continuation items:

```ts
const readTool: ToolDefinition = {
	id: "builtin:Read",
	name: "Read",
	description: "Read a bounded file range.",
	inputSchema: {
		type: "object",
		properties: { file_path: { type: "string" } },
		required: ["file_path"],
		additionalProperties: false,
	},
};

const request = projectProviderRequest({
	config,
	instructions: "You are mycli.",
	history: [{ type: "user", text: "Read README.md" }],
	tools: [readTool],
});

assert.deepEqual(request.tools, [readTool]);
assert.deepEqual(request.items, [{ type: "user", text: "Read README.md" }]);
assert.equal(parseRuntimeTurnRecord(failedTurn("tool_budget_exceeded")).error_code,
	"tool_budget_exceeded");
assert.equal(parseRuntimeTurnRecord(failedTurn("tool_protocol_error")).error_code,
	"tool_protocol_error");
```

- [ ] **Step 2: Run focused tests and verify red**

Run:

```bash
node --import tsx --test packages/contracts/test/runtime-turn.test.ts packages/core/test/request-projection.test.ts
```

Expected: FAIL because the generated enum and canonical tool types/projection do not exist.

- [ ] **Step 3: Add contract enums and canonical types**

Add `tool_budget_exceeded` and `tool_protocol_error` to both canonical schema enums. Replace the
text-only message model with this discriminated transcript while retaining `CanonicalMessage` as
the compatible user/assistant text subset accepted by existing callers:

```ts
export interface ToolDefinition {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface CanonicalToolCall {
	readonly callId: string;
	readonly name: string;
	readonly argumentsJson: string;
}

export interface CanonicalToolResult {
	readonly callId: string;
	readonly toolName: string;
	readonly output: string;
	readonly success: boolean;
}

export type CanonicalConversationItem =
	| { readonly type: "user"; readonly text: string }
	| { readonly type: "assistant"; readonly text: string }
	| {
		readonly type: "assistant_tool_calls";
		readonly text: string;
		readonly calls: readonly CanonicalToolCall[];
		readonly responseId?: string;
	}
	| ({ readonly type: "tool_result" } & CanonicalToolResult);

export interface ProviderRequest extends ProviderRequestConfig {
	readonly instructions: string;
	readonly items: readonly CanonicalConversationItem[];
	readonly tools: readonly ToolDefinition[];
	readonly previousResponseId?: string;
}
```

Make `ProviderEvent.tool_call.callId` required. Rename `projectNoToolRequest` to
`projectProviderRequest`; keep a temporary `projectNoToolRequest` wrapper returning an empty tool
array until all M2 imports are migrated in Task 6.

- [ ] **Step 4: Regenerate contracts and run focused tests**

Run:

```bash
npm run contracts:generate
npm run test --workspace @mycli/contracts
npm run test --workspace @mycli/core
npm run typecheck --workspace @mycli/core
```

Expected: all commands PASS and generated Python/TypeScript files contain both new codes.

- [ ] **Step 5: Commit the contract slice**

```bash
git add packages/contracts packages/core src/mycli/schemas/generated
git commit -m "feat(node-core): add canonical tool turn contracts"
```

### Task 2: Create The Tool Manifest, Exposure Planner, And Router

**Files:**

- Create: `packages/tools/package.json`
- Create: `packages/tools/tsconfig.json`
- Create: `packages/tools/tsconfig.build.json`
- Create: `packages/tools/src/types.ts`
- Create: `packages/tools/src/manifest.ts`
- Create: `packages/tools/src/exposure-planner.ts`
- Create: `packages/tools/src/router.ts`
- Create: `packages/tools/src/index.ts`
- Create: `packages/tools/test/manifest.test.ts`
- Create: `packages/tools/test/router.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Scaffold the workspace with dependencies**

Create `@mycli/tools` using the same ESM/build/typecheck scripts as sibling packages and these
runtime dependencies:

```json
{
  "dependencies": {
    "@mycli/core": "0.1.0",
    "ajv": "^8.17.1",
    "csv-parse": "^6.1.0"
  }
}
```

Run `npm install --ignore-scripts` to update the lockfile, add tools before runtime in the root
build script, and add `@mycli/tools` to root dependencies.

- [ ] **Step 2: Write failing manifest and router tests**

Cover exact inventory, purity, schema order, malformed JSON, array JSON, invalid fields, retired
names, unexposed names, and successful dispatch:

```ts
assert.deepEqual(builtinToolManifest().tools.map((tool) => tool.name), ["Read"]);
assert.deepEqual(planToolExposure(builtinToolManifest()).map((tool) => tool.name), ["Read"]);
assert.equal(JSON.stringify(builtinToolManifest()).includes("LS"), false);
assert.equal(JSON.stringify(builtinToolManifest()).includes("Glob"), false);
assert.equal(JSON.stringify(builtinToolManifest()).includes("Grep"), false);

const malformed = await router.execute({
	callId: "call-1",
	name: "Read",
	argumentsJson: "[1,2]",
}, { signal: new AbortController().signal });
assert.equal(malformed.success, false);
assert.equal(malformed.errorKind, "invalid_arguments");

const retired = await router.execute({
	callId: "call-2",
	name: "Grep",
	argumentsJson: "{}",
}, { signal: new AbortController().signal });
assert.equal(retired.success, false);
assert.equal(retired.errorKind, "unknown_tool");
```

- [ ] **Step 3: Run tools tests and verify red**

Run:

```bash
npm run test --workspace @mycli/tools
```

Expected: FAIL because package exports and implementation files do not exist.

- [ ] **Step 4: Implement pure manifest, planner, and validated router**

Define stable tool contracts in `types.ts`:

```ts
export interface ToolExecutionResult {
	readonly callId: string;
	readonly toolName: string;
	readonly success: boolean;
	readonly modelOutput: string;
	readonly summary: string;
	readonly errorKind?: string;
	readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ToolAdapter {
	readonly definition: ToolDefinition;
	execute(argumentsValue: Readonly<Record<string, unknown>>, options: {
		readonly signal: AbortSignal;
	}): Promise<ToolExecutionResult>;
}
```

Build a frozen manifest with exactly `builtin:Read`. Compile one Ajv validator per registered
adapter in the router constructor. Parse JSON once, require a non-array object, validate it, and
return sanitized failed results for unknown/unexposed/invalid calls. Do not expose raw Ajv data or
full argument JSON in errors.

- [ ] **Step 5: Run package tests, typecheck, build, and commit**

```bash
npm run test --workspace @mycli/tools
npm run typecheck --workspace @mycli/tools
npm run build --workspace @mycli/tools
git add package.json package-lock.json packages/tools
git commit -m "feat(node-tools): add Read manifest and router"
```

Expected: all commands PASS.

### Task 3: Implement Workspace-Safe Read Execution

**Files:**

- Create: `packages/tools/src/path-policy.ts`
- Create: `packages/tools/src/read-text.ts`
- Create: `packages/tools/src/read-delimited.ts`
- Create: `packages/tools/src/read-tool.ts`
- Modify: `packages/tools/src/index.ts`
- Create: `packages/tools/test/path-policy.test.ts`
- Create: `packages/tools/test/read-text.test.ts`
- Create: `packages/tools/test/read-delimited.test.ts`
- Create: `packages/tools/test/read-tool.test.ts`

- [ ] **Step 1: Write failing path-policy tests**

Create a disposable workspace and verify relative and absolute in-root paths succeed while parent
traversal, symlink escape, missing paths, and directories produce stable kinds:

```ts
assert.equal(await resolveReadableWorkspaceFile(root, "src/a.ts"), join(root, "src/a.ts"));
await assert.rejects(() => resolveReadableWorkspaceFile(root, "../secret"),
	(error: unknown) => hasKind(error, "workspace_escape"));
await assert.rejects(() => resolveReadableWorkspaceFile(root, "outside-link"),
	(error: unknown) => hasKind(error, "workspace_escape"));
await assert.rejects(() => resolveReadableWorkspaceFile(root, "src"),
	(error: unknown) => hasKind(error, "is_directory"));
```

- [ ] **Step 2: Implement realpath-based workspace confinement**

Resolve the workspace once, resolve the candidate relative to it, call `realpath` on the target,
and use `relative(realRoot, realTarget)` to reject absolute or `..` results. Classify only bounded
error kinds: `not_found`, `permission_denied`, `workspace_escape`, `is_directory`, and
`invalid_path`.

- [ ] **Step 3: Write failing text reader tests**

Cover empty files, one-based offsets, `limit=0`, `limit>500`, 2,000-character lines, CRLF,
multibyte UTF-8 across stream chunks, invalid UTF-8, NUL/binary detection, large streaming input,
snapshot SHA-256, and next-offset rendering:

```ts
const result = await readTextWindow(path, { offset: 2, limit: 2, signal });
assert.equal(result.content, "two\nthree\n... (output truncated; use offset=4 with limit to continue)\n");
assert.equal(result.totalLines, 5);
assert.equal(result.shownLines, 2);
assert.equal(result.truncated, true);
assert.equal(result.effectiveLimit, 2);
assert.match(result.sha256, /^[0-9a-f]{64}$/);
```

- [ ] **Step 4: Implement streaming UTF-8 reads**

Use `createReadStream`, `StringDecoder("utf8")`, incremental SHA-256, and abort-aware iteration.
Keep only requested lines plus a small binary-detection prefix in memory. Clamp limit to `0..500`,
truncate rendered lines at 2,000 characters, and return deterministic continuation metadata.

- [ ] **Step 5: Write failing CSV/TSV tests**

Cover quoted delimiters, embedded newlines, headers, small/large previews, numeric min/max/sum/avg,
UTF-8 errors, empty files, and rejection above 8 MiB:

```ts
const result = await readDelimitedFile(csvPath, { offset: 1, limit: 20, signal });
assert.deepEqual(result.headers, ["name", "amount"]);
assert.equal(result.preview[0]?.name, "alpha,beta");
assert.equal(result.numericSummary.amount?.sum, 30);
assert.equal(result.content.includes("alpha,beta"), true);
```

- [ ] **Step 6: Implement structured parsing and the Read adapter**

Use `csv-parse/sync` only after stat rejects files larger than `8 * 1024 * 1024`. The adapter
selects text or CSV/TSV by lowercase suffix, rejects other structured/binary formats, records
snapshots by `(realPath, offset, effectiveLimit, pages)`, and formats at most 8,000 model-visible
characters. Metadata contains workspace-relative path, range, truncation, size, mtime, SHA-256,
and dedup only; it never contains full content.

- [ ] **Step 7: Run tools quality gates and commit**

```bash
npm run test --workspace @mycli/tools
npm run typecheck --workspace @mycli/tools
npm run build --workspace @mycli/tools
npm run lint -- --no-warn-ignored packages/tools/src packages/tools/test
git add packages/tools package-lock.json
git commit -m "feat(node-tools): implement workspace-safe Read"
```

Expected: all commands PASS.

### Task 4: Add Tool Protocol Support To Both Providers

**Files:**

- Modify: `packages/providers/src/responses-provider.ts`
- Modify: `packages/providers/src/chat-provider.ts`
- Modify: `packages/providers/src/model-provider.ts`
- Test: `packages/providers/test/responses-provider.test.ts`
- Test: `packages/providers/test/chat-provider.test.ts`
- Modify/Create: `packages/providers/test/fixtures/*tool*.json`

- [ ] **Step 1: Write failing Responses serialization tests**

Capture request bodies for an initial request and a continuation:

```ts
assert.deepEqual(initial.tools, [{
	type: "function",
	name: "Read",
	description: readTool.description,
	parameters: readTool.inputSchema,
}]);

assert.equal("previous_response_id" in continued, false);
assert.deepEqual(continued.input.slice(-2), [
	{ type: "function_call", call_id: "call-1", name: "Read", arguments: readArguments },
	{ type: "function_call_output", call_id: "call-1", output: readOutput },
]);
```

Also assert missing/empty `call_id` produces `tool_protocol_error` before runtime execution.

- [ ] **Step 2: Write failing Chat serialization tests**

Verify OpenAI function declarations and continuation transcript ordering:

```ts
assert.deepEqual(body.tools, [{
	type: "function",
	function: {
		name: "Read",
		description: readTool.description,
		parameters: readTool.inputSchema,
	},
}]);
assert.deepEqual(body.messages.slice(-2), [
	{
		role: "assistant",
		content: "",
		tool_calls: [{ id: "call-1", type: "function", function: {
			name: "Read", arguments: readArguments,
		} }],
	},
	{ role: "tool", tool_call_id: "call-1", content: readOutput },
]);
```

- [ ] **Step 3: Run provider tests and verify red**

```bash
npm run test --workspace @mycli/providers
```

Expected: FAIL because request serialization ignores tools and continuation items.

- [ ] **Step 4: Implement provider-neutral projection**

Responses maps canonical items to ordered HTTP/SSE input and replays the complete tool transcript
for continuation without `previous_response_id`. Chat maps every canonical item to ordered
system/user/assistant/tool messages. Both adapters serialize the same ordered definitions and
preserve tool call order. Optional tool properties keep ordinary JSON Schema semantics, so neither
adapter enables strict function-schema mode unless every property is encoded as required.

Make tool-call parsing require a non-empty call ID and map violations to `ProviderFailure` with
code `tool_protocol_error`. Do not include arguments JSON in diagnostics.

- [ ] **Step 5: Run provider tests, typecheck, build, and commit**

```bash
npm run test --workspace @mycli/providers
npm run typecheck --workspace @mycli/providers
npm run build --workspace @mycli/providers
git add packages/providers
git commit -m "feat(node-providers): support tool continuations"
```

### Task 5: Persist Canonical Tool Calls And Results

**Files:**

- Modify: `packages/storage/src/session-store.ts`
- Modify: `packages/storage/src/sqlite-session-store.ts`
- Modify: `packages/storage/src/index.ts`
- Test: `packages/storage/test/sqlite-session-store.test.ts`
- Test: `packages/storage/test/recovery.test.ts`
- Modify: `packages/storage/test/support/parity-helper.ts`

- [ ] **Step 1: Write failing append/load tests**

Extend the store contract with separate durable call and result operations:

```ts
interface AppendAssistantToolCallsInput {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly assistantText: string;
	readonly calls: readonly CanonicalToolCall[];
	readonly responseId?: string;
}

interface AppendToolResultInput {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly result: CanonicalToolResult;
}
```

Assert one call/result round loads as these canonical items and raw payloads remain Python-shaped:

```ts
assert.deepEqual(store.loadConversationItems("session-1").slice(-2), [
	{ type: "assistant_tool_calls", text: "", calls: [call], responseId: "resp-1" },
	{ type: "tool_result", callId: "call-1", toolName: "Read", output, success: true },
]);
assert.equal(rawAssistant.role, "assistant");
assert.deepEqual(rawAssistant.tool_calls, [{ name: "Read", arguments: args, call_id: "call-1" }]);
assert.equal(rawTool.role, "tool");
assert.equal(rawTool.tool_call_id, "call-1");
```

- [ ] **Step 2: Write failing recovery tests**

Insert an in-progress assistant call without a matching tool message, reopen the store, and assert
recovery appends one synthetic failed tool result and does not duplicate it on a second reopen.

- [ ] **Step 3: Run storage tests and verify red**

```bash
npm run test --workspace @mycli/storage
```

Expected: FAIL because the store supports text messages only.

- [ ] **Step 4: Implement transcript parsing and atomic append**

Add `loadConversationItems` while preserving `loadConversation` as the text-only compatibility
view used by M2 tests. `appendAssistantToolCalls` validates the running turn and writes the
assistant conversation/history payloads in one short transaction before execution.
`appendToolResult` requires an earlier unmatched call with the same ID and writes its
conversation/history payloads in one short transaction. It rejects duplicate or out-of-order
results. Parse Python tuples/lists and Node arrays into the same canonical items without guessing
malformed data.

Recovery scans running turns only, finds call IDs without later matching tool messages, appends
bounded `success=false` interrupted results, then applies existing owner-aware interrupted-turn
recovery. It never contacts a provider or filesystem tool.

- [ ] **Step 5: Run storage gates and commit**

```bash
npm run test --workspace @mycli/storage
npm run typecheck --workspace @mycli/storage
npm run build --workspace @mycli/storage
git add packages/storage
git commit -m "feat(node-storage): persist tool transcripts"
```

### Task 6: Replace The No-Tool Runtime With A Bounded Tool Loop

**Files:**

- Create: `packages/runtime/src/node-turn-runtime.ts`
- Create: `packages/runtime/test/node-turn-runtime.test.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/runtime/package.json`
- Delete: `packages/runtime/test/no-tool-runtime.test.ts`

- [ ] **Step 1: Copy M2 behavioral tests under the new runtime name**

Rename test types to `TurnSubmission`, `NodeTurnRuntimeOptions`, and `NodeTurnRuntime`. Preserve
every M2 test for reservation, config, no-tool success, retry, interruption, persistence failure,
duplicate submission, local-image rejection, and error normalization.

- [ ] **Step 2: Add failing tool-loop tests**

Use a scripted provider and fake router to cover one Read call, multiple sequential calls,
tool-level failure recovery, final text, missing call IDs, 8-step/16-call budgets, abort between
execution and continuation, retry isolation per provider step, and persistence-before-continuation:

```ts
assert.deepEqual(trace, [
	"reserve",
	"provider:1",
	"persist:calls",
	"tool:start:call-1",
	"tool:complete:call-1",
	"persist:results",
	"provider:2",
	"complete",
]);
assert.deepEqual(emitted.map((event) => event.type), [
	"turn_started",
	"tool_call_accepted",
	"tool_execution_started",
	"tool_execution_completed",
	"text_delta",
	"message_complete",
	"turn_completed",
]);
```

- [ ] **Step 3: Run runtime tests and verify red**

```bash
npm run test --workspace @mycli/runtime
```

Expected: new tool-loop cases FAIL while copied M2 cases remain green or fail only on renamed
exports.

- [ ] **Step 4: Implement `NodeTurnRuntime`**

Inject `planTools(): readonly ToolDefinition[]` and `toolRouter: ToolRouter`. For each provider
step, collect text/reasoning/usage/tool calls until exactly one completion, persist and execute
calls sequentially, append durable results, then project a continuation request. Accumulate usage
and final assistant text across steps without treating pre-tool text as final.

Keep the provider/tool loop unbounded by default to match Python behavior. Tool results, including
expected failures, continue the loop. Provider protocol errors, persistence failures, request
retry exhaustion, and interruption terminate with stable codes. Retain the M2 pre-event retry
rule independently for each provider step, and test successful turns beyond eight provider steps
and sixteen tool calls.

- [ ] **Step 5: Add a temporary compatibility export and run gates**

Replace `no-tool-runtime.ts` with a small re-export so `apps/mycli` remains buildable until Task 7:

```ts
export { NodeTurnRuntime as NoToolRuntime } from "./node-turn-runtime.ts";
export type {
	NodeTurnRuntimeOptions as NoToolRuntimeOptions,
	TurnSubmission as NoToolSubmission,
	SubmitTurnOptions,
} from "./node-turn-runtime.ts";
```

Update runtime exports and run:

```bash
npm run test --workspace @mycli/runtime
npm run typecheck --workspace @mycli/runtime
npm run build --workspace @mycli/runtime
```

Expected: all M2 and M3 runtime tests PASS; the only production `NoToolRuntime` occurrence is the
temporary compatibility module/export.

- [ ] **Step 6: Commit the runtime loop**

```bash
git add packages/runtime package-lock.json
git commit -m "feat(node-runtime): execute bounded tool turns"
```

### Task 7: Compose The Node Backend, Project TUI Events, And Prove Parity

**Files:**

- Modify: `apps/mycli/package.json`
- Modify: `apps/mycli/src/node-runtime/node-backend.ts`
- Modify: `apps/mycli/src/node-runtime/node-gateway.ts`
- Modify: `apps/mycli/test/node-gateway.test.ts`
- Modify: `apps/mycli/test/node-backend.integration.test.ts`
- Create: `apps/mycli/test/m3-read-turn.integration.test.ts`
- Create: `tests/fixtures/node_runtime_m3/tool_contract.json`
- Create: `tests/integration/test_node_runtime_m3_parity.py`
- Create: `scripts/smoke_node_m3_read.mjs`
- Modify: `package.json`
- Modify: `docs/node-runtime-rollout.md`

- [ ] **Step 1: Write failing gateway lifecycle tests**

Inject runtime tool events and assert existing gateway/TUI-compatible notifications:

```ts
assert.deepEqual(turnEvents.map((event) => event.params.kind), [
	"tool_start", "tool_complete", "tool_failed",
]);
assert.equal(turnEvents[0]?.params.tool_name, "Read");
assert.equal(turnEvents[0]?.params.metadata.call_id, "call-1");
assert.equal(JSON.stringify(turnEvents).includes(fileContents), false);
```

Ensure metadata contains only workspace-relative path, range, duration, success/truncation, and
error kind.

- [ ] **Step 2: Compose the real tool runtime**

In `startNodeBackend`, construct `ReadTool({ workspaceRoot })`, the built-in manifest/exposure,
`ToolRouter`, and `NodeTurnRuntime`. Add `@mycli/tools` to app/root dependencies and build order.
Do not import, spawn, probe, or fall back to Python from the Node backend. After updating all app
imports and tests, delete the temporary `packages/runtime/src/no-tool-runtime.ts` compatibility
module and remove its export.

- [ ] **Step 3: Add deterministic end-to-end and parity fixtures**

The app integration test uses a fake two-step provider transport and a disposable workspace:

```ts
await writeFile(join(root, "README.md"), "alpha\nbeta\n", "utf8");
// Step 1 emits Read(file_path="README.md", offset=1, limit=2).
// Step 2 emits final text and completed.
assert.equal(result.status, "completed");
assert.equal(result.assistantText, "README inspected.");
assert.equal(pythonSpawnCount, 0);
```

The shared JSON corpus covers manifest definition, valid result output, invalid arguments,
workspace escape, tool call/result payloads, and lifecycle events. Python tests project the active
`ReadTool` and serializers into the same sanitized canonical shape; intentional differences are
limited to retired tools being absent from the Node M3 exposure.

- [ ] **Step 4: Run focused app and parity tests**

```bash
npm run test --workspace @cosmos2023/mycli
uv run pytest tests/integration/test_node_runtime_m3_parity.py -q
```

Expected: all tests PASS and no test starts a real provider request.

- [ ] **Step 5: Add rollout docs and live smoke harness**

Document that Python remains default, Node M3 supports no-tool plus `Read` turns, retired tools are
not available, rollback selects Python before a later turn, and a Node failure never replays.

The smoke harness accepts credentials only through existing config/environment, creates a
temporary workspace with a small public fixture, limits output tokens and timeout, performs one
turn, and prints only:

```json
{
  "protocol": "responses",
  "status": "completed",
  "tool_start": 1,
  "tool_complete": 1,
  "persisted": true,
  "python_started": false
}
```

- [ ] **Step 6: Run the complete offline quality gate**

```bash
npm run contracts:check
npm run lint
npm run typecheck
npm test
npm run build
npm run smoke:package
uv run ruff check .
uv run mypy src
uv run pytest -q
```

Expected: all commands PASS; existing documented skips remain skips; nine workspace package pack
smokes pass after adding `@mycli/tools`.

- [ ] **Step 7: Run one authorized live API smoke when configured**

Use the configured OpenAI-compatible endpoint and credential without printing or persisting the
secret. Run exactly one bounded M3 smoke after the offline gate. If the account has no usable
credit, record `not_run=provider_billing_unavailable` and do not treat that external condition as
an implementation failure.

- [ ] **Step 8: Commit the integrated M3 slice**

```bash
git add package.json package-lock.json apps/mycli tests/fixtures/node_runtime_m3 \
  tests/integration/test_node_runtime_m3_parity.py scripts/smoke_node_m3_read.mjs \
  docs/node-runtime-rollout.md
git commit -m "feat(node-runtime): complete M3 Read turns"
```

## Final Review Checklist

- [ ] `git diff --check` reports no whitespace errors.
- [ ] `git status --short` contains only the two known untracked Trellis directories.
- [ ] `rg '"(LS|Glob|Grep)"' packages/tools` finds only negative tests or retirement assertions.
- [ ] `rg 'NoToolRuntime' apps packages` finds no production import.
- [ ] Contract generation is deterministic and checked in.
- [ ] All tool outputs and public errors are bounded and credential-free.
- [ ] Tool call/result order is identical in events, persistence, and provider continuation.
- [ ] A complete M3 Read turn starts no Python process.
- [ ] Node remains explicitly selected and Python remains the default backend.
- [ ] No `.trellis/tasks/08-03-node-runtime-rewrite/` or `.trellis/workspace/Cosmos/` files are staged.
