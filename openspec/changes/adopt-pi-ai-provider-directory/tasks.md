## 1. Route And Directory Contracts

- [x] 1.1 Add the bounded `ProviderRouteId` type, parser, and stable-provider guard without weakening `ProviderId`
- [x] 1.2 Move runtime request, config, Worker RPC, session, transcript, and replay provider fields to validated route identity
- [x] 1.3 Add canonical provider-route descriptor and provider/model directory DTOs at the owning package boundaries
- [x] 1.4 Add route identity compatibility and malformed-boundary regression tests

## 2. Pi-ai Provider Directory

- [x] 2.1 Add a memoized lazy `providers/all` loader that exposes sanitized provider and model metadata
- [x] 2.2 Classify catalog providers and models by supported mycli protocol, API-key serviceability, endpoint requirements, and disabled reason
- [x] 2.3 Implement immutable catalog-backed route snapshots that delegate to the installed pi-ai provider
- [x] 2.4 Implement pi-ai-declared fallback snapshots for stable/custom route APIs absent from the catalog
- [x] 2.5 Replace the closed six-provider loader map with the shared directory path while preserving explicit configuration authority
- [x] 2.6 Add directory, mixed-protocol, unknown-model, module-loading, auth-override, and one-attempt provider tests

## 3. Provider-scoped Configuration And Models

- [x] 3.1 Extend model/provider declarations with optional source and catalog-provider route metadata while retaining v2 readers
- [x] 3.2 Allow catalog-backed declarations to omit models and require complete declarations for unknown routes
- [x] 3.3 Build normalized stable, experimental, and compatible route descriptors in app assembly without a config/providers cycle
- [x] 3.4 Replace global compiled catalog merging with provider-scoped pi-ai catalog plus user override resolution
- [x] 3.5 Preserve exact current uncatalogued models and existing session/user default selection semantics
- [x] 3.6 Add config, catalog merge, alias, mixed-protocol, custom-route, credential, and rollback tests

## 4. Registry, Replay, And Runtime Integration

- [x] 4.1 Make provider registry construction consume immutable route snapshots for every ordinary request
- [x] 4.2 Route hosted Responses search through pi-ai as a provider-native tool
- [x] 4.3 Add versioned non-secret route/provider/API/model/endpoint identity to pi-ai replay
- [x] 4.4 Degrade mismatched or legacy experimental replay to canonical history while retaining stable legacy readers
- [x] 4.5 Add provider registry, error, cancellation, runtime retry, replay, and session resume coverage

## 5. Provider-scoped Gateway Behavior

- [x] 5.1 Add provider-directory listing for activated/configurable route summaries and readiness
- [x] 5.2 Require and validate `provider` on `model.list`, returning only that route's model catalog
- [x] 5.3 Remove credential-filtered global model listing and silent cross-provider `/model <name>` fallback
- [x] 5.4 Keep `model.select` exact-identity validation and session/user persistence atomic on failure
- [x] 5.5 Add gateway/app integration tests for omitted, malformed, inactive, missing-credential, same-name, and successful routes

## 6. Provider-first TUI Model Selection

- [x] 6.1 Track which provider route owns the loaded model list in TUI runtime state and gateway reducers
- [x] 6.2 Add provider selection before model selection when multiple usable routes exist and skip it for one route
- [x] 6.3 Load provider models asynchronously with stable loading, empty, error, cancel, and stale-response states
- [x] 6.4 Route login/startup/settings model flows through the same provider-scoped selector and retain reasoning/scope stages
- [x] 6.5 Add selector, reducer, gateway replay, narrow-width, large-catalog, stale-response, and shell integration tests
- [x] 6.6 Make the current provider's models the default view and add Enter session quick-select plus Tab advanced options
- [x] 6.7 Add selector and shell regressions for one-confirmation switching, provider back-navigation, advanced choices, and retry

## 7. Documentation And Compatibility

- [x] 7.1 Document stable, experimental catalog-backed, and compatible route configuration and credential behavior
- [x] 7.2 Document provider-scoped `/model`, explicit provider switching, custom models, upgrade, downgrade, and rollback
- [x] 7.3 Update configuration examples/reference and provider transport contracts without publishing unverified live support

## 8. Verification And Release Evidence

- [x] 8.1 Run focused core, config, provider, runtime, storage, app, gateway, and TUI tests
- [x] 8.2 Run lint, typecheck, contracts check, config/reference drift checks, and `git diff --check`
- [x] 8.3 Run the full root test suite and record deterministic totals
- [x] 8.4 Run packed CLI smoke on Node 22.19 and Node 24 and verify lazy module loading/startup budgets
- [x] 8.5 Run optional redacted live smokes only for locally available provider keys and mark all others not live-verified
- [x] 8.6 Run Trellis quality verification and fix spec, cross-layer, reuse, test, or documentation findings
- [x] 8.7 Update OpenSpec/Trellis progress and provide rollback and residual-risk evidence

## 9. Hosted Search Transport Unification

- [x] 9.1 Inject the native Responses web-search tool through pi-ai, reject unsupported protocols,
  and remove the dedicated hosted-search transport and direct OpenAI dependency
- [x] 9.2 Add mock coverage proving pi-ai tolerates heartbeat and search lifecycle frames while
  retaining final text and completion
- [x] 9.3 Align OpenSpec, Trellis contracts, architecture, and release evidence with the unified
  transport and the pinned pi-ai lifecycle/replay limitation
- [x] 9.4 Re-run focused/full quality gates and a redacted live ProviderRegistry request

## 10. Catalog-following Model Declarations

- [x] 10.1 Treat catalog-backed v2 `models` entries as provider-local overrides/additions instead
  of an implicit allowlist
- [x] 10.2 Add and validate explicit `model_policy: "subset"` semantics while preserving legacy flat
  catalog subset behavior
- [x] 10.3 Add directory and real gateway regressions proving an existing DeepSeek declaration
  inherits `deepseek-v4-flash-vision-exp` from pi-ai 0.84.4
- [x] 10.4 Verify focused tests, the 295-file suite, lint, typecheck, contract/config drift, and packed
  Node 22.19/24 artifacts
