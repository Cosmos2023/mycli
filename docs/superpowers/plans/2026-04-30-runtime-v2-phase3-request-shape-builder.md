# Runtime V2 Phase 3 RequestShapeBuilder Implementation Plan

## Goal

Introduce a provider-neutral `RequestShapeBuilder` that turns the current `InstructionContract` plus model-visible tools into a cache-first request shape. Phase 3 records that shape in runtime trace diagnostics without replacing provider payload formatting yet.

## Scope

- Build request shapes in the target cache-first order:
  - stable system
  - stable tool schema reference
  - provider replay transcript
  - current user intent
  - volatile runtime context
- Compute deterministic tool schema and tool order hashes from `ModelToolDefinition`.
- Keep existing model adapter payload behavior unchanged.
- Emit a `request_shape` trace event for each model request.
- Do not change memory retrieval, provider formatter payloads, or dynamic tool lifecycle semantics in this phase.

## Tasks

1. Add failing unit tests for `RequestShapeBuilder`.
2. Implement `src/mycli/services/request_shape_builder.py`.
3. Add runtime trace test proving `request_shape` is emitted and contains stable hashes.
4. Wire `AgentRuntime`/`TurnExecutor` to build and trace request shapes before model requests.
5. Update Runtime v2 design documentation with Phase 3 status.
6. Run focused tests, targeted ruff, mypy, and full pytest.

## Acceptance Criteria

- Same stable instructions and same tools produce identical `system_hash`, `tool_schema_hash`, and `tool_order_hash` even when current user intent or volatile runtime context changes.
- Tool schema hash changes when parameter schema changes.
- `request_shape.provider_messages` is ordered so volatile context appears after the current user intent.
- Runtime trace contains a `request_shape` event for real turn execution.
