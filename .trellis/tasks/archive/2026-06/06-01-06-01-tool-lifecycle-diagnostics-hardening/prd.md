# Tool Lifecycle Diagnostics Hardening

## Problem

The built-in tool surface now has stronger read/search/mutation/shell/git
capabilities, but runtime orchestration still needs a final pass so new tools
participate in the same lifecycle, trace, file-history, and diagnostics
contracts as the older tools.

## Scope

- tool concurrency classification
- mutation tool file-history classification
- lifecycle event metadata
- trace diagnostic payloads
- unit coverage for the above

## Non-goals

- No new external tool ecosystems.
- No MCP, ACP, skills, subagents, browser, or computer-use productization.
- No destructive git operations.

## Requirements

1. Read-only git tools are concurrency-safe like other read-only local tools.
2. `Patch` participates in mutation snapshot/file-history fallback paths.
3. Lifecycle finish events expose stable `error_kind` when tools fail.
4. Tool execution traces include bounded argument/result/error previews and
   stable `tool_id`.
5. Trace payloads remain bounded and do not require consumers to parse raw tool
   output for summaries.
6. Existing doctor tool-execution diagnostics continue to summarize failures.

## Acceptance

- Unit tests cover git tools in parallel-safe classification.
- Unit tests cover Patch fallback mutation paths.
- Unit tests cover lifecycle failure `error_kind`.
- Unit tests cover trace argument/result/error preview fields.
- `ruff`, `mypy`, and Python unit/integration tests pass.
