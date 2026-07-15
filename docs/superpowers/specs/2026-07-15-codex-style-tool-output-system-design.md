# Codex-Style Tool Output System Design

## Goal

Establish a typed tool-output system for mycli that separates model-facing output,
TUI presentation, persistence metadata, and telemetry. The migration must preserve
existing sessions and the current Shell, sub-agent, and TUI behavior while removing
the information loss and duplication caused by the name-based `ToolResultFormatter`.

## Scope

This design covers:

- a typed model-output contract carried by `ToolResult`;
- one provider-neutral conversion into tool-result wire items;
- shared token- or character-budget truncation with explicit omission metadata;
- compatibility fallback for tools that still return only `summary/raw_payload`;
- dedicated adapters for built-in, MCP, plugin, and sub-agent outputs;
- removal of duplicate Skill instruction bodies;
- tests that verify the exact content sent to every provider lane.

This design does not replace the TUI `ToolDisplayEnvelope`, redesign tool schemas,
or alter tool scheduling and approval behavior.

## Design Principles

1. **One runtime contract, multiple projections.** A tool result is projected
   independently for the model, TUI, persistence, hooks, and telemetry.
2. **Tools own output semantics.** Read, Shell, Web, diagnostics, sub-agents, and
   MCP keep purpose-built output renderers instead of sharing a file-oriented
   fallback.
3. **Provider adapters do not infer tool meaning.** They serialize an already
   normalized model output and never inspect `raw_payload` by tool name.
4. **Compatibility is explicit.** Legacy results use a bounded fallback during
   migration; old sessions continue to replay through their stored text.
5. **All untrusted output crosses one guard.** Skill instructions are trusted
   instruction content; every other textual tool result is guarded once.

## Runtime Types

Add a provider-neutral model-output contract under
`src/mycli/domain/tooling/output.py`:

```python
ToolOutputContent = ToolTextContent | ToolImageContent | ToolJsonContent

@dataclass(frozen=True, slots=True)
class ToolModelOutput:
    content: tuple[ToolOutputContent, ...]
    success: bool | None = None
    contains_external_context: bool = False
    truncation: ToolOutputTruncation | None = None
```

`ToolTextContent` preserves whitespace and code blocks. `ToolImageContent` carries
an image URL and optional detail. `ToolJsonContent` carries structured JSON until
the provider capability layer decides whether to emit structured content or stable
JSON text. `ToolOutputTruncation` records original size, retained size, omitted
size, and whether a head-tail policy was applied.

`ToolResult` gains an optional `model_output` field. Existing `summary`,
`raw_payload`, `evidence`, and `artifacts` remain during migration.

## Projection Pipeline

The execution path becomes:

```text
tool handler
  -> ToolResult(model_output=...)
  -> ToolModelOutputProjector
       -> use typed model_output
       -> otherwise invoke bounded legacy fallback
  -> ToolOutputBudgeter
  -> InjectionGuard for untrusted text
  -> provider-neutral RuntimeBlock(tool_result)
  -> Chat / Responses / Anthropic serialization
```

`ToolExecutionService` no longer asks `ContextManager` to interpret a tool name.
It asks `ToolModelOutputProjector` for normalized content. Provider adapters only
convert normalized text/content items into their wire protocol.

TUI projection remains:

```text
ToolResult + ToolCall -> ToolDisplayProjector -> ToolDisplayEnvelope
```

The TUI must not render the model-context string, and the model must not consume
the TUI envelope.

## Output Budgeting

Create a shared budgeter with these rules:

- preserve complete output when within budget;
- truncate text using head-tail retention, never head-only retention;
- preserve line boundaries where possible;
- emit a stable marker containing original and omitted character counts;
- budget all text content collectively while retaining non-text content;
- allow per-tool budget classes (`read`, `shell`, `default`, `instruction`) without
  embedding tool-name switches in provider serialization;
- apply the same budgeter when adding fresh results and when normalizing history.

Initial compatibility budgets remain close to current behavior: Read 8,000
characters, ranged Read 6,000, Shell 2,000, default 1,600. Shell increases from
500 because head-tail retention and explicit output cursors make the extra context
useful; final limits can be tuned from request diagnostics.

## Tool Migration

### First migration group

- **Skill:** the tool-result output becomes a compact activation acknowledgement;
  the body appears exactly once in the persistent `<skill_instructions>` message.
- **WebSearch:** emit query, result count, title, and URL as structured text/JSON.
- **WebFetch:** preserve Markdown and code formatting; use web-specific truncation
  guidance instead of Read instructions.
- **Lint:** emit bounded file/line/column/rule/message diagnostics.
- **Task/SubagentOutput:** preserve report formatting and expose status, child id,
  and report without file-read notices.
- **MCP:** preserve text and image content items and retain structured content.
- **Plugin:** accept `ToolModelOutput`; adapt dictionaries and strings through a
  deterministic fallback.

### Existing structured group

Read, Shell, ShellOutput, mutations, LS, Glob/Grep compatibility, and Git tools
are migrated after the first group. Their current useful text contracts become
tool-owned presenter functions and use the shared budgeter.

### Control group

Plan, AskUserQuestion, KillShell, SendMessage, and plan-mode compatibility tools
return compact acknowledgements with explicit success. They do not include their
input payload again unless the model needs a generated identifier or state value.

## Failure Handling

- Validation and execution errors produce `success=False` model outputs.
- Fatal runtime/provider errors remain exceptions and are not disguised as normal
  tool failures.
- A malformed typed output falls back to a compact failure message and records a
  diagnostic; it must not leak an unbounded `repr`.
- Legacy fallback emits summary, error, path, and bounded evidence/content. It is
  deterministic and contains no tool-specific Chinese completion prompts.
- A tool call and its output remain paired by `call_id` in every provider lane.

## Persistence And Compatibility

New session snapshots continue storing TUI-visible history and the already
projected transcript content. They do not persist duplicate typed content plus
rendered content. Old snapshots without typed output replay unchanged.

`raw_payload` remains available to TUI projection, hooks, diagnostics, and trace
redaction. It is not treated as an implicit model-visible fallback after a tool has
provided `model_output`.

## Testing

Tests cover:

- construction and validation of every content-item type;
- head-tail truncation, Unicode boundaries, multiline code, and mixed media;
- exact model-visible output for every built-in tool family;
- Skill body appearing once;
- WebSearch, Lint, and SubagentOutput details reaching the model;
- MCP text/image/structured content preservation;
- Chat, Responses, Anthropic, DeepSeek, and Qwen wire serialization;
- legacy `ToolResult` and old-session replay compatibility;
- independence of TUI display and model output;
- compaction and history normalization using the same budget policy.

Each migration is test-first. The old formatter remains only as a temporary legacy
adapter until all registered tool families have explicit typed output coverage.

## Completion Criteria

The migration is complete when:

1. every registered built-in and contributed tool has an explicit output adapter;
2. provider serializers contain no tool-name-specific formatting;
3. `ToolResultFormatter` is deleted or reduced to an old-session-only adapter;
4. all tool outputs are bounded with visible truncation metadata;
5. TUI rendering remains based on lifecycle/display data;
6. the full Python and Node TUI test suites, Ruff, mypy, and TypeScript typecheck pass.
