# Node Runtime M3 Read Tool Design

## Status

Approved in conversation on 2026-08-04. Written specification awaiting final user review before
implementation planning.

## Goal

Allow the Node backend to complete and persist a provider turn that invokes the built-in `Read`
tool without starting Python. M3 also establishes the provider-neutral tool contracts, manifest,
exposure planner, router, bounded runtime loop, tool transcript persistence, and TUI event
projection that later tool milestones will reuse.

## Scope

M3 includes:

- one Node-native built-in tool: `Read`;
- a read-only tool manifest and provider schema projection;
- deterministic exposure planning and routing;
- strict JSON argument parsing and schema validation;
- workspace-confined filesystem path resolution;
- bounded UTF-8 text and CSV/TSV reads with continuation metadata;
- Responses and Chat Completions tool declaration and continuation;
- a bounded, sequential provider/tool loop;
- canonical assistant tool-call and tool-result persistence in the existing SQLite payload shapes;
- normalized tool lifecycle events consumed by the existing TUI;
- Python/Node parity fixtures and one minimal live API smoke test after offline gates pass.

M3 is accepted only when a `Read`-using turn runs entirely in Node and no Python child process is
started.

## Explicit Retirement Decisions

`LS`, `Glob`, and `Grep` are not part of M3 and will not be implemented in Node.

The Python source already marks `Glob` and `Grep` as retired names whose deleted implementations
are recognized only for compatibility. Although the current Python exposure planner still lists
`LS` as model-visible, the latest product decision retires it as well. The Node migration follows
that product decision rather than carrying the stale Python exposure entry forward.

Historical documents that group `Read`, `LS`, `Glob`, and `Grep` as read-only discovery tools are
not authoritative for M3 scope. Compatibility fixtures must not require Node to advertise or
execute the three retired tools.

## Non-Goals

M3 does not implement:

- directory listing or repository search tools;
- Git, shell, PTY, process, network, MCP, plugin, hook, skill, or subagent tools;
- file creation or mutation;
- approval prompts or mutation sandboxing;
- parallel tool execution;
- local image attachments;
- PDF, Word, Excel, or notebook parsing;
- automatic fallback to Python after a Node turn starts;
- a redesign of the existing TUI;
- promotion of Node to the default backend.

Unsupported tools remain explicit capability failures. An unknown or retired tool name returned by
the provider is never delegated to Python and never interpreted as a shell command.

## Considered Approaches

### Selected: reusable tool foundation with one concrete tool

Create `packages/tools` with provider-independent definitions, manifest, exposure, routing,
validation, output formatting, workspace policy, and the concrete `Read` adapter. Extend the
shared runtime and both provider adapters with a canonical tool loop.

This does slightly more foundation work than embedding `Read` directly in the runtime, but every
boundary is required by later mutation and integration milestones. Restricting the concrete
inventory to one tool keeps M3 independently testable and prevents retired capabilities from
returning accidentally.

### Rejected: port the former read-only tool group

Porting `Read`, `LS`, `Glob`, and `Grep` would match old documentation, but it would resurrect
retired product surface and add filesystem traversal and subprocess/search behavior that is no
longer required. It would also make parity ambiguous because the active Python runtime no longer
registers `Glob` or `Grep` implementations.

### Rejected: execute tools through the Python sidecar

Keeping orchestration in Node while invoking Python tools would reduce initial implementation
work, but it would fail the milestone's Node-only exit gate. It would also split ownership of
cancellation, persistence, output limits, and error normalization across two runtimes.

## Architecture

```text
apps/mycli
  -> packages/runtime
       -> packages/core
       -> packages/providers
       -> packages/storage
       -> packages/tools
  -> packages/contracts

packages/tools
  -> packages/core
  -> Node filesystem APIs
```

`packages/tools` owns tool definitions and local execution. It does not import provider adapters,
SQLite, the CLI, the gateway, or TUI code.

`packages/core` owns provider-neutral tool-call, tool-result, conversation-item, request, and event
types. It contains no filesystem behavior and no third-party validator types.

`packages/providers` owns only wire serialization and stream decoding. It translates canonical
tool definitions, calls, results, and continuation state into Responses or Chat Completions
payloads without deciding which tools are safe or executable.

`packages/runtime` owns loop progression, call ordering, budgets, cancellation, retry eligibility,
event ordering, and persistence ordering. It receives a `ToolRouter` interface and never opens a
file directly.

`packages/storage` persists the canonical transcript and terminal turn state. It does not execute
tools or reconstruct tool results from display text.

## Tool Contracts

The core tool model contains:

```ts
interface ToolDefinition {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
}

interface ToolCall {
	readonly callId: string;
	readonly name: string;
	readonly argumentsJson: string;
}

interface ToolResult {
	readonly callId: string;
	readonly toolName: string;
	readonly success: boolean;
	readonly modelOutput: string;
	readonly summary: string;
	readonly metadata: Readonly<Record<string, unknown>>;
}
```

Provider calls without a non-empty call ID are malformed protocol events. The runtime does not
invent IDs because both provider continuation protocols require stable call/result pairing.

`ToolResult.modelOutput` is the only tool payload sent back to the model. It is bounded before
entering the canonical transcript. `metadata` contains only bounded display and diagnostic fields;
it must not duplicate complete file contents.

## Manifest And Exposure

The built-in manifest contains exactly one M3 entry:

- `id`: `builtin:Read`
- `name`: `Read`
- `source`: `builtin`
- `toolset`: `file`
- `risk_level`: `low`
- `approval_policy`: `auto_allow`
- `capability_tags`: `file`, `read`, `structured_data`, `snapshot`
- `effects`: filesystem read, no filesystem write, no network, no process
- `availability`: available when the workspace root is valid

Building the manifest and planning exposure are pure operations. They must not stat files, open
directories, start processes, access the network, write logs, or mutate registry order.

The M3 exposure planner returns `Read` for a normal Node tool-capable turn. It preserves manifest
order and produces the canonical provider definition. `LS`, `Glob`, and `Grep` are absent rather
than hidden definitions.

The router accepts only names in the planned exposure. It parses `argumentsJson` once, rejects
non-object JSON, validates against the tool input schema, and invokes the registered adapter.
Malformed arguments, unknown names, and unexposed names return bounded failed tool results; they
do not crash the turn and do not cross into Python.

## Read Contract

The provider-visible input schema remains compatible with the active Python tool:

```json
{
  "type": "object",
  "properties": {
    "file_path": {"type": "string", "minLength": 1},
    "offset": {"type": "integer", "minimum": 1},
    "limit": {"type": "integer", "minimum": 0},
    "pages": {"type": "string"}
  },
  "required": ["file_path", "offset", "limit"],
  "additionalProperties": false
}
```

M3 accepts relative paths and absolute paths within the workspace. Resolution uses the real
workspace root and the real target path, so `..` traversal and symbolic-link escape fail before
file contents are read. Directories, missing paths, inaccessible files, invalid UTF-8, and binary
files return classified failures.

Text reads preserve the Python behavior required for continuation:

- offsets are one-based;
- the requested limit is clamped to `0..500`;
- each rendered line is capped at 2,000 characters;
- output reports total lines, shown lines, requested/effective limits, and truncation;
- truncated output identifies the exact next offset;
- snapshot metadata includes size, modification time, and SHA-256;
- repeating the same range against the same snapshot returns a bounded dedup hint;
- model-visible output is capped at 8,000 characters.

CSV and TSV reads preserve model-visible rows, headers, dimensions, truncation, and bounded numeric
summary behavior. M3 uses the `csv-parse` package; ad hoc delimiter splitting is not acceptable
because quoted fields and embedded newlines are valid input. Structured CSV/TSV parsing is limited
to 8 MiB per file and returns `file_too_large` above that boundary. Text-mode streaming remains
available for ordinary non-CSV text files.

`pages` remains in the schema for compatibility and is ignored for supported text, CSV, and TSV
files, matching the Python Read behavior. `.xlsx`, `.xls`, `.pdf`, `.docx`, and `.ipynb` return a
bounded unsupported-type result rather than being decoded as text because paged-document handling
is out of scope for M3.

## Provider Boundary And Continuation

`ProviderRequest` becomes tool-capable and carries canonical conversation items plus an ordered
list of `ToolDefinition`. The provider interface remains one streaming operation; continuation is
represented in the request rather than by adding provider-specific methods to `ModelProvider`.

For Responses:

- initial requests send the ordered `tools` array;
- a completed response that contains calls exposes its response ID and ordered calls;
- HTTP/SSE continuation replays the canonical user, function-call, and function-output items;
- `previous_response_id` is not sent because compatible endpoints may reserve it for another
  transport, such as Responses WebSocket v2;
- each output uses the original provider `call_id` and bounded `modelOutput`;
- tool definitions remain stable across every request in the turn.

For Chat Completions:

- initial requests send OpenAI function tools in manifest order;
- the adapter retains the complete assistant tool-call message;
- continuation appends that assistant message followed by one `tool` message per result;
- tool message ordering matches tool-call ordering;
- the full canonical transcript is projected on each request.

Provider adapters continue to aggregate fragmented Chat tool calls and reject malformed streams.
Text emitted in a tool-call step is retained in the assistant item but is not treated as the final
assistant answer.

## Runtime Loop

The M2 no-tool runtime evolves into a general Node turn runtime. The turn still reserves its
`client_turn_id` and persists the user message before provider IO.

```text
reserve turn
  -> plan Read exposure
  -> stream provider step
  -> no tool calls: persist final assistant answer and complete
  -> tool calls: persist assistant tool-call item
  -> execute calls sequentially in provider order
  -> persist each bounded tool result
  -> continue the same provider turn
  -> repeat until final answer or budget/error/interruption
```

M3 executes calls sequentially even if a future manifest marks a tool parallel-safe. This gives
deterministic event and persistence order. Parallel scheduling is a later, separately approved
optimization.

The loop permits at most 8 provider steps and 16 tool calls per user turn. The limits are internal
constants in M3, covered by tests, and may become compatible configuration fields later. Exceeding
either limit terminates with `tool_budget_exceeded` and never sends another provider request.

Transport retry remains allowed only before the first valid event of the current provider step.
Once that step emits text, reasoning, a tool call, usage, or completion, the runtime does not replay
it. A later provider continuation is a new step with its own pre-event retry budget.

Interruption is checked before and after every provider event, persistence boundary, argument
validation, filesystem operation, and retry sleep. Abort after a tool result is persisted leaves a
complete call/result pair and marks the turn interrupted; restart recovery never resumes or
reissues the provider continuation automatically.

## Persistence

M3 uses the existing JSON payload columns and does not introduce a breaking SQLite schema.

An assistant tool-call item stores:

- role `assistant`;
- any bounded assistant text emitted in that step;
- ordered `tool_calls` with `name`, parsed arguments, and `call_id`;
- matching `tool_call` blocks for Python readers;
- provider response identity in existing metadata fields.

Each tool result stores:

- role `tool`;
- `tool_call_id` equal to the originating call ID;
- bounded `modelOutput` as content;
- a matching `tool_result` block;
- tool name, success, summary, and safe display metadata.

The Node conversation loader must read Python-written assistant tool calls and tool messages, and
the Python loader must read Node-written equivalents. Tool call and result records are committed
in short transactions before the next provider request. A provider continuation never references
a result that is not durable.

If the process exits after persisting an assistant tool call but before persisting every result,
startup recovery appends one bounded synthetic failed tool result for each unmatched call ID. The
result states that execution was interrupted and is never submitted automatically to a provider.
This keeps the canonical transcript structurally valid for Python and Node session readers without
repeating filesystem work.

Duplicate `client_turn_id` submissions retain M2 semantics and never repeat provider or filesystem
work. Completed, failed, and interrupted tool turns return their existing durable status.

## Runtime And TUI Events

The runtime adds provider-neutral events for:

- tool call accepted;
- tool execution started;
- tool execution completed;
- tool execution failed.

`apps/mycli` projects these through the existing `turn.event` gateway surface using current TUI
semantics: `tool_start`, `tool_complete`, and `tool_failed`. Events include bounded `tool_name`,
`call_id`, success, duration, path display, range, truncation, and error kind where applicable.
They never include complete arguments JSON or raw file content.

The TUI continues using its current lifecycle rendering and does not branch on Python versus Node.
M3 changes no layout, interaction, keyboard shortcut, or visual hierarchy.

## Error Handling

M3 adds stable runtime failures where the whole turn cannot continue:

- `tool_budget_exceeded`
- `tool_protocol_error`

Expected tool-level failures such as missing files, invalid paths, invalid argument types,
workspace escape, binary content, invalid UTF-8, and unsupported file types are returned to the
model as failed `ToolResult` values. This lets the model correct a path or request without losing
the turn.

Persistence failure, provider protocol corruption, missing call IDs, interruption, and exhausted
loop budgets are terminal. Public messages remain bounded. Diagnostics may include tool name,
call-ID presence, error kind, and counts, but never API credentials, complete argument payloads,
or file contents.

## Testing

Offline acceptance requires:

1. manifest shape, order, effects, and read-only construction tests;
2. exposure tests proving only `Read` is advertised;
3. router tests for valid, malformed, unknown, unexposed, and retired tool calls;
4. path-policy tests for relative paths, allowed absolute paths, `..`, symlink escape, directory,
   missing file, and permission failures;
5. text tests for UTF-8, empty files, offsets, zero and clamped limits, long lines, large files,
   truncation, next offset, snapshots, dedup, binary detection, and output budgets;
6. CSV/TSV tests for quoted delimiters, embedded newlines, headers, numeric summaries, truncation,
   invalid encoding, and the 8 MiB structured-file boundary;
7. Responses adapter fixtures for tool declaration, call decoding, and response-ID continuation;
8. Chat adapter fixtures for fragmented calls, assistant call messages, ordered tool messages, and
   continuation;
9. runtime tests for one call, repeated calls, multiple calls, sequential ordering, tool failure
   recovery, final text, interruption, retry boundaries, and both budgets;
10. SQLite Python-to-Node and Node-to-Python tool transcript fixtures;
11. gateway/TUI event parity fixtures for `tool_start`, `tool_complete`, and `tool_failed`;
12. an end-to-end Node turn proving no Python process is created;
13. all existing Node and Python suites, lint, typecheck, build, contract drift, and npm pack smoke.

After all offline gates pass, one real API request may run in a disposable workspace containing a
small non-secret text fixture. The prompt requests a bounded `Read` followed by a short answer.
The test has one turn, no automatic retry beyond the normal bounded policy, a short timeout, and a
small output-token cap. The recorded result contains only provider/protocol/model identifiers,
event counts, terminal status, `persisted=true|false`, and `python_started=false`; it contains no
credential, raw request, file content, or model response text.

## Exit Gate

M3 is complete when all of the following are true:

- the Node backend advertises only the approved `Read` tool for this milestone;
- both provider protocols can request `Read`, receive its result, continue, and finish;
- tool calls and results survive session reload and remain Python-readable;
- the TUI receives compatible bounded tool lifecycle events;
- retired tools are neither advertised nor implemented in Node;
- workspace escape and unbounded output tests pass;
- the full offline quality gate passes;
- the sanitized live smoke succeeds when a usable configured endpoint is available;
- the complete M3 turn starts no Python process;
- a failed Node turn never falls back to Python.

Python remains the default backend after M3. Promotion or expansion to mutation tools requires a
separate approved milestone.
