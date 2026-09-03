## ADDED Requirements

### Requirement: Pi-ai is the default general provider transport
The system SHALL dispatch non-hosted-search requests for the existing OpenAI, Codex, compatible, Qwen, DeepSeek, and Anthropic routes through `@earendil-works/pi-ai` while continuing to expose the mycli `ModelProvider` interface.

#### Scenario: Existing protocol routes use pi-ai
- **WHEN** a configured request uses `responses`, `chat_completions`, or `anthropic_messages` without live hosted web search
- **THEN** the provider registry returns a pi-ai-backed `ModelProvider` for the corresponding `openai-responses`, `openai-completions`, or `anthropic-messages` API

#### Scenario: Pi-ai types remain private to the provider package
- **WHEN** runtime, core, config, storage, gateway, and TUI packages consume provider behavior
- **THEN** they continue to depend on mycli canonical types and do not import pi-ai model, context, message, event, error, or auth types

### Requirement: Existing provider configuration remains compatible
The system SHALL keep the existing provider IDs, protocol IDs, base URL, model selection, API-key resolution, model catalog, and session preference formats as the source of truth for this migration.

#### Scenario: Existing configuration starts without migration
- **WHEN** a user starts mycli with an existing supported provider configuration and credential reference
- **THEN** the same route, protocol, endpoint, model, and credential resolve into the pi-ai-backed provider without rewriting user configuration

#### Scenario: Unknown compatible model remains usable
- **WHEN** a compatible endpoint selects a model that is not present in pi-ai's built-in catalog
- **THEN** the adapter constructs a validated pi-ai model descriptor from the resolved mycli configuration instead of rejecting the model solely because pi-ai does not catalog it

### Requirement: Canonical request behavior is preserved
The adapter SHALL map instructions, conversation items, tools, tool results, images, output limits, store policy, cache policy, and reasoning settings without weakening instruction authority or losing canonical content.

#### Scenario: OpenAI-style developer context retains authority
- **WHEN** an OpenAI Responses, default Chat Completions, Qwen, or compatible request contains a context item whose canonical role is `developer`
- **THEN** the emitted provider payload represents it as a developer- or system-authority instruction according to the existing route behavior and never silently downgrades it to an ordinary user instruction

#### Scenario: DeepSeek role mapping remains unchanged
- **WHEN** a DeepSeek request contains stable developer instructions and dynamic developer-role timeline context
- **THEN** stable developer instructions are included in the system prompt and dynamic developer context is emitted as user-role suffix content, matching the pre-migration behavior

#### Scenario: Anthropic developer context remains in the system prompt
- **WHEN** an Anthropic request contains developer instructions or developer-role context items
- **THEN** those instruction layers are represented in Anthropic's system prompt and are not emitted as assistant content

#### Scenario: Tools and images retain structured content
- **WHEN** a request includes JSON Schema tools, tool-call history, tool results, or supported user images
- **THEN** the pi-ai request contains semantically equivalent structured tools, paired tool calls and results, and correctly encoded image content

#### Scenario: Ultra reasoning is preserved
- **WHEN** a request selects mycli reasoning effort `ultra`
- **THEN** the provider wire payload uses `ultra` rather than silently clamping the request to pi-ai's `max` wire value

#### Scenario: Request cache and storage controls are preserved
- **WHEN** a request supplies `store`, `promptCacheKey`, `cacheControlEnabled`, or a maximum output-token value
- **THEN** the route emits the equivalent supported provider fields and does not replace explicit mycli values with pi-ai defaults

### Requirement: Pi-ai streams are normalized into canonical provider events
The adapter SHALL translate pi-ai stream events into the existing `ProviderEvent` protocol with deterministic terminal behavior.

#### Scenario: Successful text and reasoning stream
- **WHEN** pi-ai emits start, text, thinking, usage, and done events
- **THEN** the adapter emits ordered canonical text and reasoning deltas, canonical usage, at most one provider replay state, and exactly one completed event

#### Scenario: Tool call stream completes
- **WHEN** pi-ai finishes one or more streamed tool calls
- **THEN** the adapter emits canonical tool calls with stable provider call IDs, names, and valid JSON argument strings before the completed event

#### Scenario: Non-success terminal reason is not reported as completion
- **WHEN** pi-ai terminates with error, aborted, pending, deferred, invalid empty output, or an unsupported truncation state
- **THEN** the adapter raises a classified provider failure or interruption instead of emitting a successful completed event

#### Scenario: Consumer cancellation stops upstream work
- **WHEN** the caller aborts the provider signal or stops consuming the stream early
- **THEN** the adapter aborts the pi-ai request, closes the iterator, and emits no late canonical deltas or completion

### Requirement: Mycli owns all automatic retry behavior
The adapter MUST disable pi-ai request retries and MUST leave retry budgeting, backoff, cancellation, diagnostics, and visible recovery events to the existing runtime retry policy.

#### Scenario: Retryable request fails before output
- **WHEN** a pi-ai-backed request receives a retryable transport, rate-limit, overload, or server failure before canonical output
- **THEN** one adapter invocation performs one provider attempt and returns a retryable `ProviderFailure` for the runtime to schedule

#### Scenario: Runtime retries remain observable
- **WHEN** the runtime retries a pi-ai-backed failure
- **THEN** existing `stream_retrying` and `stream_recovered` behavior, request and stream retry budgets, and abortable delays remain authoritative

### Requirement: Provider errors retain canonical diagnostics
The adapter SHALL normalize pi-ai in-band errors and thrown failures into the existing provider error taxonomy without exposing credentials or unsafe response content.

#### Scenario: HTTP failure carries safe response metadata
- **WHEN** pi-ai receives an HTTP error response with a status, request ID, or Retry-After header
- **THEN** the resulting `ProviderFailure` contains the corresponding canonical error code, safe diagnostics, retryability, and bounded retry-after value

#### Scenario: Transport cause is flattened by pi-ai
- **WHEN** pi-ai exposes only a textual network, timeout, premature-close, or truncated-stream error
- **THEN** the adapter applies bounded text-based fallback classification and marks only known transient transport failures retryable

#### Scenario: Caller abort wins over provider error text
- **WHEN** the caller signal is aborted while pi-ai reports an in-band error
- **THEN** the adapter classifies the outcome as interrupted rather than retryable provider failure

### Requirement: Replay remains durable across the cutover
The system SHALL store a bounded, versioned pi-ai replay projection and SHALL continue to read valid replay state written by the superseded Responses, Anthropic, and DeepSeek adapters.

#### Scenario: New pi-ai response is resumed
- **WHEN** a completed pi-ai response contains response IDs, text signatures, thinking signatures, or tool-call thought signatures needed for same-provider continuation
- **THEN** the adapter stores the minimum bounded replay metadata required to reconstruct a faithful pi-ai assistant history message

#### Scenario: Existing Responses state is resumed
- **WHEN** persisted history contains valid legacy Responses reasoning or native replay items
- **THEN** the adapter reconstructs equivalent pi-ai reasoning replay metadata or safely degrades only the unsupported native item while retaining canonical assistant content

#### Scenario: Existing Anthropic or DeepSeek state is resumed
- **WHEN** persisted history contains valid legacy Anthropic thinking blocks or DeepSeek reasoning content
- **THEN** the adapter reconstructs the corresponding pi-ai thinking history without changing canonical tool-call IDs or assistant text

#### Scenario: Replay state is malformed or foreign
- **WHEN** replay metadata is malformed, oversized, from another provider, or inconsistent with canonical text and tool calls
- **THEN** the adapter ignores the native metadata, uses canonical replay, records a safe diagnostic, and does not fail the session solely because native replay degraded

### Requirement: Hosted web search has an explicit compatibility boundary
The system SHALL preserve the current OpenAI hosted web-search request, lifecycle event, persisted call, and replay behavior until pi-ai provides an equivalent public event and replay contract.

#### Scenario: Live hosted search is requested
- **WHEN** an OpenAI Responses request has `webSearchMode` set to `live`
- **THEN** the provider registry selects the narrowly scoped hosted-search compatibility transport and continues to emit canonical search-started and search-completed events

#### Scenario: Hosted search is disabled
- **WHEN** an OpenAI Responses request does not enable live hosted search
- **THEN** it uses the pi-ai-backed Responses transport and does not enter the compatibility transport

#### Scenario: Compatibility transport is removable
- **WHEN** a pinned pi-ai release exposes equivalent hosted-search payload, lifecycle events, and replay metadata and parity tests pass against it
- **THEN** the compatibility transport and its exclusive direct OpenAI SDK dependency can be removed without changing canonical runtime contracts

### Requirement: The dependency cutover is release-verifiable
The migration SHALL pin the evaluated pi-ai version and SHALL verify type safety, contracts, tests, package contents, startup, and supported Node/platform behavior before deleting superseded transports.

#### Scenario: Pi-ai changes upstream behavior
- **WHEN** the pi-ai dependency version changes
- **THEN** request, stream, error, retry, replay, and package parity tests must pass before the lockfile update is accepted

#### Scenario: Packed CLI uses the new transport
- **WHEN** the distributable CLI is built and installed under Node 22.19 or Node 24 on a supported platform
- **THEN** pi-ai provider modules load successfully, no removed SDK import is required outside the hosted-search exception, and provider connectivity checks use the same canonical adapter boundary
