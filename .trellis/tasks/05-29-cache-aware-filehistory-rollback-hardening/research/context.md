# Context: FileHistory Rollback Hardening

## Existing implementation

- `src/mycli/services/file_history.py`
  - Stores per-session snapshots under `~/.mycli/file-history/<session>/`.
  - Can snapshot an existing path or non-existing target.
  - Can rewind the latest snapshot or a specific snapshot.
  - Manifest already records `change_detection` metadata.

- `src/mycli/application/runtime/tools/tool_execution_service.py`
  - Calls `_snapshot_before_file_mutation()` before tool execution.
  - Currently snapshots hardcoded `FILE_MUTATION_TOOLS` (`Edit`, `Write`, legacy lower-case names).
  - Extracts paths from `file_path` or `path`.

- `src/mycli/application/turn_service.py`
  - Provides `undo_last_file_change()`.

- Existing tests
  - `tests/unit/services/test_file_history.py`
  - `tests/unit/application/test_tool_execution_service.py`
  - `tests/unit/application/test_agent_runtime.py::test_agent_runtime_file_history_undo_restores_mutating_tool_change`

## Cache constraints

- `RequestShapeBuilder` separates stable system/tool schema, replay, current intent, and volatile contextual fragments.
- `CacheShapeDiagnostics` reports stable hashes and first changed request fragment/message index.
- Runtime safety metadata must remain outside stable prompt/tool schema surfaces.
