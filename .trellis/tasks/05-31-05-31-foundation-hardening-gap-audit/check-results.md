# Check Results

Date: 2026-05-31

## Passed

- `uv run pytest tests/unit/services/test_doctor_service.py -q`
  - Result: `14 passed in 0.06s`
- `node --test tui/node/test/verify-deps.test.js`
  - Result: `3 pass`
- `uv run pytest tests/unit/services/test_doctor_service.py tests/unit/cli/node_tui/test_gateway.py tests/integration/test_node_tui_gateway.py -q`
  - Result: `50 passed in 0.30s`
- `npm --prefix tui/node install --package-lock-only --no-audit --no-fund`
  - Result: `up to date in 181ms`
- `uv run mycli doctor`
  - Result: doctor runs and reports `node_tui_dependencies` as actionable warning for incomplete dependencies.
- `uv run ruff check src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py`
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

## Blocked By Local Install Interruption

The following commands are still blocked because this environment repeatedly
interrupts actual `node_modules` installation after creating only
`tui/node/node_modules/es-toolkit`:

- `npm --prefix tui/node ci --no-audit --no-fund`
- `npm --prefix tui/node install --no-audit --no-fund --ignore-scripts`
- `npm --prefix tui/node ci --omit=optional --ignore-scripts --no-audit --no-fund`

The dependency verifier now detects this partial install state and prints:

```text
Node TUI dependencies are incomplete.
Run: npm --prefix tui/node ci
If a previous install was interrupted, run 'rm -rf tui/node/node_modules' first and retry.
```

Consequently:

- `npm --prefix tui/node test` fails early at `verify:deps` with the actionable diagnostic.
- `npm --prefix tui/node run typecheck` fails early at `verify:deps` with the actionable diagnostic.

## Recovery Command

```bash
rm -rf tui/node/node_modules
npm --prefix tui/node ci
npm --prefix tui/node test
npm --prefix tui/node run typecheck
```
