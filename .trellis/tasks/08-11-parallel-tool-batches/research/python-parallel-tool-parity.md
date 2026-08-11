# Python parallel-tool parity research

Python mycli uses `ToolCallRuntime` to partition provider-order calls into
consecutive safe phases. A call is safe only when the router resolves its tool
spec with `supports_parallel_tool_calls=True`. Safe phases run through a
`ThreadPoolExecutor`; non-safe calls flush the pending safe phase and execute as
single-call barriers. Outcomes are applied in submission order.

The assistant block consumer adds calls to the safe phase only after exposure,
runtime policy, and automatic-approval checks. Clarification and approval flows
flush pending safe calls before suspending. On interruption, every unfinished
call receives an interrupted outcome and completed outcomes cannot be applied
twice.

Node should preserve these observable semantics while using Promise concurrency
instead of Python threads. The built-in Node manifest already has the necessary
opt-in metadata, but `ToolRouter` and `NodeTurnRuntime` do not consume it.

Relevant sources:

- `src/mycli/application/runtime/tools/tool_call_runtime.py:31-156`
- `src/mycli/application/runtime/tools/tool_execution_service.py:143-214`
- `src/mycli/application/runtime/model/assistant_block_consumer.py:169-207`
- `src/mycli/tools/routing/tool_router.py:147-163`
- `tests/unit/application/test_tool_execution_service.py:3506-3645`
