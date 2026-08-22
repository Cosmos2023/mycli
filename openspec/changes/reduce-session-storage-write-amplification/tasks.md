## 1. Schema And Search Projection

- [x] 1.1 Add schema-v9 migration tests for external-content conversation FTS, removal of history FTS, search equivalence, trigger synchronization, and rollback/retry safety.
- [x] 1.2 Implement the schema-v9 external-content conversation FTS migration on top of schema v8 and update supported-version initialization.
- [x] 1.3 Update storage doctor checks and schema expectations for the new search projection.

## 2. Payload Maintenance

- [x] 2.1 Add store tests for dry-run candidate counts/bytes, conservative eligibility, approval-marker transcript equivalence, inactive state cleanup, and idempotency.
- [x] 2.2 Extend the typed maintenance contract and report with legacy rollout/state payload metrics.
- [x] 2.3 Implement transactional legacy rollout compaction and inactive legacy-state deletion without touching canonical transcript or active recovery records.

## 3. Command And Documentation

- [x] 3.1 Expose `/session maintenance --apply-payloads` through gateway/backend composition and update command tests.
- [x] 3.2 Document logical payload cleanup, reusable free pages, and the separate explicit vacuum step.

## 4. Verification

- [x] 4.1 Run focused storage, doctor, gateway, backend, readable-transcript, and provider-input regression tests.
- [x] 4.2 Run package lint/type checks and the relevant full workspace test suites.
- [x] 4.3 Benchmark a copied real database to record report latency, logical bytes removed, physical size before/after vacuum, and `/resume`/search equivalence.
