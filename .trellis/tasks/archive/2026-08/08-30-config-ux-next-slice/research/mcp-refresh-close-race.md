# Bug Analysis: MCP Refresh Writes After Backend Close

## 1. Root Cause Category

- **Category**: B/D - Cross-layer contract and test coverage gap.
- **Specific cause**: `McpManager.close()` closed registered clients but did not await an already
  started `loadCached()` or `refresh()` promise. The runtime composition aborted discovery before
  close, but an empty-config refresh could already be inside asynchronous cache persistence. Backend
  completion therefore raced a later `~/.mycli/cache` write.

## 2. Why Earlier Checks Failed

1. The focused backend test passed because the scheduler often completed the tiny cache save before
   temporary-directory cleanup.
2. The full app suite reliably increased scheduling pressure and exposed `ENOTEMPTY` during cleanup.
3. Retrying directory removal would have hidden the symptom while leaving product shutdown able to
   return before owned background work settled.

## 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
| --- | --- | --- | --- |
| P0 | Architecture | `McpManager.close()` awaits started cache/refresh promises before final client cleanup | Done |
| P0 | Test | Manager unit test holds cache save open and proves close remains pending | Done |
| P1 | Integration | Full app suite keeps the ready-before-MCP-discovery shutdown regression | Done |
| P1 | Documentation | Runtime integration contract defines no post-close work and await-before-return | Done |

## 4. Systematic Expansion

- **Similar issues**: background cache refreshes, lazy transport startup, persistence drains, and
  task workers can all outlive their owner if close observes resources but not in-flight promises.
- **Design improvement**: every owner records started asynchronous work and makes its idempotent
  close await settlement after cancellation and before releasing external state.
- **Process improvement**: treat cleanup races in full suites as lifecycle failures; do not first
  add filesystem retry loops.

## 5. Knowledge Capture

- [x] Update runtime integration lifecycle contract.
- [x] Update cross-layer background lifecycle checklist.
- [x] Add manager-level regression test.
- [x] Template sync checked; this repository has no `src/templates/markdown/spec` tree.
