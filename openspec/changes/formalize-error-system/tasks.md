## 1. Inventory And Shared Contracts

- [x] 1.1 Inventory first-party error emitters in providers, runtime, tools/policy, gateway, storage, config, integrations, and CLI/TUI fatal paths; record source locations, current code, evidence, scope, and intended reason in a coverage fixture, including all 17 runtime codes and explicit generic fallbacks.
- [x] 1.2 Add the canonical version-1 error-context schema, bounded reason/detail unions, scope/outcome types, causal snapshots, generator/catalog entries, and exports in `backend/packages/contracts`; verify schema/type drift checks.
- [x] 1.3 Implement the exhaustive reason registry, legacy mappings, public summary formatter, and recovery action definitions under `contracts/src/errors/`; make existing public helpers delegate to those definitions.
- [x] 1.4 Implement strict producer validation, reason-specific safe detail construction/redaction, and optional-context consumer extraction with conservative fallback; cover unknown versions/reasons, invalid combinations, control sequences, secrets, and encoded-size limits.
- [x] 1.5 Add shared serialized baseline fixtures for legacy failures, concrete capability errors, uncertain effects, and retry causes, with hash validation and registry/known-emitter coverage checks.

## 2. Readers, Transport, And Durable Compatibility

- [x] 2.1 Extend internal failure/result interfaces and the closed provider Worker serializers/parsers; bump the existing Worker protocol and test stale-version rejection before dispatch while keeping enriched public writers disabled.
- [x] 2.2 Preserve context through failed-turn inputs, atomic terminalization, lifecycle outbox, turn result, display metadata, and `projectCommittedTurnTerminalization`; test one committed occurrence under each existing terminalization failpoint.
- [x] 2.3 Preserve tool error context through router results, canonical transcript payloads, completed effect attempts, and restart replay; verify that failure metadata does not enter successful image or command-output payloads accidentally.
- [x] 2.4 Extend provider-attempt and runtime-state readers/writers, including closed validators and independently exported snapshot versions; verify legacy reads and enriched close/reopen round trips.
- [x] 2.5 Add the next available database format fence before enriched durable writes, following existing migration/backup conventions; test forward migration without transcript rewriting and previous-reader refusal on an isolated enriched database.
- [x] 2.6 Negotiate error-context versions in gateway bootstrap and implement complete legacy/enriched projection for events, RPC errors, transcript pages, and nested attempt failures; test new/old peer combinations and explicit handshake parameter-rejection fallback.

## 3. Recovery And Public Projection

- [x] 3.1 Implement the runtime recovery resolver against typed state/capability inputs and the existing effect ledger; retain request/stream retry policy and forbid whole-turn replay based solely on `retryable`.
- [x] 3.2 Preserve concrete attempt causes through retry exhaustion, cancellation, and Worker/supervisor cleanup; test timer cancellation, incomplete-output rollback, and first-cause preservation.
- [x] 3.3 Wire resolved actions through existing gateway/management/headless flows, including compatible-model selection and execution inspection; reject stale ownership and unsupported actions without executing arbitrary error-supplied commands.
- [x] 3.4 Migrate TUI notice/detail/retry projections to the shared summary and resolved recovery data, retaining existing components, width calculation, fatal terminal restoration, and turn/request identity rules.
- [x] 3.5 Verify equivalent live, paginated, resumed, and headless failure facts; test distinct identical-wording request errors, duplicate terminal delivery, current-state recovery refresh, long identifiers, CJK wrapping, and one Ctrl+C interruption notice.

## 4. Complete The Image Capability Path

- [x] 4.1 Resolve effective image capabilities consistently in frozen turn configuration, provider preflight, tool exposure, and tool execution options; test pi-ai catalog inputs, supported overrides, unknown metadata, and original-detail independence.
- [x] 4.2 Hide `view_image` for text-only models and reject stale/restored calls at dispatch with the typed capability reason before file read/decoding; verify one failed tool result and continued agent execution.
- [x] 4.3 Add precise user/tool/history image preflight failures and compatible-model recovery while preserving accepted images and conversation records; verify zero provider IO for incompatible input and no identical automatic retry.
- [x] 4.4 Add an integration regression matching the text-only-model/tool-image incident, including restart with already persisted images, later explicit compatible-model selection, and a dynamic MCP image result whose completed effects must not be replayed.

## 5. Migrate Known Error Boundaries

- [x] 5.1 Migrate provider auth/configuration and local capability guards to evidence-backed reasons; cover access denial, hosted search, reasoning effort, deferred response, and unavailable auth flow without exposing internal exception text.
- [x] 5.2 Migrate provider HTTP/stream/transport classification while retaining status/code precedence, retry delays, and generic unknown fallbacks; cover quota, overload, context overflow, timeout, and partial-stream failures.
- [x] 5.3 Migrate file/image/process tool errors and approval/sandbox decisions; preserve nonzero exit, timeout, startup, and effect evidence as tool-local results where recoverable.
- [x] 5.4 Migrate gateway admission, output capacity, stalled delivery, protocol, state-conflict, and Worker-exit failures; preserve first causal diagnostics and test reconciliation without automatic resubmission.
- [x] 5.5 Migrate storage/session failures and emergency reporting; distinguish commit failure from readable-projection failure and retain original causes without recursive persistence or false terminal-state claims.
- [x] 5.6 Migrate remaining config/integration/management/TUI fatal boundaries identified by the inventory; verify deliberate generic fallbacks for unknown extension errors and no conversation mutation from local fatal reporting.

## 6. Verify And Enable

- [x] 6.1 Complete shared fault-injection coverage for unknown effects, cancellation/retry races, disconnect after commit, storage failure, mixed versions, malformed optional context, and burst output; keep existing gateway limits and lossless batching regressions passing.
- [x] 6.2 Verify that all inventoried known emitters reach the catalog and migrated consumers use one message/recovery definition; remove superseded competing mappings and obsolete tests while retaining necessary legacy API facades.
- [x] 6.3 Update `.trellis/spec/backend/error-handling.md`, multimodal/provider/gateway/storage contracts, and user-facing troubleshooting documentation with concrete reason examples, diagnostic lookup, migration behavior, and rollback limits.
- [x] 6.4 Run appropriate unit/integration suites and required `npm run lint`, `npm run typecheck`, `npm run contracts:check`, and `npm test`; distinguish unrelated baseline failures with reproducible evidence and leave no owned test processes running.
- [x] 6.5 Enable enriched writers only after reader/version/negotiation gates pass, remove temporary rollout branches, build the production entry points, and verify enriched and legacy public paths against isolated fixture sessions.
