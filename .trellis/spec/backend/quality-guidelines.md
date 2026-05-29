# Quality Guidelines

> Code quality standards for backend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

<!-- Patterns that should never be used and why -->

(To be filled by the team)

---

## Required Patterns

<!-- Patterns that must always be used -->

(To be filled by the team)

---

## Testing Requirements

### Scenario: Read-only Doctor Diagnostics

#### 1. Scope / Trigger
- Trigger: Any change to `mycli doctor`, local runtime diagnostics, or health
  checks for config, storage, logs, FileHistory, TUI, or MCP setup.
- The command crosses CLI, services, config, storage layout, and integration
  boundaries, but must stay outside model/runtime execution.

#### 2. Signatures
- CLI command: `mycli doctor`
- Service API:
  `DoctorService(workspace_root: Path, home_dir: Path, env: Mapping[str, str], ...).run() -> DoctorReport`
- Rendering API: `render_doctor_report(report: DoctorReport) -> tuple[str, ...]`
- Result fields: `DoctorCheck.name`, `DoctorCheck.status`,
  `DoctorCheck.message`, optional `DoctorCheck.detail`; status values are
  `ok`, `warning`, and `failed`.

#### 3. Contracts
- Doctor is read-only. It must not create config files, sessions DBs, log
  files, file-history indexes, or MCP server processes.
- Default doctor must not perform a real provider/model request.
- Output is human-readable text headed by `mycli doctor` and ending with a
  summary count.
- API keys, bearer tokens, and secret-like values must never be printed; report
  presence only, for example `api_key: present`.
- Warnings return exit code `0`; one or more failed checks return exit code `1`.

#### 4. Validation & Error Matrix
- Config resolves -> report provider, protocol, model, and base URL.
- Config parse/validation fails -> `config=failed`; keep checking other areas.
- API key missing -> `api_key=warning`.
- `~/.mycli/sessions.db` missing -> `sessions_db=warning`.
- Sessions DB exists but is not openable or lacks required tables -> failed.
- Logs or FileHistory missing -> warning, not failure.
- FileHistory `index.json` exists but cannot parse -> failed.
- MCP config load fails -> failed; do not start servers.
- Node/npm or Python TUI unavailable -> warning unless a stricter command is
  explicitly introduced later.

#### 5. Good/Base/Bad Cases
- Good: `uv run mycli doctor` reports local health, redacts API keys, and exits
  `0` with only warnings.
- Base: A fresh machine with no prior sessions gets missing-storage warnings but
  no model request.
- Bad: Calling `build_turn_service()` for doctor, because that can require an
  API key and initialize runtime dependencies unrelated to diagnostics.
- Bad: Printing `sk-...` or MCP environment secret values in remediation text.

#### 6. Tests Required
- Unit test service success with config/storage/logs/history/MCP fixtures.
- Unit test warning-only conditions such as missing sessions DB and history.
- Unit test failed MCP or storage parse/open behavior.
- CLI test for `mycli doctor` command parsing and no secret leakage.
- Full lint, type-check, and pytest must pass because doctor touches CLI
  startup paths.

#### 7. Wrong vs Correct

Wrong:
```python
service = build_turn_service(args, cwd=cwd, home=home, env=env)
service.handle_user_turn("diagnose my setup")
```

Correct:
```python
report = DoctorService(workspace_root=cwd, home_dir=home, env=env).run()
for line in render_doctor_report(report):
    output_func(line)
```

### Scenario: Cache-aware Runtime Diagnostics

#### 1. Scope / Trigger
- Trigger: Any runtime safety, diagnostics, observability, checkpoint, rollback, or tool-effect feature that records metadata around tool execution.
- These features are cross-layer because data can move through tool execution, turn item metadata, trace payloads, provider transcript messages, and request-shape hashing.

#### 2. Signatures
- `ToolExecutionService(..., write_diagnostics_runner: Callable[[tuple[str, ...]], dict[str, object]] | None = None)`
- `WriteDiagnosticsService(workspace_root: Path).run(paths: tuple[str, ...]) -> dict[str, object]`
- Trace event kind remains `tool_execution`.

#### 3. Contracts
- Allowed cache-volatile/local fields:
  - turn item metadata such as `write_diagnostics`
  - trace payload fields such as `write_diagnostics_count` and `write_diagnostics_error`
  - post-execution tool result `raw_payload` fields
- Forbidden stable-surface changes unless the actual user-visible contract changes:
  - stable system prompt text
  - model-visible `ToolSpec`
  - deterministic tool ordering
  - previous provider transcript messages
- Diagnostic failures are best-effort: they may record an error string but must not convert a successful write into a failed write.

#### 4. Validation & Error Matrix
- Successful structured file write -> run bounded diagnostics for changed paths.
- Failed validation or failed tool execution -> do not run diagnostics.
- No-op write -> do not run diagnostics.
- Diagnostic runner exception -> record diagnostic error; preserve original tool success.
- Missing diagnostic runner -> preserve existing behavior.
- Checkpoint/guardrail exit -> append a local `guardrail` trace event with bounded trigger diagnostics.

#### 5. Good/Base/Bad Cases
- Good: `Write` succeeds, `write_diagnostics` appears in turn metadata and trace count is available.
- Base: No diagnostic runner is configured and tool execution output is unchanged.
- Bad: A diagnostic warning is inserted into stable system instructions or model-visible tool schema.

#### 6. Tests Required
- Unit test successful write diagnostics metadata and trace payload.
- Unit test failed validation and no-op write skip diagnostics.
- Unit test diagnostic exceptions do not fail the write.
- Unit test guardrail trace payloads for checkpoint exits.
- Request-shape regression proving diagnostic metadata does not change stable system hash, tool schema hash, tool order hash, or replay hash when transcript content is unchanged.

#### 7. Wrong vs Correct

Wrong:
```python
contract.base_instructions += f"\nLatest diagnostics: {diagnostics}"
```

Correct:
```python
raw_payload = {**result.raw_payload, "write_diagnostics": diagnostics}
```

Keep runtime diagnostics appended after execution and outside stable request-shape inputs.

---

### Scenario: Cache-aware Session Storage Layout

#### 1. Scope / Trigger
- Trigger: Any runtime persistence, trace, log, artifact, or session lifecycle feature that writes under the user-level `.mycli` home.
- This is cache-sensitive because local persistence must not change stable prompt construction or provider transcript replay.

#### 2. Signatures
- `MycliStorageLayout.from_home_dir(home_dir: Path) -> MycliStorageLayout`
- `MycliStorageLayout.trace_path(session_id: str) -> Path`
- `MycliStorageLayout.legacy_trace_path(session_id: str) -> Path`
- `TraceService(home_dir: Path).append(session_id: str, event: RuntimeTraceEvent) -> None`
- `TraceService(home_dir: Path).load(session_id: str) -> tuple[RuntimeTraceEvent, ...]`

#### 3. Contracts
- Preferred user-home layout:
  - `~/.mycli/sessions.db` remains the session DB path.
  - `~/.mycli/traces/{session_id}-trace.jsonl` is the preferred trace path.
  - `~/.mycli/sessions/{session_id}-trace.jsonl` is legacy read-only fallback for traces.
  - `~/.mycli/artifacts/` is reserved for non-transcript payload artifacts.
  - `~/.mycli/logs/` is reserved for operational logs.
- Trace payloads are local diagnostics only. They must not be used to rebuild provider transcript messages.
- Trace payloads must store bounded previews for full-content fields such as nested `metadata.raw_payload.content` and `metadata.transcript_content`.

#### 4. Validation & Error Matrix
- Valid session ID -> append/read trace normally.
- Empty, placeholder-like, path-like, or traversal-like session ID -> raise `ValueError`; do not create a trace file.
- New trace file exists -> load from `traces/`.
- No new trace file and legacy trace exists -> load from `sessions/`.
- Corrupt JSONL row -> skip row and keep loading valid trace events.

#### 5. Good/Base/Bad Cases
- Good: `TraceService.append("demo", event)` writes `.mycli/traces/demo-trace.jsonl` and stores content previews/counts.
- Base: A user with old `.mycli/sessions/demo-trace.jsonl` can still inspect trace output.
- Bad: Creating `.mycli/sessions/<session>-trace.jsonl` or dumping full file content into a `turn_item` trace event.

#### 6. Tests Required
- Unit test new trace writes go to `traces/`, not `sessions/`.
- Unit test legacy trace fallback from `sessions/`.
- Unit test invalid session ID rejection.
- Unit test trace payload sanitization for `raw_payload.content` and `transcript_content`.
- Runtime/CLI trace rendering tests should continue to pass without provider-facing request-shape changes.

#### 7. Wrong vs Correct

Wrong:
```python
path = home_dir / ".mycli" / "sessions" / f"{session_id}-trace.jsonl"
handle.write(json.dumps(event.to_dict()))
```

Correct:
```python
layout = MycliStorageLayout.from_home_dir(home_dir)
path = layout.trace_path(session_id)
handle.write(json.dumps(sanitized_trace_payload))
```

Keep storage layout centralized and treat trace files as bounded diagnostics, not as a second full transcript store.

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)
