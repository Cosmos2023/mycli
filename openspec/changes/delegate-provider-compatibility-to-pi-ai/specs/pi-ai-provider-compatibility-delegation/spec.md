## ADDED Requirements

### Requirement: Mycli expresses provider-neutral request intent
The system SHALL pass session identity, cache retention, reasoning effort, output cap, temperature, credentials, cancellation, and supported transport hooks through pi-ai's public request options without constructing equivalent provider wire fields itself.

#### Scenario: Cached request is sent
- **WHEN** a turn uses a stable session id and cache retention other than `none`
- **THEN** mycli passes `sessionId` and `cacheRetention` to pi-ai and pi-ai alone decides which cache key, retention, marker, or affinity fields the provider receives

#### Scenario: Reasoning request is sent
- **WHEN** the selected model accepts the requested reasoning effort
- **THEN** mycli passes a pi-ai reasoning level and pi-ai alone selects the provider-specific reasoning field and format

#### Scenario: Output cap is sent
- **WHEN** the request has a maximum output-token value
- **THEN** mycli passes `maxTokens` to pi-ai and does not select a provider-specific token field name

### Requirement: Pi-ai model compatibility is authoritative
The system SHALL use the selected pi-ai model's catalog metadata, automatic detection, and `Model.compat` values as the only provider wire-compatibility authority.

#### Scenario: Catalog-backed model is selected
- **WHEN** an activated route selects a model from the pinned pi-ai catalog
- **THEN** developer-role behavior, storage defaults, reasoning format, token fields, strict tools, cache behavior, message replay, and other supported wire differences come from that catalog model and pi-ai adapter

#### Scenario: Provider does not support a cache preference
- **WHEN** mycli requests cache retention that the selected provider cannot represent
- **THEN** pi-ai downgrades or omits unsupported wire fields and mycli does not reject the request through a duplicate cache capability guard

#### Scenario: DeepSeek reasoning is enabled
- **WHEN** a DeepSeek model receives a supported reasoning preference
- **THEN** pi-ai emits the appropriate DeepSeek thinking and reasoning fields without a mycli payload rewrite

### Requirement: Private relays can override pi-ai compatibility
The system SHALL accept validated route- and model-level pi-ai compatibility overrides for explicitly configured relays, with model values taking precedence over route values and both taking precedence over pi-ai detection or catalog defaults.

#### Scenario: Route override is configured
- **WHEN** a private OpenAI-compatible relay declares a valid compat field for its selected API
- **THEN** the field is merged into the pi-ai model used for that route without creating a built-in mycli provider capability record

#### Scenario: Model override is configured
- **WHEN** one model on a route declares a valid compat field also present at route level
- **THEN** that model's field wins while other models retain the route value

#### Scenario: Invalid override is configured
- **WHEN** a compat object has an unknown key, invalid value, or field unavailable to the route's selected pi-ai API
- **THEN** route resolution fails with a bounded configuration error before provider traffic

#### Scenario: Compat snapshot crosses a worker boundary
- **WHEN** an activated route is serialized to an agent worker
- **THEN** only its validated immutable compat override data crosses the boundary and the worker independently validates it

### Requirement: Cache configuration uses one retention preference
The system SHALL expose `request.cache_retention` with the closed values `none`, `short`, and `long`, SHALL default it to `short`, and SHALL stop producing request behavior from the legacy prompt-cache and cache-control booleans.

#### Scenario: Cache retention is configured
- **WHEN** configuration selects a valid retention value
- **THEN** every new provider request carries that value together with its stable mycli session id

#### Scenario: Provider changes within a session
- **WHEN** a session switches from an OpenAI route to DeepSeek or another provider
- **THEN** the same provider-neutral retention preference is passed to pi-ai and no OpenAI-specific cache flag causes an unsupported-capability failure

#### Scenario: Legacy cache key is present in user configuration
- **WHEN** configuration still contains `prompt_cache_key_enabled` or `cache_control_enabled`
- **THEN** the key does not create a provider request field or pre-transport capability failure and diagnostics direct the user to `request.cache_retention`

### Requirement: Provider storage defaults belong to pi-ai
The system SHALL NOT expose or emit a mycli request-level provider `store` control and SHALL accept pi-ai's resolved storage behavior.

#### Scenario: Responses request is sent
- **WHEN** a normal OpenAI Responses request is constructed
- **THEN** pi-ai supplies its storage field and mycli does not inject or overwrite it

#### Scenario: Completions endpoint rejects storage
- **WHEN** pi-ai compat identifies an OpenAI-compatible endpoint that does not accept `store`
- **THEN** pi-ai omits the field without a mycli capability guard or payload deletion

### Requirement: Provider profiles contain product defaults only
Stable provider profiles SHALL contain identity, display name, default protocol, default endpoint, and optional default model, while model capability and wire compatibility come from pi-ai or explicit model declarations.

#### Scenario: Stable profile is loaded
- **WHEN** mycli resolves a built-in provider route
- **THEN** the profile supplies product defaults but no supported-protocol, cache, storage, developer-role, or strict-tool capability truth table

#### Scenario: Explicit protocol is configured
- **WHEN** a stable or custom route selects one of the three supported pi-ai APIs
- **THEN** serviceability is determined during provider/model resolution instead of by provider-profile booleans

### Requirement: Canonical instruction authority is preserved without wire reconstruction
The system SHALL project stable instructions and developer context into pi-ai's `Context.systemPrompt` in deterministic authority order and SHALL let pi-ai select the supported system or developer wire role.

#### Scenario: Provider supports developer role
- **WHEN** a reasoning model's pi-ai compat permits developer messages
- **THEN** pi-ai emits the combined authoritative prompt using developer authority

#### Scenario: Provider does not support developer role
- **WHEN** the selected model's pi-ai compat rejects developer messages
- **THEN** pi-ai emits the combined authoritative prompt using system authority rather than mycli downgrading it to a user or assistant message

#### Scenario: Canonical history contains dynamic developer context
- **WHEN** a request includes developer-role context items
- **THEN** their text remains model-visible at authoritative prompt level and mycli does not insert marker messages to reconstruct provider payload roles

### Requirement: Semantic capability failures remain explicit
The system SHALL fail requests that explicitly require a semantic capability that cannot be silently omitted, while it SHALL NOT fail on provider wire-field differences owned by pi-ai.

#### Scenario: Unsupported reasoning effort is selected
- **WHEN** the selected model metadata excludes an explicitly requested reasoning effort
- **THEN** the request fails before traffic with a bounded unsupported-reasoning error

#### Scenario: Unsupported image is supplied
- **WHEN** a request contains an image and the selected model metadata excludes image input
- **THEN** the request fails before traffic without dropping the image

#### Scenario: Hosted search is requested on another protocol
- **WHEN** live hosted search is requested for Chat Completions or Anthropic Messages
- **THEN** the request fails before traffic because pi-ai 0.84.2 has no equivalent first-class feature

### Requirement: Runtime remains the only automatic retry owner
Every pi-ai request SHALL set `maxRetries: 0`, and mycli runtime SHALL exclusively own retry budgeting, delay, cancellation, partial-output reset, diagnostics, and recovery events.

#### Scenario: Retryable provider failure occurs
- **WHEN** pi-ai returns a retryable transport or provider failure
- **THEN** one adapter invocation performs one upstream attempt and runtime decides whether to schedule the next visible attempt

#### Scenario: Request succeeds after retry
- **WHEN** runtime retries and a later attempt succeeds
- **THEN** existing retry and recovery events describe every attempt without a hidden pi-ai request

### Requirement: Remaining payload adaptation is narrow
The system SHALL retain payload adaptation only for hosted Responses search that pi-ai 0.84.2 cannot express through `SimpleStreamOptions`, and SHALL keep canonical context, replay, event, error, and telemetry adapters outside provider wire-parameter ownership.

#### Scenario: Hosted Responses search is enabled
- **WHEN** a supported Responses route requests live hosted search
- **THEN** the payload hook adds exactly the native hosted-search tool while leaving roles, reasoning, token, storage, cache, and tool-schema fields unchanged

#### Scenario: Hosted search is disabled
- **WHEN** a request does not ask for live hosted search
- **THEN** no payload transformer is installed solely to rewrite provider compatibility fields
