## ADDED Requirements

### Requirement: Stable provider identity and runtime route identity are distinct
The system SHALL retain a closed stable `ProviderId` catalog and SHALL represent dispatch, configuration, session, worker, transcript, and replay provider values as a separately validated bounded provider route identity.

#### Scenario: Existing stable route is parsed
- **WHEN** an existing configuration or session names a stable provider id
- **THEN** the system accepts the same persisted `provider` value as a valid provider route without migration

#### Scenario: Experimental route is parsed
- **WHEN** configuration names a lowercase bounded route id that is not a stable provider id
- **THEN** the system accepts it only after the shared route-identity validation and serviceability checks succeed

#### Scenario: Invalid route reaches a trust boundary
- **WHEN** configuration, Worker RPC, storage, transcript, replay, or gateway input contains an empty, oversized, malformed, or control-character provider route
- **THEN** that boundary rejects the value instead of treating every string as a provider

### Requirement: The pi-ai provider directory is discoverable but dormant
The system SHALL expose installed pi-ai provider metadata for configuration while requiring an explicit activated route before model requests can use an experimental provider.

#### Scenario: Installed provider is not configured
- **WHEN** the pinned pi-ai catalog contains a provider with no activated mycli route
- **THEN** configuration surfaces may describe it but the provider registry does not accept requests for it

#### Scenario: Upstream adds a provider
- **WHEN** a later reviewed pi-ai version contains a new provider
- **THEN** the provider remains inactive until explicit mycli configuration supplies an accepted route, protocol, endpoint requirements, model policy, and credential reference

#### Scenario: Unsupported provider is discovered
- **WHEN** a catalog provider has only unsupported APIs or authentication requirements
- **THEN** the directory marks it unserviceable with a bounded non-secret reason and refuses activation

### Requirement: Activated routes have one normalized immutable descriptor
The system SHALL resolve each stable, experimental, or compatible route into an immutable descriptor containing one protocol, endpoint, credential reference, source, support tier, model policy, and optional underlying catalog provider.

#### Scenario: Stable route resolves
- **WHEN** a stable provider is configured using existing fields
- **THEN** the system produces an activated descriptor with backward-compatible defaults

#### Scenario: Catalog route resolves
- **WHEN** an experimental route references an installed pi-ai provider and one supported protocol
- **THEN** the system selects only catalog models using that protocol and applies explicit route/model overrides

#### Scenario: Mixed-protocol provider is activated
- **WHEN** one pi-ai provider contains models using more than one supported protocol
- **THEN** each activated route must select exactly one protocol and a second protocol requires another route identity

#### Scenario: Unknown route resolves
- **WHEN** a route is absent from the pi-ai catalog
- **THEN** it is serviceable only with an explicit supported protocol, endpoint, non-empty model declaration, credential reference, and required capability metadata

### Requirement: Catalog-backed routes delegate to pi-ai built-in providers
The provider adapter SHALL use the installed pi-ai provider implementation whenever the effective catalog provider and selected API are available, and SHALL use pi-ai `createProvider` only when the installed catalog does not describe that route/API.

#### Scenario: Built-in route streams
- **WHEN** an activated route and model match a pi-ai built-in provider and supported API
- **THEN** its wrapper delegates streaming to that built-in provider while applying only explicit mycli route, endpoint, credential, model, and capability overrides

#### Scenario: Stable route API is absent from the catalog
- **WHEN** a backward-compatible stable route selects a supported API that its pi-ai built-in catalog does not provide
- **THEN** mycli constructs the route with pi-ai `createProvider` and the matching lazy API factory rather than a bespoke HTTP transport

#### Scenario: Explicit uncatalogued model is selected
- **WHEN** a route declares a model absent from its installed catalog
- **THEN** the adapter constructs it only from explicit bounded protocol, limit, modality, and capability facts and does not guess catalog metadata

### Requirement: Credentials and retries remain mycli-owned
Every activated route SHALL resolve credentials through mycli and SHALL perform one pi-ai SDK attempt per runtime attempt.

#### Scenario: API key is available
- **WHEN** mycli resolves the route's configured API key
- **THEN** the adapter passes it as a request-scoped pi-ai override without storing it in directory, model, replay, log, or configuration output

#### Scenario: API key is missing
- **WHEN** an activated route has no usable mycli credential
- **THEN** readiness or selection fails before provider traffic and pi-ai ambient credential discovery is not used

#### Scenario: Provider request runs
- **WHEN** any pi-ai-backed provider stream begins
- **THEN** its options include `maxRetries: 0` and only the existing runtime recovery layer may schedule another request attempt

### Requirement: Provider and model snapshots are operation-stable
The system SHALL capture one immutable route/provider/model/capability snapshot before an operation performs asynchronous provider work.

#### Scenario: Configuration changes during a request
- **WHEN** an activated route is replaced while a request is in progress
- **THEN** that request completes or fails using its original snapshot and the next operation uses the replacement

#### Scenario: Invalid replacement is supplied
- **WHEN** a replacement route is unserviceable or conflicts with another route
- **THEN** the candidate is refused and the last valid descriptor remains usable

### Requirement: Replay is bound to the effective provider transport
Pi-ai replay metadata SHALL be restored only for matching canonical content, provider route, underlying catalog provider when present, API, model, and sanitized endpoint identity.

#### Scenario: Matching replay resumes
- **WHEN** replay and the effective route transport identity match and canonical content validation succeeds
- **THEN** provider-native state may be restored

#### Scenario: Route configuration changed
- **WHEN** a route id now resolves to a different provider, API, model, or endpoint identity
- **THEN** old provider-native replay degrades to canonical history with a bounded diagnostic

#### Scenario: Replay is persisted
- **WHEN** a response stores transport identity
- **THEN** it contains no API key, authorization header, query secret, raw provider payload, or mutable provider object

### Requirement: Complete catalog loading is lazy and version-gated
The full pi-ai provider directory SHALL be loaded only on directory or catalog-resolution demand and SHALL remain tied to the exact pinned pi-ai version.

#### Scenario: Ordinary CLI starts
- **WHEN** mycli starts without opening provider/model configuration or resolving a new catalog snapshot
- **THEN** unrelated provider, OAuth, cloud, and `providers/all` modules are not eagerly loaded

#### Scenario: Pi-ai version changes
- **WHEN** the exact pi-ai dependency version is changed
- **THEN** provider directory, API mapping, model compatibility, module-loading, mock parity, and packed supported-Node checks must pass before release

### Requirement: Hosted search uses the pi-ai Responses transport
The system SHALL route live Responses hosted search through the same pi-ai provider path as every
other supported request and SHALL NOT retain a dedicated direct OpenAI SDK transport.

#### Scenario: Ordinary OpenAI Responses request runs
- **WHEN** hosted web search is disabled
- **THEN** the request uses the pi-ai provider path

#### Scenario: Live hosted search runs
- **WHEN** a supported OpenAI Responses request enables live hosted search
- **THEN** the pi-ai payload contains the native `web_search` tool and the stream preserves final
  assistant output, usage, response identity, and completion

#### Scenario: Provider emits heartbeat or hosted-search lifecycle frames
- **WHEN** the pinned pi-ai version encounters unmodelled keepalive or native web-search progress events
- **THEN** those frames do not fail the request and no canonical search-progress or native
  search-call replay event is fabricated

#### Scenario: Non-Responses protocol enables hosted search
- **WHEN** a Chat Completions or Anthropic Messages request enables live hosted search
- **THEN** the provider rejects the unsupported capability before sending traffic
