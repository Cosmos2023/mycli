# Tool Trace Argument Summary Diagnostics

## Goal

Improve tool execution diagnostics by adding safe argument-shape summaries to
trace rows and doctor output, without exposing raw argument values.

## Requirements

- `tool_execution` trace payloads must include:
  - `argument_count`: number of tool argument keys
  - `argument_keys`: sorted argument key names
- Existing sanitized `arguments` payload must remain for compatibility.
- Doctor `tool_execution_diagnostics` must include an
  `argument_summaries=<count>` field counting trace rows with a valid argument
  summary.
- Doctor must not print raw arguments or argument key names.
- Trace redaction behavior must remain intact for nested secret payloads.
- Do not productize MCP, skills, subagent/multi-agent, or ACP.
- Do not merge into `main`.

## Non-Goals

- Do not remove `arguments` from trace payloads in this slice.
- Do not add runtime schema validation.
- Do not change tool execution behavior.

## Acceptance Criteria

- Tool execution service tests prove trace rows include `argument_count` and
  sorted `argument_keys`.
- Doctor tests prove `argument_summaries` is counted without printing raw
  arguments or key names.
- Relevant ruff, mypy, focused pytest, and Python full tests pass.
- Trellis task is archived and committed on the feature branch.
