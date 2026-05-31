# Check Results

## Commands

- `npm --prefix tui/node test -- scripted-client.test.ts`
- `npm --prefix tui/node run typecheck`

## Result

- Node test run passed: 127 tests passed.
- Node typecheck passed.

## Acceptance Evidence

- Scripted client accepts `approval.respond_raw` for explicit approval response
  request-error smokes.
- JSON-RPC `approval.respond` errors are reduced into the same
  `request.failed` state shape used by RuntimeApp.
- Dumped TUI state contains exactly one error transcript row with method,
  code, message, and `source=request`.
- Existing scripted client command and local-theme tests still pass.
