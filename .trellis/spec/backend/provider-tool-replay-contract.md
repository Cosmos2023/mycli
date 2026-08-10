# Provider Tool Replay Contract

## Scenario: Bounded Tool Results And Closed Provider Replay

### 1. Scope / Trigger

- Trigger: changing tool adapters, `ToolRouter`, tool-result persistence, terminal turn handling,
  conversation replay, restart recovery, or provider error classification.
- This contract spans tools, runtime, SQLite storage, and provider request projection. A tool call is
  not replay-safe until it has exactly one corresponding result or is still owned by an active turn.

### 2. Signatures

- Shared limit: `TOOL_RESULT_OUTPUT_MAX_CHARS = 8_000` from `@mycli/core`.
- Shell default model-output limit: `DEFAULT_SHELL_MODEL_OUTPUT_MAX_CHARS = 2_000` and
  `DEFAULT_SHELL_MODEL_OUTPUT_MAX_TOKENS = 500` from `@mycli/tools`.
- Execution boundary: `ToolRouter.execute(call, options) -> Promise<ToolExecutionResult>`.
- Persistence boundary: `SQLiteSessionStore.appendToolResult(input) -> void`.
- Terminal failure: `SQLiteSessionStore.failTurn(input) -> RuntimeTurnRecord`.
- Replay boundary: `SQLiteSessionStore.loadConversationItems(sessionId) -> CanonicalConversationItem[]`.
- Provider classification: `classifyProviderError(error) -> ProviderFailure`.

### 3. Contracts

- `ToolRouter` applies the shared limit to every adapter result before runtime or storage consumes
  it. Truncation preserves the first 8,000 characters and adds `model_output_truncated=true` plus
  `model_output_omitted_chars=<count>` to result metadata.
- Individual tools may use tighter domain-specific limits, but they must not define a larger
  persistence contract. `SQLiteSessionStore.appendToolResult` rejects output above the shared limit
  as defense in depth.
- `Shell`, `Bash`, `WriteStdin`, `ShellOutput`, and `BashOutput` use the shared Shell default of
  2,000 model-visible characters per call. A requested `max_output_tokens` may lower that budget but
  cannot raise it above the tool instance's configured maximum. Multiple incremental results remain
  separate replay items until compaction; there is no process-wide cumulative output budget.
- Calls and results are persisted in provider order. Each persisted call id has at most one result,
  and a result must match the pending call id and tool name.
- The compatibility `ProviderRequest.messages` view must equal the text-only projection of
  `ProviderRequest.items`. In particular, non-empty assistant text emitted alongside tool calls is
  represented once as an assistant message in both views.
- Tool-generated context is durable before it enters another provider request, but provider
  projection must not place context inside an open tool-call batch. An uninterrupted runtime batch
  appends all ordered tool results before its generated context. If suspension or legacy history
  leaves durable context between sibling results, projection moves only that context after every
  matching result without rewriting the append-only canonical timeline; model-input manifest
  references follow the same projected order.
- `failTurn` appends a deterministic failed result for every pending call before marking the turn
  failed or interrupted. The closure records and terminal transition occur in the same write
  transaction.
- Replay repairs legacy dangling calls only when their call ids are not owned by an `in_progress`
  turn. The repair is a deterministic projection; it does not execute the tool or mutate historical
  rows. Active calls remain unmatched until their real execution, failure, or recovery path closes
  them.
- Restart recovery closes pending calls only for turns whose owner is absent or known dead. It must
  not interrupt a turn owned by another live process or a valid suspended continuation.
- Provider failures persist only bounded structured diagnostics: integer `status`, `request_id`
  truncated to 128 characters, and provider error `code` / `type` tokens matching
  `[A-Za-z0-9_.:-]{1,128}`. Raw upstream messages, response bodies, headers, prompts, tool output,
  and secrets are never copied into diagnostics or terminal turn results.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Adapter output exceeds 8,000 characters | Truncate in `ToolRouter` and record omitted count |
| Default Shell or WriteStdin model output exceeds 2,000 characters | Preserve bounded head/tail output and truncation metadata within 2,000 characters |
| Oversized result reaches storage directly | Reject with bounded `persistence_error` |
| Result call id or tool name differs from next pending call | Reject without changing call order |
| Assistant tool calls include non-empty text | Preserve the text once in both `messages` and `items` |
| Durable context appears between sibling tool results | Project all matching results first, then the context |
| Turn fails with pending calls | Append one failed result per call, then terminalize atomically |
| Terminal legacy history contains a dangling call | Synthesize one replay-only unavailable result |
| Active turn contains a dangling call | Do not synthesize a result |
| Restart finds an orphaned in-progress turn | Append interruption results and mark interrupted |
| Restart finds a live-owned or suspended turn | Leave it active |
| Provider error contains a raw message/body/header | Discard raw fields; retain only allowlisted diagnostics |

### 5. Good/Base/Bad Cases

- Good: a tool emits 9,000 characters; the router persists 8,000 characters with an omitted count,
  and the next Responses request contains one call followed by one result.
- Good: Shell emits 50,000 characters; its adapter retains a 2,000-character head/tail result before
  the router and storage boundaries.
- Base: a completed tool output under the limit is persisted unchanged and replayed once.
- Good: a legacy failed turn has a call but no result; replay supplies a deterministic unavailable
  result without editing the database.
- Bad: each tool defines an unrelated output limit and storage accepts whichever result arrives.
- Bad: mark a turn failed first and leave its pending `function_call` without a
  `function_call_output`.
- Bad: synthesize a result while the tool is still running, or persist a provider's raw error
  message because it appears useful for debugging.

### 6. Tests Required

- Tool-router unit test asserts exact 8,000-character output, truncation flag, and omitted count.
- Shell and WriteStdin unit tests assert their default 2,000-character result cannot be raised by a
  larger model-requested `max_output_tokens` value.
- Storage test rejects a directly supplied oversized result.
- Storage test asserts `failTurn` closes every pending call before later replay.
- Replay regression asserts terminal legacy calls receive exactly one synthetic result while active
  calls remain unchanged.
- Restart test distinguishes a dead owner from a second live owner and a suspended continuation.
- Provider error tests assert status/request id/error code/error type survive while upstream message,
  response body, headers, and secret-like content do not.
- Responses projection test asserts every replayed `function_call` has exactly one matching
  `function_call_output` before the request is sent.
- Request projection test asserts non-empty assistant tool-call text produces the same assistant
  message expected by model-input validation.
- SQLite runtime regression covers a Chat/DeepSeek batch containing one Skill activation and
  multiple sibling tools, asserts contiguous ordered results followed by skill context, and
  reconstructs provider step 2 exactly without a persistence failure.

### 7. Wrong vs Correct

#### Wrong

```typescript
const result = await adapter.execute(argumentsValue, options);
store.appendToolResult(result);
store.failTurn(failure); // A failed append can leave the call dangling.
```

#### Correct

```typescript
const result = await router.execute(call, options); // Shared bound is applied here.
store.appendToolResult(result);                    // Storage enforces the same upper bound.
// On failure, failTurn closes every remaining call before the terminal transition.
store.failTurn(failure);
```

## Scenario: DeepSeek Thinking Tool Continuation

### 1. Scope / Trigger

- Trigger: changing the DeepSeek Chat adapter, official OpenAI JS client boundary, thinking config,
  streamed reasoning collection, provider replay state, or assistant tool-call projection.

### 2. Contracts

- Bootstrap developer instructions are merged into the leading system prefix; the wire request does
  not use the unsupported `developer` role. A later developer-authority timeline context is mapped
  to a fenced `user` message at its chronological position and must not be moved back into that
  prefix or projected as another DeepSeek `system` message.
- The OpenAI JS SDK sends unknown request fields literally. DeepSeek `thinking` must therefore be a
  top-level request body field. Do not send Python SDK-style `extra_body.thinking`; the JS SDK does
  not expand it.
- Thinking-enabled requests send top-level `thinking.type=enabled` and bounded
  `reasoning_effort=high|max`; disabled requests send top-level `thinking.type=disabled`.
- Streamed `reasoning_content` is collected as provider state whenever a response contains tool
  calls. The matching assistant tool-call message restores that exact bounded content on the next
  canonical Chat request.
- If DeepSeek emits tool calls without reasoning content, use the fixed synthetic replay marker.
  Never expose provider reasoning state as assistant text or invent arbitrary reasoning.

### 3. Tests Required

- Adapter tests cover bootstrap role downgrade, chronological dynamic developer context,
  enabled/disabled thinking, streamed reasoning collection, synthetic fallback, and canonical tool
  continuation.
- A wire-level test must use the official OpenAI JS SDK against a local HTTP server and assert that
  `thinking` is top-level and `extra_body` is absent.
