## 1. Built-In Contracts

- [x] 1.1 Add `web_fetch` and `tool_search` definitions, manifest entries, exports, ordering, and approval/effect metadata
- [x] 1.2 Add structured tool-activation effect types and bounded storage contracts

## 2. Secure Web Fetch

- [x] 2.1 Implement URL normalization, public IPv4/IPv6 classification, DNS validation, and pinned request transport
- [x] 2.2 Implement redirect, timeout, cancellation, byte, media-type, encoding, HTML/JSON/text extraction, and external-content fencing
- [x] 2.3 Add focused adapter and manifest tests covering policy denial, SSRF, DNS rebinding, redirects, transfer bounds, parsing, and interruption

## 3. Deferred Tool Discovery

- [x] 3.1 Implement immutable deferred candidates, bounded deterministic ranking, result projection, and activation effects
- [x] 3.2 Split direct and deferred integration exposure while retaining all adapters and child-runtime allowed scope
- [x] 3.3 Persist validated activations atomically with tool results and add bounded SQLite load/recovery projection

## 4. Runtime Exposure

- [x] 4.1 Make provider-loop tools turn-local and mutable, applying activations only after durable result persistence
- [x] 4.2 Restore current-turn activations across reconstructed contexts, filter stale/disallowed names, and invalidate continuation only on schema changes
- [x] 4.3 Add runtime/provider/storage/composition tests for initial deferral, next-step exposure, execution, persistence failure, recovery, turn isolation, and stable ordering

## 5. Verification And Documentation

- [x] 5.1 Update backend executable contracts and user-facing tool documentation for network policy and deferred discovery
- [x] 5.2 Run package tests, integration regressions, lint, typecheck, build, and OpenSpec validation
- [x] 5.3 Review the focused diff for append-only, secret-output, schema-prefix, and cross-layer regressions
