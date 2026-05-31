# Check Results

Date: 2026-05-31

## Passed

- `uv run pytest tests/unit/services/test_doctor_service.py -q`
  - Result: `14 passed in 0.06s`
- `node --test tui/node/test/verify-deps.test.js`
  - Result: `3 pass`
- `uv run pytest tests/unit/services/test_doctor_service.py tests/unit/cli/node_tui/test_gateway.py tests/integration/test_node_tui_gateway.py -q`
  - Result: `50 passed in 0.72s`
- `npm --prefix tui/node ci`
  - Result: `added 50 packages in 6s`
- `npm --prefix tui/node test`
  - Result: `122 pass`
- `npm --prefix tui/node run typecheck`
  - Result: passed
- `npm --prefix tui/node install --package-lock-only --no-audit --no-fund`
  - Result: `up to date in 181ms`
- `uv run ruff check src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py tests/unit/cli/node_tui/test_gateway.py`
  - Result: `All checks passed!`

## Additional Runtime Smoke Fix

During verification,
`test_run_node_tui_gateway_with_real_node_scripted_client_waiting_state_routes`
exposed a real Node scripted-client issue: consecutive scripted turns used
`Date.now()` for `client_turn_id`, so two turns could share an id in the same
millisecond. The client could then observe the previous turn's completion while
waiting for the next turn, causing waiting approval/clarification state to be
misrouted.

Fix: scripted smoke turn IDs now use a monotonic local sequence.

## Install Interruption Root Cause And Fix

Initial verification repeatedly interrupted actual `node_modules` installation
after creating only `tui/node/node_modules/es-toolkit`.

`npm cache verify` exposed the root cause:

```text
npm error code EACCES
npm error Your cache folder contains root-owned files
npm error   sudo chown -R 501:20 "/Users/cosmos/.npm"
```

Project-side fix:

- Added `tui/node/.npmrc`.
- Routed Node TUI installs to a project-local npm cache.
- Ignored generated npm cache directories.
- Re-ran clean install successfully.

## Recovery Command

```bash
rm -rf tui/node/node_modules
npm --prefix tui/node ci
npm --prefix tui/node test
npm --prefix tui/node run typecheck
```
