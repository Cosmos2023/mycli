# Doctor Node TUI Dependency Diagnostics Research

## Existing Findings

- `DoctorService._check_tui()` currently emits:
  - `python_tui`
  - `node_tui`
  - `node`
  - `npm`
- `node_tui` only checks `_node_tui_source_root().exists()`.
- Normal Node TUI launch uses `build_node_command(...)`:
  - script mode (`MYCLI_NODE_TUI_SCRIPT`) runs `node tui/node/src/index.js`
  - normal mode requires `tui/node/node_modules/.bin/tsx` and
    `tui/node/src/index.tsx`
- Recent typed-stream smoke worktrees showed a real usability gap:
  - `node` and `npm` existed
  - `node_modules` was missing/incomplete
  - tests and normal TUI launch failed until dependencies were available

## Recommended Shape

- Add helper functions in `doctor.py`:
  - `_node_tui_dependency_marker() -> Path`
  - maybe `_node_tui_entrypoint() -> Path` if needed later
- Extend `_check_tui()`:
  - if source root missing: existing `node_tui` warning only
  - if source root exists and marker exists: `node_tui_dependencies=OK`
  - if source root exists and marker missing:
    `node_tui_dependencies=WARNING` with remediation command
- Keep `node` and `npm` as independent PATH checks because they diagnose system
  prerequisites, not project dependencies.

## Why Warning, Not Failed

- Existing spec says Node/npm or TUI unavailable is warning unless a stricter
  command is introduced.
- A user can still run plain CLI mode without Node TUI deps.
- Doctor warnings return exit code 0, which is appropriate for optional UI
  capabilities.

## Risks

- Tests should not depend on the real repo's current `node_modules` state. Use
  monkeypatch to point `_node_tui_source_root()` at a temp fixture.
- Do not run installers from doctor. Remediation text only.
