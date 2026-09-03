## ADDED Requirements

### Requirement: Mycli exposes a curated first-class provider set
The system SHALL add `openrouter`, `groq`, `together`, `moonshotai`, `nvidia`, and `cerebras` to the supported `ProviderId` set without automatically exposing every provider shipped by pi-ai.

#### Scenario: A curated provider is configured
- **WHEN** configuration, setup, login, model selection, session preferences, or provider status receives one of the six curated provider IDs
- **THEN** the system accepts the ID as a first-class provider and preserves it in canonical configuration, events, diagnostics, replay state, and session metadata

#### Scenario: An uncurated pi-ai provider name is configured
- **WHEN** configuration receives a pi-ai provider ID that is not in mycli's explicit supported set
- **THEN** configuration fails with the existing bounded unsupported-provider error rather than silently publishing an unverified route

#### Scenario: The pi-ai dependency adds a provider
- **WHEN** a later pinned pi-ai version contains additional built-in providers
- **THEN** those providers remain unavailable as first-class mycli routes until mycli explicitly adds their profiles, contracts, and verification

### Requirement: Curated provider profiles are deterministic
The system SHALL define the following default profiles and SHALL use `chat_completions` for all six routes:

| Provider ID | Display name | Default base URL |
|---|---|---|
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` |
| `groq` | Groq | `https://api.groq.com/openai/v1` |
| `together` | Together | `https://api.together.ai/v1` |
| `moonshotai` | Moonshot AI | `https://api.moonshot.ai/v1` |
| `nvidia` | NVIDIA | `https://integrate.api.nvidia.com/v1` |
| `cerebras` | Cerebras | `https://api.cerebras.ai/v1` |

#### Scenario: Provider defaults are resolved
- **WHEN** a curated provider is selected without an explicit protocol or base URL
- **THEN** configuration resolves the provider's `chat_completions` protocol and exact default base URL from its stable mycli profile

#### Scenario: A custom endpoint is supplied
- **WHEN** a curated provider is selected with an explicit valid base URL
- **THEN** the configured endpoint overrides the profile default without changing the provider identity or protocol contract

#### Scenario: A known provider hostname is inferred
- **WHEN** provider identity is omitted and the configured base URL uses one of the six canonical provider hostnames
- **THEN** configuration infers the corresponding curated provider instead of the generic `compatible` provider

### Requirement: Curated providers use existing API-key ownership
The system SHALL use mycli's existing `authRef`, private API-key store, setup input, login command, redaction rules, and `MYCLI_API_KEY` override for every curated provider, and SHALL pass the resolved key to pi-ai per request.

#### Scenario: Setup stores a provider key
- **WHEN** interactive or non-interactive setup completes for a curated provider with a non-empty API key
- **THEN** setup writes the provider profile to configuration, stores the key under the provider's default auth reference, and never writes or prints the key in normal configuration, output, diagnostics, or logs

#### Scenario: A stored or environment key is used
- **WHEN** a curated provider request has a key resolved through the selected `authRef` or `MYCLI_API_KEY`
- **THEN** the provider registry passes that key as the request-scoped pi-ai credential and does not require pi-ai credential storage or OAuth

#### Scenario: No API key is available
- **WHEN** a curated provider is selected without a resolved API key
- **THEN** readiness and request construction fail through the existing missing-credential behavior before model traffic is sent

### Requirement: Curated routes use pi-ai provider and model metadata
The provider adapter SHALL use the pinned pi-ai provider implementation for each curated route and SHALL apply pi-ai's known model compatibility metadata when the configured model is present in that provider's built-in catalog.

#### Scenario: A catalogued model is selected
- **WHEN** the configured provider and model match a model in the pinned pi-ai catalog
- **THEN** request construction uses that provider's pi-ai OpenAI Completions implementation and the model's compatible input, reasoning, context-window, output-limit, and wire-dialect metadata, subject to explicit mycli configuration overrides

#### Scenario: Configuration overrides catalog metadata
- **WHEN** mycli configuration explicitly sets the endpoint, context limit, output limit, image capability, reasoning effort, or another supported request control
- **THEN** the explicit mycli value remains authoritative and pi-ai catalog defaults do not rewrite persisted configuration

#### Scenario: An uncatalogued model is selected
- **WHEN** a curated provider uses a non-empty model ID that is absent from the pinned pi-ai catalog
- **THEN** the adapter constructs a conservative OpenAI-compatible model descriptor and sends the request instead of treating the pi-ai catalog as an allowlist

### Requirement: Model selection stays curated and usable
The system SHALL provide a deterministic default model for each curated provider, SHALL expose those defaults through setup and the mycli model catalog, and SHALL continue to support explicit custom model IDs.

#### Scenario: Setup opens for a curated provider
- **WHEN** the setup UI or non-interactive setup selects a curated provider without an explicit model
- **THEN** it offers or resolves the provider's pinned, validated default model rather than selecting an arbitrary first entry from pi-ai's catalog

#### Scenario: The model selector is displayed
- **WHEN** a user has usable credentials for a curated provider or that provider is currently configured
- **THEN** the model selector includes the curated mycli entries for that provider without importing the entire pi-ai catalog into the user-visible list

#### Scenario: A user enters another model ID
- **WHEN** configuration or the custom model catalog names a model not present in mycli's curated entries
- **THEN** the model remains selectable and is handled by the catalogued or uncatalogued pi-ai path according to whether pi-ai recognizes it

### Requirement: Provider capabilities fail conservatively
The system SHALL disable hosted web search for all six curated providers and SHALL advertise model-dependent capabilities only when resolved metadata or an explicit user override supports them.

#### Scenario: Hosted search is evaluated
- **WHEN** a curated provider request is assembled
- **THEN** its hosted web-search mode is disabled and it never enters the OpenAI hosted-search compatibility transport

#### Scenario: Image input is not confirmed
- **WHEN** the selected model has no verified image-input capability and configuration does not explicitly enable it
- **THEN** mycli rejects or omits image input through the existing unsupported-capability boundary instead of assuming provider-wide image support

#### Scenario: Pi-ai confirms a model capability
- **WHEN** a catalogued model declares a supported input or reasoning capability and mycli configuration does not disable it
- **THEN** the pi-ai-backed request may use that capability while retaining mycli's canonical request and event contracts

#### Scenario: A model does not support developer messages
- **WHEN** a catalogued or conservative fallback model does not support the Chat Completions developer role
- **THEN** stable and dynamic developer-authority content is emitted with system authority and is never silently downgraded to an ordinary user message

#### Scenario: An optional request control is unsupported
- **WHEN** configuration explicitly requests a store, cache, reasoning, token-field, or strict-tool behavior that the effective model compatibility policy cannot represent
- **THEN** request construction fails with `unsupported_capability` instead of silently sending, dropping, clamping, or guessing the field

### Requirement: Runtime behavior remains provider-neutral
The six curated routes SHALL emit the existing canonical provider events and failures, SHALL keep pi-ai internal retries at zero, and SHALL leave retry, cancellation, tool execution, usage accounting, replay validation, and session recovery under existing mycli ownership.

#### Scenario: A curated provider completes text or tool output
- **WHEN** pi-ai emits a successful text, reasoning, tool-call, usage, and completion stream for one of the six routes
- **THEN** the adapter produces the same ordered canonical event vocabulary used by existing Chat Completions providers and records the curated provider identity in replay state

#### Scenario: A curated provider request fails
- **WHEN** the route receives an HTTP, transport, stream, cancellation, tool-protocol, or terminal provider failure
- **THEN** the adapter applies the existing bounded failure classification and one adapter invocation performs no hidden pi-ai retry

#### Scenario: A session resumes on the same curated provider
- **WHEN** canonical history and valid pi-ai replay state are resumed with the same provider and model identity
- **THEN** provider-native reasoning or tool metadata is reused only after the existing replay consistency checks pass

### Requirement: Custom-compatible support remains available
The system SHALL retain `compatible` as the documented route for OpenAI-compatible providers that are not part of the curated first-class set.

#### Scenario: A user configures another OpenAI-compatible service
- **WHEN** the service supplies an OpenAI-compatible Chat Completions or Responses endpoint but has no first-class mycli profile
- **THEN** the user can configure `compatible` with an explicit base URL, model, protocol, and credential while accepting generic compatibility behavior

#### Scenario: Documentation compares support levels
- **WHEN** users review provider configuration documentation
- **THEN** it distinguishes first-class verified providers from custom-compatible endpoints and identifies Google, Vertex, Bedrock, Mistral, Azure, OAuth, and other new-protocol routes as unsupported by this change

### Requirement: Provider expansion is release-verifiable
The change SHALL include deterministic tests for every curated route and SHALL provide opt-in live smoke instructions without making external API keys part of the default test suite.

#### Scenario: Provider parity tests run
- **WHEN** provider, config, app, runtime, typecheck, lint, contract, and packed-CLI verification runs without external credentials
- **THEN** mock transports cover profile resolution, payloads, text, tools, usage, failures, retry ownership, replay identity, setup, login status, model selection, and redaction for all six providers

#### Scenario: A live smoke test is requested
- **WHEN** a maintainer supplies a curated provider API key through a documented opt-in environment or private auth path
- **THEN** the smoke test sends a minimal non-secret prompt, verifies canonical text, usage, provider-state, and completion behavior, and redacts the credential from all retained evidence

#### Scenario: Pi-ai is upgraded
- **WHEN** the pinned pi-ai version or one of the curated default models changes
- **THEN** all six provider parity checks and supported Node packed-install checks must pass before the change is accepted
