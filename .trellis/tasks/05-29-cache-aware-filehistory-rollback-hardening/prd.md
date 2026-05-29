# Cache-aware FileHistory rollback hardening

## Goal

Harden mycli's existing FileHistory-backed checkpoint/rollback path so structured file mutations can be safely undone without damaging user changes or the append-only prefix-cache strategy.

## Requirements

- Use the existing `FileHistoryService` as the rollback backend.
- Add a generic mutation metadata contract for structured tools to declare affected file paths.
- Wire the contract into the currently registered structured file mutation tools: `Edit` and `Write`.
- Update `ToolExecutionService` to snapshot through the mutation contract instead of relying only on hardcoded `Edit`/`Write` path extraction.
- Preserve existing `/undo` and `TurnService.undo_last_file_change()` entrypoints.
- Refuse rollback by default when the target file has changed again after the checkpointed mutation.
- Keep checkpoint/rollback metadata out of stable model-visible request surfaces.
- Add cache-shape regression tests proving stable system hash, tool schema hash, and tool order hash do not drift due to FileHistory/mutation metadata.

## Acceptance Criteria

- [ ] `Edit` creates a recoverable checkpoint before successful edits.
- [ ] `Write` creates a recoverable checkpoint before overwriting an existing file.
- [ ] `Write` creates a checkpoint that can delete a newly created file on undo.
- [ ] No-op writes and failed tool validations do not create misleading rollback entries.
- [ ] Tool execution snapshots paths via a generic mutation-target contract.
- [ ] Rollback refuses to overwrite files modified after the checkpointed mutation and reports the conflicting path.
- [ ] Cache-shape tests show checkpoint/mutation metadata does not change stable system hash, tool schema hash, or tool order hash.
- [ ] Existing tests continue to pass.

## Technical Approach

- Define a small tool-side protocol or metadata surface for mutation targets, probably adjacent to `SchemaTool`/`ToolSpec` in `src/mycli/tools/base.py`.
- Implement mutation target extraction for `EditTool` and `WriteTool`.
- Change `ToolExecutionService._snapshot_before_file_mutation()` to ask the executor/route for mutation targets where available, keeping a compatibility fallback if needed.
- Use `FileHistoryService` manifest `change_detection` data for conflict detection before restore.
- Keep all checkpoint IDs and file-history metadata in execution/session/trace surfaces, not in stable request fragments.

## Out of Scope

- Git-native checkpoints.
- `/undo --force`.
- Bash filesystem-effect tracking.
- Move/Delete/Mkdir implementation unless those tools are reintroduced separately.
- Hermes gateway/cron/dashboard parity.

## Verification

- `uv run pytest tests/unit/services/test_file_history.py`
- `uv run pytest tests/unit/application/test_tool_execution_service.py`
- `uv run pytest tests/unit/application/test_agent_runtime.py`
- Focused cache-shape regression test for request stability.
- Full `uv run pytest`, `uv run ruff check .`, and tracked-source `mypy` before completion.

## Parent Context

- Parent task: `05-29-mycli-hermes-agent-gap-analysis`
- Parent decision: coding-agent engineering first; runtime safety/recovery first; FileHistory checkpoint/rollback hardening as the first small implementation slice.
