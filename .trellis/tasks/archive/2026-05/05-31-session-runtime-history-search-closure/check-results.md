# Check Results

## Verification

- `uv run pytest tests/unit/infrastructure/test_sqlite_session_store.py::test_sqlite_session_store_searches_runtime_history_items tests/unit/infrastructure/test_sqlite_session_store.py::test_sqlite_session_store_search_backfills_legacy_history_items tests/unit/services/test_session_service.py::test_session_service_searches_runtime_history_items tests/unit/services/test_doctor_service.py::test_doctor_service_fails_session_db_missing_history_search_objects -q`
  - Passed: 4 tests.
- `uv run ruff check src/mycli/infrastructure/sqlite_session_store.py src/mycli/services/diagnostics/doctor.py tests/unit/infrastructure/test_sqlite_session_store.py tests/unit/services/test_session_service.py tests/unit/services/test_doctor_service.py`
  - Passed.
- `uv run pytest tests/unit/infrastructure/test_sqlite_session_store.py tests/unit/services/test_session_service.py tests/unit/services/test_doctor_service.py -q`
  - Passed: 146 tests.
- `uv run mypy src/mycli/infrastructure/sqlite_session_store.py src/mycli/services/diagnostics/doctor.py src/mycli/services/session_service.py`
  - Passed.
- `uv run pytest -q`
  - Passed: 1187 tests.
- `npm --prefix tui/node test -- --runInBand`
  - Passed: 135 tests.

## Acceptance

- Store searches runtime-only `history_items` rows.
- Store backfills existing legacy `history_items` rows into `history_items_fts`.
- `/search` service output renders runtime history matches in bounded human-readable form.
- Doctor reports missing runtime history search FTS objects read-only.
