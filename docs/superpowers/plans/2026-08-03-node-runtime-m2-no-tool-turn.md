# Node Runtime M2 No-Tool Turn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete and persist a no-tool model turn entirely in Node through both OpenAI Responses and OpenAI-compatible Chat Completions while preserving the existing TUI, configuration, auth, events, and SQLite data contracts.

**Architecture:** Add five focused npm workspace packages: pure runtime contracts in `core`, compatible local settings in `config`, SDK-isolated transports in `providers`, schema-v2 SQLite compatibility in `storage`, and orchestration in `runtime`. `apps/mycli` hosts an in-process JSON-RPC transport for the Node backend and continues to expose the same transport interface to the TUI. Node remains explicitly selectable and never falls back to Python after accepting a turn.

**Tech Stack:** Node.js 22.19+, TypeScript 5.9 strict ESM, npm workspaces, Node test runner, JSON Schema Draft 2020-12, Ajv, OpenAI SDK 7.x, better-sqlite3 13.x, smol-toml 1.x, Python 3.13 parity fixtures, pytest, Ruff, and mypy.

---

## File Map

### Contracts

- Modify `packages/contracts/schemas/gateway-events.schema.json`: add optional terminal error/idempotency fields and stable error codes.
- Create `packages/contracts/schemas/runtime-turn.schema.json`: canonical durable reservation/result records.
- Modify `packages/contracts/scripts/generate.mjs`: generate and mirror the runtime-turn declaration/schema.
- Modify `packages/contracts/src/index.ts`: export the new generated type and validator.
- Test `packages/contracts/test/runtime-turn.test.ts`: valid/invalid runtime turn records and additive gateway fields.

### Core

- Create `packages/core/src/types.ts`: branded IDs, protocols, messages, provider/runtime events, and turn snapshots.
- Create `packages/core/src/errors.ts`: stable typed runtime errors.
- Create `packages/core/src/turn-state.ts`: pure state transitions.
- Create `packages/core/src/request-projection.ts`: canonical no-tool request projection.
- Create `packages/core/src/fingerprint.ts`: deterministic, secret-free submission fingerprints.
- Create `packages/core/src/index.ts`: public exports.
- Test `packages/core/test/*.test.ts`: state, projection, fingerprint, and error behavior.

### Config

- Create `packages/config/src/auth-store.ts`: compatible auth JSON reader.
- Create `packages/config/src/provider-profiles.ts`: provider inference and protocol compatibility.
- Create `packages/config/src/settings.ts`: precedence-aware M2 settings resolver.
- Create `packages/config/src/redaction.ts`: recursive diagnostics redaction.
- Create `packages/config/src/index.ts`: public exports.
- Test `packages/config/test/*.test.ts`: precedence, malformed files, auth references, provider profiles, and redaction.

### Providers

- Create `packages/providers/src/model-provider.ts`: local streaming interface and injectable client boundary.
- Create `packages/providers/src/errors.ts`: sanitized SDK/HTTP error classification.
- Create `packages/providers/src/responses-provider.ts`: Responses event/request mapping.
- Create `packages/providers/src/chat-provider.ts`: Chat request/event mapping.
- Create `packages/providers/src/openai-provider-registry.ts`: configured adapter construction.
- Create `packages/providers/src/index.ts`: public exports.
- Test `packages/providers/test/*.test.ts` and sanitized fixtures under `packages/providers/test/fixtures/`.

### Storage

- Create `packages/storage/src/session-store.ts`: driver-independent turn persistence interface.
- Create `packages/storage/src/schema.ts`: existing schema-v2 DDL plus additive `runtime_turns` table.
- Create `packages/storage/src/sqlite-session-store.ts`: short-transaction implementation.
- Create `packages/storage/src/index.ts`: public exports.
- Test `packages/storage/test/*.test.ts`: initialization, append/read compatibility, idempotency, recovery, busy errors, and malformed JSON.

### Runtime And Application

- Create `packages/runtime/src/retry-policy.ts`: pure retry decisions and injected delay/jitter.
- Create `packages/runtime/src/no-tool-runtime.ts`: turn orchestration and normalized events.
- Create `packages/runtime/src/index.ts`: public exports.
- Test `packages/runtime/test/*.test.ts`: event order, persistence order, cancellation, retry, no replay, and tool rejection.
- Create `apps/mycli/src/node-runtime/node-backend.ts`: composition root for Node-native M2.
- Create `apps/mycli/src/node-runtime/node-gateway.ts`: in-process JSON-RPC stream transport.
- Modify `apps/mycli/src/backend-router.ts` and `apps/mycli/src/cli.ts`: make `node` selectable and avoid Python startup.
- Test `apps/mycli/test/node-backend.integration.test.ts`, `apps/mycli/test/node-gateway.test.ts`, and existing CLI tests.

### Parity, Smoke, And Documentation

- Create `tests/fixtures/node_runtime_m2/`: sanitized request, provider, event, and SQLite fixture corpus.
- Create `tests/integration/test_node_runtime_m2_parity.py`: Python reader/request-projection parity checks.
- Create `scripts/smoke_node_m2.mjs`: bounded Responses and Chat live smoke.
- Modify `.github/workflows/cross-platform.yml`: explicit M2 compiled/runtime test gates.
- Create `docs/superpowers/reports/2026-08-03-node-runtime-m2-no-tool-turn-smoke.md`: sanitized evidence.
- Create `docs/node-runtime-rollout.md`: consolidated M1/M2 selection, supported capability, and rollback instructions.

---

### Task 1: Canonical M2 Contracts And Workspace Scaffolding

**Files:**
- Modify: `packages/contracts/schemas/gateway-events.schema.json`
- Create: `packages/contracts/schemas/runtime-turn.schema.json`
- Modify: `packages/contracts/scripts/generate.mjs`
- Modify: `packages/contracts/src/validation.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/runtime-turn.test.ts`
- Create: `packages/{core,config,providers,storage,runtime}/package.json`
- Create: `packages/{core,config,providers,storage,runtime}/tsconfig.json`
- Create: `packages/{core,config,providers,storage,runtime}/tsconfig.build.json`
- Create: `packages/{core,config,providers,storage,runtime}/src/index.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing contract tests**

Test the durable record discriminator and the optional terminal error code:

```ts
test("validates a completed durable runtime turn", () => {
  const turn = parseRuntimeTurnRecord({
    schema_version: 1,
    session_id: "session-1",
    client_turn_id: "client-1",
    turn_id: "turn-1",
    request_fingerprint: "sha256:abc",
    status: "completed",
    error_code: null,
    result: { assistant_text: "ok" },
    started_at: "2026-08-03T00:00:00.000Z",
    completed_at: "2026-08-03T00:00:01.000Z",
  });
  assert.equal(turn.status, "completed");
});

test("accepts a typed turn.failed notification", () => {
  assert.doesNotThrow(() => parseGatewayEvent({
    jsonrpc: "2.0",
    method: "turn.failed",
    params: {
      client_turn_id: "client-1",
      turn_id: "turn-1",
      message: "Authentication failed.",
      code: "auth_error",
    },
  }));
});
```

- [ ] **Step 2: Run tests and confirm missing validator/schema failures**

Run: `npm run test --workspace @mycli/contracts -- --test-name-pattern="runtime turn|typed turn.failed"`

Expected: FAIL because `parseRuntimeTurnRecord` and the new schema fields do not exist.

- [ ] **Step 3: Add the schema and generator target**

Define a closed record with `schema_version: 1`, required identity/fingerprint/status/timestamps,
nullable error/result/completion fields, and the M2 status/error enums. Add
`["runtime-turn.schema.json", "runtime-turn-record.ts"]` to `targets`, mirror the schema into
`src/mycli/schemas/generated`, compile it in `validation.ts`, and export:

```ts
export function parseRuntimeTurnRecord(value: unknown): RuntimeTurnRecord {
  return parse(value, validateRuntimeTurn, "runtime turn record");
}
```

Extend `turn.failed`, `turn.interrupted`, and `turn.submit`/response-compatible payload schemas only
with additive optional fields. Regenerate declarations with `npm run contracts:generate`.

- [ ] **Step 4: Add focused workspace manifests**

Each new package uses the established strict ESM scripts and exports compiled `dist/index.js`.
Update root build order to `contracts -> core -> config/providers/storage -> runtime -> TUI -> app`.
Use workspace dependencies such as:

```json
{
  "dependencies": {
    "@mycli/contracts": "0.1.0",
    "@mycli/core": "0.1.0"
  }
}
```

Seed each package entry point with `export {};` so the initial workspace typecheck/build has a
real input. Later tasks replace the relevant empty entry point with explicit public exports.

- [ ] **Step 5: Verify generation, typecheck, and tests**

Run: `npm run contracts:check && npm run typecheck && npm run test --workspace @mycli/contracts`

Expected: all commands PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json packages/contracts packages/core packages/config packages/providers packages/storage packages/runtime src/mycli/schemas/generated
git commit -m "feat(node-runtime): define M2 runtime contracts"
```

### Task 2: Pure Turn State, Fingerprint, And Request Projection

**Files:**
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/errors.ts`
- Create: `packages/core/src/turn-state.ts`
- Create: `packages/core/src/fingerprint.ts`
- Create: `packages/core/src/request-projection.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/turn-state.test.ts`
- Create: `packages/core/test/fingerprint.test.ts`
- Create: `packages/core/test/request-projection.test.ts`

- [ ] **Step 1: Write failing pure-domain tests**

Cover legal/illegal terminal transitions, deterministic fingerprints independent of object-key
order, no secret inputs, and one canonical shape projected to both provider lanes:

```ts
const running = startTurn({
  sessionId: "session-1",
  clientTurnId: "client-1",
  turnId: "turn-1",
  startedAt: "2026-08-03T00:00:00.000Z",
});
assert.equal(completeTurn(running, { assistantText: "ok", completedAt: now }).status, "completed");
assert.throws(() => failTurn(completeTurn(running, result), failure), /invalid_turn_transition/);

const shape = projectNoToolRequest({ config, instructions: "system", history, userText: "hello" });
assert.deepEqual(shape.tools, []);
assert.equal(shape.protocol, "responses");
```

- [ ] **Step 2: Run core tests and confirm missing-module failures**

Run: `npm run test --workspace @mycli/core`

Expected: FAIL because the core exports do not exist.

- [ ] **Step 3: Implement immutable domain types and typed errors**

Use discriminated unions for `ProviderEvent` and `RuntimeEvent`, readonly values, and a
`RuntimeFailure` carrying only `code`, public `message`, retryability, optional retry-after, and
sanitized diagnostics. No function in this package may call IO, clock, random, or environment APIs.

- [ ] **Step 4: Implement deterministic state and projection functions**

Canonicalize submission fields recursively, hash them with `node:crypto`, and prefix the digest
with `sha256:`. Project the same ordered system/history/user shape for either protocol while
keeping `tools: []`. Require injected IDs and timestamps.

- [ ] **Step 5: Run core gates**

Run: `npm run test --workspace @mycli/core && npm run typecheck --workspace @mycli/core`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(node-runtime): add no-tool turn domain"
```

### Task 3: Compatible Configuration, Authentication, And Redaction

**Files:**
- Create: `packages/config/src/auth-store.ts`
- Create: `packages/config/src/provider-profiles.ts`
- Create: `packages/config/src/settings.ts`
- Create: `packages/config/src/redaction.ts`
- Modify: `packages/config/src/index.ts`
- Create: `packages/config/test/auth-store.test.ts`
- Create: `packages/config/test/settings.test.ts`
- Create: `packages/config/test/provider-profiles.test.ts`
- Create: `packages/config/test/redaction.test.ts`
- Modify: `packages/config/package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing compatibility tests**

Build temporary home/workspace trees and assert exact precedence:

```ts
const resolved = await resolveConfig({
  homeDir,
  workspaceRoot,
  env: { MYCLI_MODEL: "env-model", OPENAI_API_KEY: "secret" },
  overrides: {},
});
assert.equal(resolved.model, "env-model");
assert.equal(resolved.apiKey, "secret");
assert.equal(redactConfig(resolved).apiKey, "[REDACTED]");
```

Also test `~/.mycli` before project before legacy, nested TOML flattening, malformed TOML as
`config_error`, malformed auth JSON as empty, `auth_ref`, base-URL inference, retry clamping, and
unknown protocol rejection.

- [ ] **Step 2: Run config tests and verify failure**

Run: `npm run test --workspace @mycli/config`

Expected: FAIL because the config package has no implementation.

- [ ] **Step 3: Install TOML support and implement readers**

Run: `npm install smol-toml@^1.7.1 --workspace @mycli/config`

Read files with injected paths/environment. Return a typed M2 configuration. Preserve Python
defaults `request_max_retries=4` and `stream_max_retries=5`, clamp retry values to `0..100`, and
never include raw file payloads in thrown errors.

- [ ] **Step 4: Implement provider profiles and recursive redaction**

Port the current OpenAI, Codex, compatible, Qwen, and DeepSeek protocol support/inference needed by
Responses and Chat. Redact keys matching credential/header/cookie/token patterns at any nesting
depth and bound diagnostic strings.

- [ ] **Step 5: Run config and repository type gates**

Run: `npm run test --workspace @mycli/config && npm run typecheck --workspace @mycli/config && npm run lint`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/config package-lock.json
git commit -m "feat(node-runtime): load compatible provider config"
```

### Task 4: Shared Provider Boundary And Responses Adapter

**Files:**
- Create: `packages/providers/src/model-provider.ts`
- Create: `packages/providers/src/errors.ts`
- Create: `packages/providers/src/responses-provider.ts`
- Modify: `packages/providers/src/index.ts`
- Create: `packages/providers/test/fixtures/responses-stream.json`
- Create: `packages/providers/test/model-provider.test.ts`
- Create: `packages/providers/test/responses-provider.test.ts`
- Modify: `packages/providers/package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing Responses fixture tests**

Use an injected fake client whose stream emits sanitized SDK-shaped events. Assert mapped text,
reasoning, usage, completion identity, tool calls, abort propagation, malformed event failure, and
redacted error classification:

```ts
const events = await collect(provider.stream(request, { signal: controller.signal }));
assert.deepEqual(events.map((event) => event.type), [
  "reasoning_delta", "text_delta", "usage", "completed",
]);
assert.equal(fakeClient.lastRequest.tools, undefined);
assert.equal(fakeClient.maxRetries, 0);
```

- [ ] **Step 2: Run provider tests and verify failure**

Run: `npm run test --workspace @mycli/providers -- --test-name-pattern=Responses`

Expected: FAIL because the provider boundary and adapter do not exist.

- [ ] **Step 3: Install SDK and implement the provider-neutral boundary**

Run: `npm install openai@^7.3.0 --workspace @mycli/providers`

Expose only local `ModelProvider`, `ProviderClientFactory`, and sanitized failure types. Set SDK
`maxRetries: 0`; accept configured API key, base URL, timeout, and an injected client in tests.

- [ ] **Step 4: Implement Responses serialization and streaming mapping**

Map canonical instructions and runtime items to Responses `instructions`/`input`. Support output
text deltas, reasoning summary deltas, completed items, response completion, usage, tool calls,
abort, and stable error classification. Unknown behavior-affecting events fail closed.

- [ ] **Step 5: Run provider gates**

Run: `npm run test --workspace @mycli/providers && npm run typecheck --workspace @mycli/providers && npm run lint`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/providers package-lock.json
git commit -m "feat(node-runtime): stream OpenAI Responses"
```

### Task 5: OpenAI-Compatible Chat Adapter And Provider Registry

**Files:**
- Create: `packages/providers/src/chat-provider.ts`
- Create: `packages/providers/src/openai-provider-registry.ts`
- Modify: `packages/providers/src/index.ts`
- Create: `packages/providers/test/fixtures/chat-stream.json`
- Create: `packages/providers/test/chat-provider.test.ts`
- Create: `packages/providers/test/openai-provider-registry.test.ts`

- [ ] **Step 1: Write failing Chat fixture tests**

Assert system/user/assistant message serialization, text and common `reasoning_content` deltas,
usage, finish reason, split tool-call assembly, custom base URL, and no tools declaration:

```ts
const events = await collect(provider.stream(chatRequest, { signal }));
assert.equal(fakeClient.lastRequest.stream, true);
assert.equal(fakeClient.lastRequest.tools, undefined);
assert.deepEqual(events.at(-1), { type: "completed", responseId: "chatcmpl-1" });
```

- [ ] **Step 2: Run Chat tests and verify failure**

Run: `npm run test --workspace @mycli/providers -- --test-name-pattern="Chat|registry"`

Expected: FAIL because the Chat adapter and registry do not exist.

- [ ] **Step 3: Implement Chat mapping and registry selection**

Serialize canonical history into Chat messages, normalize string/array content, buffer streamed
tool-call arguments by index, and emit a single provider tool-call event when complete. Registry
selection is exhaustive on `responses | chat_completions` and rejects unsupported protocols.

- [ ] **Step 4: Run both adapter suites and type gates**

Run: `npm run test --workspace @mycli/providers && npm run typecheck --workspace @mycli/providers`

Expected: PASS for both protocol fixture corpora.

- [ ] **Step 5: Commit**

```bash
git add packages/providers
git commit -m "feat(node-runtime): stream compatible Chat completions"
```

### Task 6: Schema-V2 SQLite Store And Durable Idempotency

**Files:**
- Create: `packages/storage/src/session-store.ts`
- Create: `packages/storage/src/schema.ts`
- Create: `packages/storage/src/sqlite-session-store.ts`
- Modify: `packages/storage/src/index.ts`
- Create: `packages/storage/test/sqlite-session-store.test.ts`
- Create: `packages/storage/test/recovery.test.ts`
- Modify: `packages/storage/package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing storage tests**

Cover fresh schema initialization, existing schema-v2 opening, atomic reservation/user append,
same/different duplicate fingerprints, completed assistant append, canonical history load, and
orphan interruption:

```ts
const first = store.reserveTurn(submission);
const duplicate = store.reserveTurn(submission);
assert.equal(first.kind, "reserved");
assert.equal(duplicate.kind, "existing");
assert.equal(store.loadConversation("session-1").length, 1);
assert.throws(() => store.reserveTurn({ ...submission, requestFingerprint: "sha256:other" }),
  /message_id_conflict/);
```

- [ ] **Step 2: Run storage tests and verify failure**

Run: `npm run test --workspace @mycli/storage`

Expected: FAIL because `SessionStore` and the SQLite adapter do not exist.

- [ ] **Step 3: Install SQLite driver and implement complete schema initialization**

Run: `npm install better-sqlite3@^13.0.2 --workspace @mycli/storage`

Mirror schema-v2 DDL, pragmas, FTS triggers, timestamp format, deterministic JSON serialization,
and busy error handling. Add `runtime_turns` without bumping schema version. Use injected clock.

- [ ] **Step 4: Implement short transaction methods**

Implement `reserveTurn`, `loadTurn`, `loadConversation`, `completeTurn`, `failTurn`, and
`recoverInterruptedTurns`. `reserveTurn` uses `BEGIN IMMEDIATE` and appends exactly one user
message/history item. `completeTurn` appends only completed assistant content and rollout before
updating the reservation.

- [ ] **Step 5: Run storage gates**

Run: `npm run test --workspace @mycli/storage && npm run typecheck --workspace @mycli/storage && npm run lint`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/storage package-lock.json
git commit -m "feat(node-runtime): persist no-tool turns in SQLite"
```

### Task 7: Runtime Retry, Streaming, Cancellation, And Terminal Semantics

**Files:**
- Create: `packages/runtime/src/retry-policy.ts`
- Create: `packages/runtime/src/no-tool-runtime.ts`
- Modify: `packages/runtime/src/index.ts`
- Create: `packages/runtime/test/retry-policy.test.ts`
- Create: `packages/runtime/test/no-tool-runtime.test.ts`

- [ ] **Step 1: Write failing orchestration tests**

Use in-memory fake provider/store and injected clock/sleep/random. Assert persistence before
provider call, exact event ordering, first-event retry, retry-after, post-event no replay,
duplicate no-call behavior, cancellation, late-completion suppression, final-persistence failure,
and tool rejection:

```ts
await runtime.submit(submission, events.push);
assert.deepEqual(trace.slice(0, 3), ["reserve", "turn.started", "provider.stream"]);
assert.equal(provider.calls, 1);

await runtime.submit(submission, events.push);
assert.equal(provider.calls, 1, "duplicate client_turn_id must not call provider twice");
```

- [ ] **Step 2: Run runtime tests and verify failure**

Run: `npm run test --workspace @mycli/runtime`

Expected: FAIL because runtime orchestration does not exist.

- [ ] **Step 3: Implement pure retry policy**

Retry only a retryable failure observed before any provider event. Port retry budget, clamping,
retry-after, exponential delay, and injected jitter. An aborted delay throws `interrupted`.

- [ ] **Step 4: Implement no-tool orchestration**

Reserve first, return existing state on duplicates, resolve config/provider only for new turns,
project canonical history, stream normalized events, aggregate completed assistant blocks, reject
tool calls, and persist exactly one terminal state. Check abort before provider iteration,
between events, during delays, and before final persistence.

- [ ] **Step 5: Run runtime and dependency gates**

Run: `npm run test --workspace @mycli/runtime && npm run typecheck --workspace @mycli/runtime && npm run lint`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime
git commit -m "feat(node-runtime): orchestrate no-tool turns"
```

### Task 8: In-Process Node Gateway And CLI Composition Root

**Files:**
- Modify: `apps/mycli/src/backend-router.ts`
- Create: `apps/mycli/src/node-runtime/node-backend.ts`
- Create: `apps/mycli/src/node-runtime/node-gateway.ts`
- Modify: `apps/mycli/src/cli.ts`
- Modify: `apps/mycli/package.json`
- Create: `apps/mycli/test/node-gateway.test.ts`
- Create: `apps/mycli/test/node-backend.integration.test.ts`
- Create: `apps/mycli/test/fixtures/node-backend-smoke.mjs`
- Modify: `apps/mycli/test/backend-router.test.ts`
- Modify: `apps/mycli/test/cli.test.ts`

- [ ] **Step 1: Write failing router and gateway tests**

Assert `node` selection succeeds, no sidecar starts, transport configuration precedes TUI import,
`turn.submit` returns accepted identity, stream notifications validate against contracts,
`turn.interrupt` aborts the current turn, unsupported methods return stable errors, and shutdown
closes the store/runtime:

```ts
assert.equal(selectRuntimeBackend({ argv: ["--runtime-backend=node"], env: {} }), "node");
await runCli({ ...harness, argv: ["--runtime-backend=node"], startSidecar: failIfCalled,
  startNodeBackend: fakeNodeStarter });
assert.equal(sidecarStarts, 0);
```

- [ ] **Step 2: Run app tests and verify failure**

Run: `npm run test --workspace @mycli/app -- --test-name-pattern="Node backend|node gateway"`

Expected: FAIL because Node remains unavailable in M1.

- [ ] **Step 3: Implement the in-process JSON-RPC transport**

Use paired `PassThrough` streams and line-delimited parsing behind `GatewayTransport`. Validate
incoming envelopes, handle `initialize`, `turn.submit`, `turn.interrupt`, `status.get`, and
`shutdown`, and validate every outgoing notification. Keep protocol output separate from stderr.

- [ ] **Step 4: Implement Node composition and CLI lifecycle**

Parse session/model overrides once, construct config/store/provider/runtime/gateway for `node`,
and preserve the existing sidecar branch unchanged. Both branches expose a small common backend
lifecycle (`transport`, `completion`, `close`, `kill`, `diagnostic`). Update help text to list
`python-sidecar|node`.

- [ ] **Step 5: Run compiled real-process tests**

Run: `npm run test --workspace @mycli/app && npm run build && node apps/mycli/test/fixtures/node-backend-smoke.mjs`

The `.mjs` fixture imports compiled `dist/node-runtime/node-gateway.js`, injects a fake runtime,
drives initialize/submit/shutdown over the paired streams, and exits nonzero on any invalid event
or extra provider invocation. Expected: PASS with no Python process for the Node branch.

- [ ] **Step 6: Commit**

```bash
git add apps/mycli package.json package-lock.json
git commit -m "feat(node-cli): route no-tool turns to Node"
```

### Task 9: Python/Node Request And SQLite Parity Corpus

**Files:**
- Create: `tests/fixtures/node_runtime_m2/request_projection.json`
- Create: `tests/fixtures/node_runtime_m2/session_records.json`
- Create: `tests/fixtures/node_runtime_m2/provider_events.json`
- Create: `tests/integration/test_node_runtime_m2_parity.py`
- Create: `packages/core/test/parity-fixtures.test.ts`
- Create: `packages/storage/test/python-parity.test.ts`

- [ ] **Step 1: Add sanitized golden fixtures and failing readers**

Fixtures contain stable IDs/timestamps and cover Responses, Chat, Unicode, reasoning, empty
optional values, completed turns, and interrupted turns. They contain no credentials, local home
paths, or raw live output.

- [ ] **Step 2: Run focused Python and Node parity tests**

Run: `uv run pytest tests/integration/test_node_runtime_m2_parity.py -q && npm run test --workspace @mycli/core && npm run test --workspace @mycli/storage`

Expected initially: FAIL on any payload-shape or ordering mismatch.

- [ ] **Step 3: Align projections and persistence payloads**

Use structured serializers on both sides. Normalize only unstable IDs/timestamps in tests; do not
normalize roles, item types, stop reasons, order, null/default behavior, or text.

- [ ] **Step 4: Prove four-way SQLite readability**

Create copied temporary databases and exercise Python-write/Python-read, Python-write/Node-read,
Node-write/Python-read, and Node-write/Node-read. Assert logical records rather than SQLite rowids.

- [ ] **Step 5: Run parity gates and commit**

Run: `uv run pytest tests/integration/test_node_runtime_m2_parity.py -q && npm test`

Expected: PASS.

```bash
git add tests/fixtures/node_runtime_m2 tests/integration/test_node_runtime_m2_parity.py packages/core/test packages/storage/test
git commit -m "test(node-runtime): prove M2 Python parity"
```

### Task 10: Cross-Platform, Packaging, Rollout, And Live Smoke

**Files:**
- Create: `scripts/smoke_node_m2.mjs`
- Modify: `.github/workflows/cross-platform.yml`
- Create: `docs/node-runtime-rollout.md`
- Create: `docs/superpowers/reports/2026-08-03-node-runtime-m2-no-tool-turn-smoke.md`

- [ ] **Step 1: Write a bounded live-smoke runner with a dry preflight**

The runner loads existing config/auth without printing secrets, accepts `--protocol responses` or
`--protocol chat_completions`, forces no tools, bounds output tokens/retries/time, writes to a
temporary session database, and prints only one sanitized JSON summary:

```json
{
  "protocol": "responses",
  "status": "completed",
  "event_counts": { "text_delta": 1, "completed": 1 },
  "persisted": true,
  "credential": "configured"
}
```

A missing credential exits with a distinct skip code and no endpoint secret material.

- [ ] **Step 2: Add compiled M2 CI gates**

Keep the current Node 22.19 three-platform matrix. Add a named M2 integration command after
`npm test` and a package smoke that installs the packed npm CLI in a temporary directory. Live
smoke remains secret-gated and is not required on untrusted pull requests.

- [ ] **Step 3: Run the complete offline gate**

Run:

```bash
npm ci
npm run contracts:check
npm run build
npm run lint
npm run typecheck
npm test
uv run ruff check .
uv run mypy src/mycli
uv run pytest -q
```

Expected: every command PASS. Record exact test counts and any known environment-only warning.

- [ ] **Step 4: Run both authorized live API smokes**

Run only after Step 3 passes:

```bash
node scripts/smoke_node_m2.mjs --protocol responses
node scripts/smoke_node_m2.mjs --protocol chat_completions
```

Expected: both return `status=completed`, emit a completed assistant item, and persist a readable
session. Do not repeat a successful real request merely to compare nondeterministic text.

- [ ] **Step 5: Write rollout and evidence docs**

Document explicit selection with `--runtime-backend=node`, supported text-only no-tool scope,
failure/no-fallback behavior, rollback before a later turn, sanitized smoke summaries, full gate
counts, and Node 22.19 platform expectations.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/cross-platform.yml scripts/smoke_node_m2.mjs docs/node-runtime-rollout.md docs/superpowers/reports/2026-08-03-node-runtime-m2-no-tool-turn-smoke.md
git commit -m "docs: record Node no-tool turn rollout"
```

### Task 11: Final M2 Verification

**Files:**
- Verify all files changed since commit `44e4cb4`
- Update: `docs/superpowers/reports/2026-08-03-node-runtime-m2-no-tool-turn-smoke.md` only if final counts differ

- [ ] **Step 1: Check scope and secret hygiene**

Run:

```bash
git diff --check 44e4cb4..HEAD
git diff --stat 44e4cb4..HEAD
rg -n "sk-[A-Za-z0-9]|Authorization:|api[_-]?key[=:][^\[]" packages apps scripts docs tests/fixtures/node_runtime_m2
```

Expected: no whitespace errors, no unrelated refactor, and no committed credential or raw auth
header. Inspect every candidate match rather than assuming it is safe.

- [ ] **Step 2: Re-run deterministic full gates from a clean build**

Run:

```bash
npm run contracts:check
npm run build
npm run lint
npm run typecheck
npm test
uv run ruff check .
uv run mypy src/mycli
uv run pytest -q
```

Expected: PASS from generated/compiled artifacts rebuilt in dependency order.

- [ ] **Step 3: Verify the published CLI path**

Pack and install the npm CLI into a temporary directory, run `mycli --help`, and exercise the
compiled Node backend integration harness. Confirm no Python process starts for the Node path.

- [ ] **Step 4: Confirm M2 exit gate**

Check that both protocol fixture suites, SQLite four-way parity, interruption, duplicate turn,
tool rejection, compiled app, cross-platform CI definition, and two sanitized live smoke results
are present and passing. M2 remains incomplete if either live protocol lacks successful evidence.
