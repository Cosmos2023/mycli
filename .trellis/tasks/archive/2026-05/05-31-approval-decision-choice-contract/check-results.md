# Check Results

Checked at: 2026-05-31 17:14:09 CST

## Scope

- Approval decision-choice contract for the runtime/TUI approval state machine.
- Cross-language alignment across Python runtime schemas, extension manifest,
  TypeScript protocol contracts, TUI state types, and reducer behavior.

## Verification

- `uv run pytest tests/unit/domain/runtime/test_gateway_contract.py tests/unit/services/test_extension_manifest.py tests/unit/cli/node_tui/test_gateway.py -q`
  - Result: passed, 43 tests.
- `uv run ruff check src/mycli/domain/runtime/gateway_contract.py tests/unit/domain/runtime/test_gateway_contract.py tests/unit/services/test_extension_manifest.py`
  - Result: passed.
- `npm --prefix tui/node run typecheck`
  - Result: passed, including `verify:deps` and `tsc --noEmit`.
- `npm --prefix tui/node test -- protocol`
  - Result: passed, full Node suite ran with 130 tests.
- `npm --prefix tui/node test -- reducer`
  - Result: passed, full Node suite ran with 130 tests.

## Acceptance Criteria

- Python unit tests prove `approval.respond.choice` and
  `approval.request.options[].choice` expose the canonical decision-choice enum.
- Extension manifest test proves the enum is published for external clients.
- Node protocol test proves TypeScript contract metadata, including nested item
  enum metadata, matches the Python manifest schema.
- TUI state and approval prompt types now use typed approval request payloads
  instead of a generic record for pending approval state.
- Node reducer test proves canonical approval choices round through reducer
  state and `approval.respond` cleanup.
- Runtime TUI gateway spec documents the approval decision-choice taxonomy.

## Remaining Risk

- This slice constrains the protocol taxonomy only. It does not change approval
  policy, session-scoped allowance behavior, or visual approval UX.
- Full Python test suite and real interactive Node TUI smoke were not run for
  this narrow contract slice.
