# Codex tool concurrency research

The local Codex source separates provider and runtime concurrency. The prompt
sets `parallel_tool_calls` from model capability, while every `ToolExecutor`
defaults `supports_parallel_tool_calls()` to false and may opt in.

Each completed provider tool item is persisted and immediately wrapped in a
Tokio task. A shared `tokio::sync::RwLock<()>` gives opted-in handlers a read
guard and sequential handlers a write guard. Results are drained through
`FuturesOrdered`, so execution may overlap while conversation output remains in
provider order. Cancellation uses a child `CancellationToken`,
`AbortOnDropHandle`, and an atomic terminal-outcome claim.

MCP handlers opt in from a standard read-only annotation or explicit server
configuration. Codex also opts Shell execution into concurrency, which Node
mycli should not copy until approval, process, and mutation conflicts have a
separate contract.

Relevant local sources:

- `/Users/cosmos/Downloads/codex-main/codex-rs/tools/src/tool_executor.rs`
- `/Users/cosmos/Downloads/codex-main/codex-rs/core/src/tools/parallel.rs`
- `/Users/cosmos/Downloads/codex-main/codex-rs/core/src/session/turn.rs`
- `/Users/cosmos/Downloads/codex-main/codex-rs/core/src/stream_events_utils.rs`
- `/Users/cosmos/Downloads/codex-main/codex-rs/core/src/tools/handlers/mcp.rs`
- `/Users/cosmos/Downloads/codex-main/codex-rs/config/src/mcp_types.rs`

Implications for Node mycli:

- Keep the explicit phase scheduler because it provides stronger provider-order
  barrier semantics than task-arrival ordering through an async lock.
- Move capability authority to adapters and fail closed when missing.
- Preserve ordered persistence independently of completion order.
- Use cooperative `AbortSignal` cancellation per call; Shell process teardown
  remains owned by the Shell adapter/session manager.
