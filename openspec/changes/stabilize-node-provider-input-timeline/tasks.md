## 1. Contracts And Storage

- [x] 1.1 Add v2 provider manifest and provider-input timeline event domain contracts with validation tests.
- [x] 1.2 Add the additive SQLite timeline schema, immutable triggers, migration coverage, and storage readers.
- [x] 1.3 Commit timeline events atomically with context events, exact requests, manifests, and prepared lifecycle records.

## 2. Timeline Projection

- [x] 2.1 Implement strict conversation-prefix comparison, context update/tombstone projection, and deterministic window boundaries.
- [x] 2.2 Build logical requests and manifests by replaying the ordered current-window timeline.
- [x] 2.3 Separate request-configuration, bootstrap-prefix, timeline, and common-prefix hashes from continuation compatibility.

## 3. Runtime And Providers

- [x] 3.1 Switch the durable Node turn path to provider-input timeline projection without changing the non-ledger fallback.
- [x] 3.2 Preserve chronological dynamic developer context in Responses, Chat, DeepSeek, and Anthropic provider projection.
- [x] 3.3 Keep continuation capability-gated and verify prompt caching does not depend on `previous_response_id`.

## 4. Boundaries And Compatibility

- [x] 4.1 Add bootstrap, legacy-bootstrap, compaction, and source-reset window behavior with resume reconstruction tests.
- [x] 4.2 Preserve contiguous tool call/result batches and post-result generated context across timeline replay.

## 5. Verification And Documentation

- [x] 5.1 Add structural strict-prefix regressions across ordinary turns, changed context, tool loops, and provider wire lanes.
- [x] 5.2 Update backend context/replay documentation for chronological provider-input windows and bounded diagnostics.
- [x] 5.3 Run storage, runtime, provider, type-check, lint, and relevant Python parity tests.
