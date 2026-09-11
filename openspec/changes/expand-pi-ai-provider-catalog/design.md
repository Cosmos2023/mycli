## Context

The completed pi-ai transport change routes all non-hosted-search model traffic through `PiAiProvider`, but mycli still models provider identity as a closed six-value union and constructs every Chat Completions model with mostly generic compatibility metadata. Pi-ai 0.84.2 ships 39 built-in provider families. Six of them are API-key services using the `openai-completions` API already supported by mycli: OpenRouter, Groq, Together, Moonshot AI, NVIDIA, and Cerebras.

Exposing a provider affects more than transport dispatch. Provider IDs are persisted in configuration, session preferences, replay state, diagnostics, model catalogs, and gateway payloads. Profiles feed setup, base URL inference, capability defaults, auth references, runtime setting choices, and documentation. The model catalog is user-editable and is currently bootstrapped only when `~/.mycli/models.json` does not exist, so existing users would not see newly compiled defaults unless loading becomes an additive in-memory merge.

Mycli remains the owner of credentials, explicit configuration, retry policy, canonical request/events, replay validation, and user-visible support policy. Pi-ai should own the provider stream implementation and known model compatibility data. The design must keep those two responsibilities distinct.

## Goals / Non-Goals

**Goals:**

- Make `openrouter`, `groq`, `together`, `moonshotai`, `nvidia`, and `cerebras` first-class, API-key-authenticated providers.
- Reuse their pinned pi-ai provider implementations and known model metadata without making pi-ai's catalog an allowlist or mycli's product catalog.
- Preserve instruction authority, canonical events, retry ownership, error classification, replay, custom endpoints, and custom model IDs.
- Give setup and model selection deterministic defaults without overwriting user-owned model catalogs.
- Keep package startup lazy and limit release commitments to routes with explicit mycli tests.

**Non-Goals:**

- Automatically exposing all pi-ai providers or dynamically accepting arbitrary provider IDs.
- Adding Google Generative AI, Vertex, Bedrock, Mistral Conversations, Azure Responses, or another new wire protocol.
- Adding OAuth, AWS credential chains, Google service accounts, regional/cloud project configuration, or pi-ai credential persistence.
- Importing hundreds of pi-ai models into the user-visible model selector.
- Guaranteeing provider-hosted web search or image support across every model on the six services.
- Changing runtime retry budgets, canonical provider events, tool execution, storage schemas, or the OpenAI hosted-search exception.

## Decisions

### 1. Add six explicit provider IDs, not a free-form provider type

`ProviderId` will add `openrouter`, `groq`, `together`, `moonshotai`, `nvidia`, and `cerebras`. `ProtocolId` remains unchanged because all six use `chat_completions` mapped to pi-ai `openai-completions`.

The stable product profiles are:

| ID | Display name | Base URL | Initial default model |
|---|---|---|---|
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | `openrouter/auto` |
| `groq` | Groq | `https://api.groq.com/openai/v1` | `openai/gpt-oss-120b` |
| `together` | Together | `https://api.together.ai/v1` | `moonshotai/Kimi-K2.7-Code` |
| `moonshotai` | Moonshot AI | `https://api.moonshot.ai/v1` | `kimi-k2.7-code` |
| `nvidia` | NVIDIA | `https://integrate.api.nvidia.com/v1` | `openai/gpt-oss-120b` |
| `cerebras` | Cerebras | `https://api.cerebras.ai/v1` | `gpt-oss-120b` |

Each default exists in the evaluated pi-ai 0.84.2 catalog, uses `openai-completions`, and is suitable for a tool-using coding workflow. Defaults are explicit product data, not “the first pi-ai model,” so catalog ordering cannot change setup behavior. A later default change requires an ordinary reviewed mycli change and release evidence.

Using `ProviderId = string` or deriving it from pi-ai's `BuiltinProvider` was rejected. Either would allow a dependency update to expand accepted configuration and persisted identities without mycli auth, setup, protocol, replay, or release coverage.

### 2. Centralize product profile metadata in `@mycli/config`

`ProviderProfile` remains the authoritative product definition for protocol, base URL, default model, hosted-search support, cache controls, and setup visibility. It will gain the display name currently duplicated in the app's setup map. Hostname inference and runtime setting choices will be generated from the same profile collection where practical, avoiding separate provider lists that can drift.

The six profiles disable hosted web search, prompt cache keys, and provider-wide image support by default. Text, tools, streamed usage, and canonical replay are the supported baseline. Existing explicit image-capability overrides remain available for users who have verified a particular custom model; known pi-ai model input metadata still prevents the provider snapshot from claiming an input type that the model does not declare unless the user deliberately takes the custom-model path.

Moving all profile data into pi-ai was rejected because config and setup must work without importing transport implementations, and mycli may intentionally support a narrower capability set than the upstream package.

### 3. Load only the six pi-ai provider factories and preserve their model metadata

The provider package will add a closed lazy factory map for the six specific pi-ai provider subpaths. It will not import `@earendil-works/pi-ai/providers/all` in production. For a selected route, snapshot construction will obtain the matching built-in provider and look up the configured model in that provider's synchronous catalog.

For a known model, the snapshot will clone the pi-ai descriptor as the baseline, preserving its provider ID, `openai-completions` API, headers, input types, thinking-level map, compatibility flags, context window, and maximum tokens. Mycli then applies explicit resolved endpoint, model identity, configured context/output limits, and supported capability overrides. The resolved API key is still passed through `SimpleStreamOptions.apiKey`, `maxRetries` remains zero, and no pi-ai credential store is installed.

The provider factory's stream implementation remains authoritative, including required static headers such as NVIDIA's catalogued headers. The snapshot fails closed if a supposedly supported provider factory or known model reports an API other than `openai-completions`.

Reusing only `openAICompletionsApi()` with a provider name and generic compatibility flags was rejected for known models because it discards the exact dialect metadata the package already maintains. Importing the all-provider registry was rejected because it broadens startup/package risk and obscures the reviewed support boundary.

### 4. Keep an explicit conservative path for uncatalogued models

A non-empty custom model ID remains valid. When the selected model is absent from the pinned provider catalog, mycli will synthesize an `openai-completions` descriptor on the selected provider factory with the configured base URL and explicit limits. The fallback assumes no developer role, no `store`, no strict tools, `max_tokens`, no adjustable reasoning effort, and text-only input unless the existing user capability override explicitly enables more.

The unknown-model path still benefits from the provider's pi-ai transport, authentication injection, event parser, cancellation, and error mapping. It does not guess model-specific reasoning formats or replay requirements. Documentation will direct endpoints needing different generic assumptions to the existing `compatible` route and its explicit protocol/capability controls.

Rejecting unknown model IDs was rejected because service catalogs change faster than mycli releases and OpenRouter in particular exposes a large, moving model set. Treating unknown models as fully OpenAI-compatible was rejected because fields such as `developer`, `store`, `max_completion_tokens`, and adjustable reasoning are not portable across these services.

### 5. Make payload authority and optional controls depend on the effective model

The context and payload projection will receive an immutable effective compatibility policy from the selected pi-ai model instead of branching only on the top-level provider ID. If the model does not support a developer role, stable and dynamic developer-authority content is emitted as system-authority content, never downgraded to an ordinary user message. DeepSeek keeps its separately specified system-plus-user-suffix behavior.

The payload layer will add `store`, prompt-cache, reasoning-effort, maximum-token, strict-tool, and developer-role fields only when the effective model policy supports the corresponding wire form. An explicitly requested unsupported control fails with `unsupported_capability` rather than being silently sent, silently dropped, or guessed. Maximum token spelling follows pi-ai compatibility metadata. The request-specific model clone preserves the catalogued thinking-level map and validates a requested mycli reasoning effort instead of replacing the map with a generic one or silently clamping it.

Keeping the current provider-name-only generic payload correction was rejected because several first-wave models declare `supportsDeveloperRole: false`, `supportsStore: false`, `maxTokensField: "max_tokens"`, or non-OpenAI reasoning formats.

### 6. Merge compiled defaults into model catalogs in memory

Mycli will add one compiled `BUILTIN_MODEL_CATALOG` entry for each initial default, including the pinned display name, reasoning efforts supported by mycli, context window, output limit, base URL, and auth reference. The user-visible selector remains a small curated list; it does not enumerate pi-ai's 346 OpenRouter entries or other full upstream catalogs.

`loadModelCatalog` will merge missing compiled built-ins with the parsed user catalog in memory. A user entry with the same provider, protocol, model, and normalized base URL wins. New compiled entries become visible to existing users without rewriting `~/.mycli/models.json`, while a newly bootstrapped file still contains the current compiled defaults for discoverability. The currently configured custom model continues to be injected when absent.

Rewriting every user's model file was rejected because it is a user-editable artifact and an automatic rewrite could reorder or overwrite custom descriptions, auth references, limits, and capability choices. Keeping bootstrap-only behavior was rejected because existing installations would never discover newly supported providers.

### 7. Reuse the existing auth and setup lifecycle

The default `authRef` is the provider ID. `mycli setup`, non-interactive setup, login, logout, status, readiness, and gateway credential management will operate on the six profiles through the existing API-key store. `MYCLI_API_KEY` remains the universal launch-scoped override with its existing precedence. Provider-specific ambient variables and pi-ai OAuth are not consulted, so mycli continues to have one credential source of truth.

Base URL inference will recognize the six canonical hosts. Setup and status display names come from `ProviderProfile`, and every output path continues to redact keys. This change adds no key material to model catalog entries or provider replay state.

Allowing pi-ai to resolve its own environment keys in addition to mycli auth was rejected because it would make readiness, status, redaction, and request behavior disagree about which credential is active.

### 8. Preserve canonical events, replay, and retry ownership

All six routes continue through the current `PiAiProvider -> ModelProvider` boundary. Stream mapping, error classification, usage normalization, cancellation, tool-call validation, and canonical event ordering remain shared. Replay envelopes store the new canonical provider IDs and reuse existing content/provider/model consistency checks. Pi-ai receives `maxRetries: 0`; runtime remains the only retry scheduler.

No provider-specific adapter classes or runtime retry branches will be added. Provider-specific work is limited to profile metadata, pi-ai factory/model selection, effective compatibility policy, and tests. This keeps the expansion additive and makes later removal of any route a catalog decision rather than a runtime rewrite.

### 9. Verification has deterministic and opt-in live layers

Mock HTTP tests will exercise all six provider IDs through the public `ProviderRegistry`, asserting request URL, authorization redaction, developer/system authority, tool schema and calls, maximum-token spelling, reasoning handling, usage, completion, errors, cancellation, replay identity, and zero hidden retries. Config and app tests cover parsing, hostname inference, setup, auth status, gateway provider rows, setting choices, model merge precedence, and custom model selection.

The normal suite uses no external credentials. A documented opt-in smoke harness accepts a key through the existing private auth path or a launch-scoped environment variable, sends only a fixed non-secret prompt, and retains only redacted canonical evidence. Lack of keys for all six services does not weaken the deterministic gate, but each provider should receive a live smoke before being described as live-verified in release evidence.

Packed-install and startup checks run on Node 22.19 and Node 24. They verify that the six selected provider modules load without eagerly loading unrelated Google, AWS, Azure, Mistral, or OAuth transports.

## Risks / Trade-offs

- [Risk] A provider accepts the OpenAI Completions shape but differs on developer roles, token fields, reasoning, or replay. -> Mitigation: use known pi-ai model compatibility metadata, conservative unknown-model defaults, effective-policy payload tests, and opt-in live smoke evidence.
- [Risk] The upstream model catalog changes or removes a chosen default. -> Mitigation: pin pi-ai exactly, assert every default exists with `openai-completions`, and require provider parity on dependency/default changes.
- [Risk] Importing provider metadata pulls all upstream SDKs into startup. -> Mitigation: import only the six provider subpaths and add module-loading/package smoke assertions.
- [Risk] Existing user model files hide new defaults or are overwritten. -> Mitigation: merge compiled defaults in memory with user entries winning and never rewrite an existing file merely to add defaults.
- [Risk] Unknown models need a provider-specific field the conservative fallback omits. -> Mitigation: allow explicit existing capability controls, document `compatible` for custom dialects, and promote recurring behavior only after fixtures establish it.
- [Risk] A new provider configuration is opened by an older mycli during rollback. -> Mitigation: document conversion to `compatible` with the same endpoint, model, and auth reference before downgrading; no credential or session data rewrite is required.
- [Trade-off] Only one default model per provider is initially visible. -> This avoids a noisy, volatile selector while custom model entries remain supported.
- [Trade-off] Provider-native OAuth and ambient credential variables are unavailable. -> This preserves a single inspectable mycli auth lifecycle and leaves OAuth/cloud credentials for a separately designed change.

## Migration Plan

1. Expand canonical provider identity and central product profiles, including display names, host inference, setup, auth/status, setting choices, and configuration tests.
2. Add the six curated model defaults and non-destructive in-memory merge behavior for existing user model catalogs.
3. Add the closed pi-ai provider-factory map, known-model cloning, conservative unknown-model construction, and fail-closed API validation.
4. Make authority, optional request controls, and reasoning selection consume the effective model compatibility policy; retain the existing DeepSeek exception.
5. Extend registry, payload, stream, error, replay, config, setup, gateway, model-selection, and packed-install fixtures across all six routes.
6. Update provider/configuration documentation and add the opt-in redacted live-smoke procedure. Record live evidence only for credentials actually available.
7. Run provider, config, runtime, app, lint, typecheck, contracts, root tests, and Node 22.19/24 packed smoke gates before release.

Rollback removes the six first-class profiles and pi-ai factory map. A user who needs to run the prior release converts an active new provider configuration to `compatible` while retaining the same `chat_completions` protocol, base URL, model, and auth reference. Canonical transcripts and API-key storage remain readable because no storage schema or credential format changes.

## Open Questions

- Live API keys for the six providers are not currently available in the repository and must never be committed. Which providers can be marked live-verified depends on credentials supplied through the opt-in smoke path during implementation or release validation.
- OpenRouter also exposes pi-ai OAuth, but adding it would create a second credential lifecycle and is intentionally deferred to the later OAuth/provider-auth design.
- Google, Vertex, Bedrock, Mistral, Azure Responses, and other non-Completions providers remain candidates for a second change after this curated expansion establishes the provider-profile and verification pattern.
