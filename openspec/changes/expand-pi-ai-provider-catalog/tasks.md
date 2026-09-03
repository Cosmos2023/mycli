## 1. Canonical Provider Contracts

- [x] 1.1 Extend `ProviderId` with `openrouter`, `groq`, `together`, `moonshotai`, `nvidia`, and `cerebras`, then update exhaustive provider identity checks without widening `ProtocolId`.
- [x] 1.2 Update bounded provider enums and trace/validation lists in app, runtime, session preferences, gateway payloads, and management commands so the six IDs round-trip while unknown pi-ai IDs still fail.
- [x] 1.3 Add contract tests proving all six IDs survive canonical request, diagnostic, session preference, replay identity, and gateway serialization boundaries.

## 2. Product Profiles And Configuration

- [x] 2.1 Add a display name to `ProviderProfile`, move existing provider display names into profiles, and remove duplicated app-level provider name maps.
- [x] 2.2 Add the six deterministic `chat_completions` profiles with the specified base URLs, default models, auth references, conservative image/cache defaults, and hosted search disabled.
- [x] 2.3 Extend canonical hostname inference for the six service hosts and add tests for exact hosts, subdomains where allowed, invalid URLs, custom URLs, and the `compatible` fallback.
- [x] 2.4 Generate or update runtime setting choices and provider ordering from the profile catalog, with tests that setup/config surfaces contain each provider exactly once.
- [x] 2.5 Extend config parsing, layered resolution, writing, and config-management tests for default and explicit protocol, endpoint, model, auth reference, image override, and unsupported-provider behavior on all six routes.

## 3. Setup And Credential Lifecycle

- [x] 3.1 Update interactive and plain setup state to expose the six profile display names, default endpoints, protocols, and models through the existing API-key workflow.
- [x] 3.2 Extend non-interactive setup tests for each provider, including default resolution, explicit model/base URL, empty-key rejection, cancellation, and private auth-file storage.
- [x] 3.3 Extend login, logout, status, readiness, and gateway provider-row tests so default auth references equal provider IDs and no credential value appears in configuration, output, diagnostics, or logs.
- [x] 3.4 Verify `MYCLI_API_KEY` and stored-key precedence for a curated provider and prove pi-ai ambient environment credentials or OAuth are not used as a second credential source.

## 4. Curated Model Catalog

- [x] 4.1 Add one compiled model catalog entry for each specified default with pinned display name, reasoning efforts, context/output limits, base URL, and auth reference.
- [x] 4.2 Add an invariant test against pi-ai 0.84.2 proving every curated default exists under the expected provider and uses `openai-completions`.
- [x] 4.3 Refactor model catalog loading to merge missing compiled defaults in memory while letting an exact user entry override a compiled entry and leaving an existing `~/.mycli/models.json` byte-for-byte unchanged.
- [x] 4.4 Add model catalog tests for new-file bootstrap, existing-file additive visibility, user override precedence, duplicate prevention, current custom model injection, and bounded user-visible catalog size.
- [x] 4.5 Extend gateway model listing and selection tests for credential filtering, provider defaults, explicit custom entries, reasoning validation, session-scoped selection, and user-scoped configuration writes.

## 5. Pi-ai Provider And Model Resolution

- [x] 5.1 Add a closed provider-factory map using only the six specific pi-ai provider subpaths, with no production import of `@earendil-works/pi-ai/providers/all`.
- [x] 5.2 Refactor pi-ai snapshot construction to select the curated provider factory, resolve a known model, preserve its API, headers, input, thinking map, compatibility, and limits, and apply explicit mycli endpoint and limit overrides.
- [x] 5.3 Fail snapshot construction with a canonical configuration failure when a curated factory or catalogued model does not use `openai-completions`.
- [x] 5.4 Implement the uncatalogued-model path with conservative `max_tokens`, system-authority, no-store, no-strict-tools, no-adjustable-reasoning, and text-only defaults while retaining explicit supported capability overrides.
- [x] 5.5 Keep the existing OpenAI, Codex, compatible, Qwen, DeepSeek, and Anthropic snapshot behavior unchanged and add regression coverage around their current protocol mappings.
- [x] 5.6 Add module-loading tests proving selected factories retain required static provider/model headers and do not eagerly load unrelated Google, AWS, Azure, Mistral, or OAuth transports.

## 6. Effective Compatibility Policy

- [x] 6.1 Introduce an immutable effective compatibility policy derived from the resolved pi-ai model and pass it through context conversion, payload adjustment, and request-specific model construction.
- [x] 6.2 Map stable and dynamic developer-authority content to system authority when the effective model lacks developer-role support, while preserving the existing DeepSeek system-plus-user-suffix rule.
- [x] 6.3 Make maximum-token spelling, `store`, prompt cache, strict tools, and reasoning fields follow the effective policy and raise `unsupported_capability` for explicitly requested unsupported behavior.
- [x] 6.4 Preserve catalogued thinking-level maps, validate mycli reasoning efforts without silent clamping, and retain existing `ultra` and Anthropic budget behavior where those routes support it.
- [x] 6.5 Add payload fixtures for each curated default and an unknown model covering instruction authority, tools, token limits, optional controls, reasoning, images, endpoint overrides, and fail-closed payload shape checks.

## 7. Provider Runtime Parity

- [x] 7.1 Parameterize public `ProviderRegistry` tests across all six provider IDs and assert non-hosted-search traffic selects `PiAiProvider` with `maxRetries: 0`.
- [x] 7.2 Add mock HTTP stream tests for text, reasoning where supported, tool calls/results, usage, provider state, completion, and provider/model replay identity on every curated route.
- [x] 7.3 Add failure tests for HTTP classification, rate limits, retry-after, transport and premature stream errors, invalid tools, empty or truncated completion, abort races, early consumer return, and credential redaction.
- [x] 7.4 Add replay tests proving same-provider valid metadata resumes, cross-provider or inconsistent metadata degrades safely, and the six new identities do not alter canonical call IDs or session history.
- [x] 7.5 Run focused provider, config, runtime, and app suites and resolve all regressions without adding provider-specific retry or runtime branches.

## 8. Documentation And Live Verification

- [x] 8.1 Update provider and configuration reference documentation with the six first-class profiles, defaults, API-key setup, custom endpoints/models, conservative capability behavior, and rollback conversion to `compatible`.
- [x] 8.2 Document stable first-class versus custom-compatible support and explicitly defer Google, Vertex, Bedrock, Mistral, Azure, OAuth, cloud credential chains, and other new-protocol providers.
- [x] 8.3 Add or extend an opt-in live smoke runner that accepts credentials only through the existing private auth path or launch-scoped environment, sends a fixed non-secret prompt, verifies canonical text/usage/provider-state/completion, and emits only redacted evidence.
- [x] 8.4 Execute the live smoke for every credential actually available and record provider-by-provider results without claiming untested providers as live-verified.

## 9. Release Gates

- [x] 9.1 Run `npm run lint`, `npm run typecheck`, `npm run contracts:check`, and `npm test` from the repository root.
- [x] 9.2 Build and install the packed CLI under Node 22.19 and Node 24, then verify startup, setup/provider listing, custom model selection, and mock connectivity for all six providers.
- [x] 9.3 Inspect packed contents and runtime module loading to confirm pi-ai remains exactly pinned, no full provider catalog is eagerly imported, and unrelated provider SDKs are not required at startup.
- [x] 9.4 Update release evidence with deterministic suite counts, packed-install results, available live smoke results, residual unverified providers, and the unchanged hosted-search compatibility exception.
