# Current State

## Existing Behavior

- `ToolExecutionService` appends local `tool_execution` trace rows for tool
  success, failure, hook denial, interruption, long stdout/stderr, and write
  diagnostics.
- Tool lifecycle stream events already expose bounded summary/error previews
  and truncation metadata for TUI clients.
- Doctor currently summarizes stream, approval, and clarification diagnostics,
  but it does not summarize `tool_execution` trace rows.

## Gap

Hermes-like local agent foundations need post-mortem tool visibility. A user can
inspect raw trace JSONL, but `mycli doctor` cannot currently answer high-level
questions such as:

- how many tools ran recently;
- how many failed;
- whether failures were denials, interruptions, or generic tool errors;
- whether long stdout/stderr output was truncated;
- whether write diagnostics reported local errors.

## Chosen Slice

Add a read-only doctor `tool_execution_diagnostics` check that summarizes
bounded `tool_execution` trace rows. This improves Tool / approval / safety and
Diagnostics / logs / trace / doctor parity without changing runtime behavior,
gateway events, provider transcripts, MCP, skills, subagents, or ACP.
