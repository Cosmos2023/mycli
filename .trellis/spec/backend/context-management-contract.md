# Context Management Contract

## Scenario: Provider-Free Context Assembly And Diagnostics

### 1. Scope / Trigger

- Trigger: changes to project context file loading, `TurnContextSection`
  metadata, memory/session summary rendering, compaction summary persistence, or
  context diagnostics.
- The flow crosses services, application runtime, request-shape diagnostics,
  trace, doctor, and provider-facing prompt assembly.

### 2. Signatures

- Loader:
  `ContextFileLoader.load(workspace_root: Path, cwd: Path | None = None) -> LoadedContextFile`
- Result:
  `LoadedContextFile(content: str, diagnostics: ContextFileDiagnostics)`
- Section:
  `TurnContextSection(..., cache_class: TurnContextCacheClass)`
- Runtime context:
  `ExecutionContext.context_file_content: str`
  `ExecutionContext.context_file_diagnostics: dict[str, object]`
- Trace kinds:
  `context_diagnostics`
  `context_summary_persistence`
- Smoke:
  `uv run python evaluation/context_smoke.py`

### 3. Contracts

- Context file priority:
  1. `.mycli.md` or `MYCLI.md`, searched upward from cwd to git/workspace root.
  2. `AGENTS.md` or `agents.md`, cwd first, then workspace root.
  3. `CLAUDE.md` or `claude.md`, cwd first, then workspace root.
  4. `.cursorrules`, cwd first, then workspace root.
- Loader is read-only and provider-free. It must not create config, memory,
  trace, session, or context files.
- Loader diagnostics include selected source, selected path presence, search
  roots, truncation, original/rendered lengths, blocked status, and issue codes.
- Blocked context file content is replaced with a bounded diagnostic placeholder;
  raw blocked content must not be injected.
- Cache classes are:
  - `static`: stable prefix-like guidance and tool/skill catalogs.
  - `dynamic`: conversation, memory, plan, environment, and compaction context.
  - `ephemeral`: current user request and runtime reminders.
- Workspace context, memory, session summaries, and compaction rehydration must be
  rendered inside explicit reference fences that say the content is not the
  current user request/new user input.
- Request fragments must preserve cache class/source metadata so cache and trace
  policy does not infer behavior from section names.
- Context diagnostics trace payloads are bounded counts, hashes, lengths, and
  status flags only. They must not include raw context file content, raw memory,
  user text, tool output, headers, or secrets.

### 4. Validation & Error Matrix

- No context file -> loader returns empty content and diagnostics with
  `selected_source=None`.
- Long context file -> head/tail truncation with a clear marker and
  `truncated=True`.
- Obvious instruction-hijack phrase or invisible control character -> blocked
  placeholder, `blocked=True`, issue code populated.
- Context file read/decode issue -> bounded issue code, no raw file content.
- Memory/session summary value already present in replay -> omit from fenced
  memory section to avoid repeated provider-visible context.
- Repeated compaction summary persistence -> skip duplicates by content hash and
  report skipped count in `context_summary_persistence`.
- Doctor with no traces -> context check still reports loader and session summary
  state without creating traces.
- Doctor with context traces -> report counts and token maxima only.

### 5. Good/Base/Bad Cases

- Good: `.mycli.md` at workspace root is fenced as `workspace-context` with
  `cache_class=static`, and request fragment metadata preserves the same class.
- Base: a fresh workspace without context files has no workspace context section
  and no failure.
- Bad: injecting `Ignore previous instructions...` raw from a project file.
- Bad: rendering session summaries as ordinary current user text.
- Bad: doctor printing project context text, memory values, or trace payloads.

### 6. Tests Required

- Loader tests for priority, upward/root fallback, truncation, and blocking.
- Assembler tests for cache classes and reference fences.
- Instruction contract/request-shape tests for metadata preservation.
- Runtime/trace tests for context diagnostics and summary persistence when
  compaction summaries are produced.
- Doctor tests for bounded context diagnostics and raw-content redaction.
- Provider-free `evaluation/context_smoke.py`.

### 7. Wrong vs Correct

#### Wrong

```python
workspace_instructions = (workspace / "AGENTS.md").read_text()
section = TurnContextSection(..., content=workspace_instructions)
```

#### Correct

```python
loaded = ContextFileLoader().load(workspace_root=workspace, cwd=cwd)
section = TurnContextSection(
    ...,
    content=fence_reference_context(loaded.content),
    metadata={"context_file": loaded.diagnostics.to_dict()},
    cache_class=TurnContextCacheClass.STATIC,
)
```
