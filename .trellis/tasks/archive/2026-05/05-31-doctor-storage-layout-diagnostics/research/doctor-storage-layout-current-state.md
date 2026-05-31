# Doctor Storage Layout Current State

## Files Inspected

- `src/mycli/services/diagnostics/doctor.py`
- `src/mycli/services/storage_layout.py`
- `src/mycli/services/tracing/trace_service.py`
- `tests/unit/services/test_doctor_service.py`
- `.trellis/spec/backend/quality-guidelines.md`
- `.trellis/spec/backend/logging-guidelines.md`
- `.trellis/spec/backend/database-guidelines.md`

## Findings

- `DoctorService.run()` currently collects:
  - config
  - sessions DB
  - logs
  - FileHistory
  - TUI
  - MCP
- `MycliStorageLayout` defines:
  - `sessions_db_path`
  - `legacy_sessions_dir`
  - `traces_dir`
  - `artifacts_dir`
  - `logs_dir`
- `TraceService.append(...)` writes under `layout.trace_path(session_id)` and
  creates parents lazily through `ensure_parent(path)`.
- Doctor is explicitly read-only and must not create storage directories.

## Design

Add `_check_storage_layout()` to doctor after logs/session DB checks. It should
return one `DoctorCheck` named `storage_layout`.

Validation:

- Missing reserved dirs are OK with message like `reserved paths available`.
- Existing reserved dir with write bit is OK.
- Existing reserved path that is not a directory is failed.
- Existing reserved dir without owner/group/other write bits is failed.

The check should use existing `_is_writable(path)` to avoid writing probe files.
