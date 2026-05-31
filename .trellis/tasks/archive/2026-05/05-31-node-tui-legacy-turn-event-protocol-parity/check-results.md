# Check Results

## Verification

- `npm --prefix tui/node ci`
  - Result: passed; clean dependency install completed.
- `npm --prefix tui/node test -- test/client.test.ts test/reducer.test.ts`
  - Result: passed; Node test runner executed 125 tests.
- `npm --prefix tui/node run typecheck`
  - Result: passed.
- `uv run pytest tests/unit/services/test_extension_manifest.py tests/unit/cli/node_tui/test_gateway.py -q`
  - Result: passed, 37 tests.

## Notes

- `turn.event` is now represented in the TypeScript known-event contract.
- `KNOWN_GATEWAY_EVENT_METHODS` is exported as a runtime list and checked
  against the TypeScript union at compile time.
- Node tests now compare the TypeScript known-event list to Python
  `SUPPORTED_GATEWAY_EVENT_STREAMS`, catching future manifest/protocol drift.
