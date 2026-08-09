## ADDED Requirements

### Requirement: Provider-visible history SHALL be append-only within a window
The runtime MUST construct every ordinary provider request by retaining the complete ordered input of the prior compatible request and appending new model-visible items.

#### Scenario: A second user turn has no context changes
- **WHEN** a completed turn is followed by another user turn in the same provider-input window
- **THEN** the prior logical request input MUST be an exact prefix of the new logical request input
- **THEN** unchanged context MUST NOT be emitted again

#### Scenario: A provider tool loop continues
- **WHEN** a provider response adds assistant tool calls and the runtime adds their ordered results
- **THEN** the next logical request MUST retain the complete prior request input unchanged
- **THEN** it MUST append the assistant call and every matching result without placing context inside the open batch

### Requirement: Context changes SHALL be chronological timeline events
The runtime MUST append a complete context update or model-visible tombstone when effective context changes or becomes inactive, and MUST NOT move, update, or delete the prior context item.

#### Scenario: Environment or permission context changes
- **WHEN** context differs from the durable baseline for the current window
- **THEN** the runtime MUST append the changed context after prior conversation output and before the current user input
- **THEN** the old provider input MUST remain an exact prefix

#### Scenario: Context becomes inactive
- **WHEN** a previously active context section is absent from the next contract
- **THEN** the runtime MUST append a bounded inactive marker with a supersession reference
- **THEN** it MUST preserve the prior context event and provider timeline item

### Requirement: Timeline ordering SHALL be durably reconstructable
Every provider-input window and timeline item MUST be persisted as immutable source-of-truth data before provider dispatch, and each request manifest MUST identify the exact ordered timeline prefix it uses.

#### Scenario: A historical request is reconstructed
- **WHEN** storage loads a committed v2 provider request manifest
- **THEN** it MUST reconstruct the same base instructions, tools, canonical items, roles, and order without current workspace or runtime state
- **THEN** every manifest timeline reference MUST resolve to an immutable event in the declared window

#### Scenario: Timeline persistence fails
- **WHEN** a timeline event, manifest, exact request, or prepared lifecycle event cannot be committed
- **THEN** the entire provider-step transaction MUST roll back
- **THEN** the provider transport MUST NOT be called

### Requirement: Provider compatibility SHALL be independent of timeline growth
The request signature MUST represent provider-visible semantic configuration and MUST NOT include hashes whose value changes solely because conversation or context timeline items were appended.

#### Scenario: Conversation grows under unchanged configuration
- **WHEN** provider, protocol, model, base instructions, tool definitions, and wire options are unchanged
- **THEN** the request signature and request-configuration hash MUST remain unchanged
- **THEN** the timeline hash MUST change to identify the longer input

#### Scenario: Tool schema or base instructions change
- **WHEN** a provider-visible tool definition or base instruction snapshot changes
- **THEN** the request signature MUST change
- **THEN** continuation MUST fall back to canonical full replay even if timeline items otherwise extend the prior request

### Requirement: Replacement history SHALL create an explicit window boundary
Compaction, incompatible source replay, and legacy adoption MUST append a new provider-input window boundary and MUST NOT rewrite events or manifests from an earlier window.

#### Scenario: Compaction replaces active history
- **WHEN** compaction produces summary and retained-tail replacement input
- **THEN** the next request MUST declare a `compaction` window boundary
- **THEN** strict-prefix validation MUST restart within the new window

#### Scenario: A legacy session first uses the timeline projector
- **WHEN** a readable session has prior conversation or request manifests but no provider timeline events
- **THEN** the runtime MUST append a `legacy_bootstrap` boundary and the complete bounded current input
- **THEN** it MUST leave all legacy records unchanged

### Requirement: Provider role fallback SHALL preserve chronological position
Provider adapters MUST preserve the timeline position of dynamic developer and contextual-user items even when a wire protocol requires role compatibility mapping.

#### Scenario: DeepSeek receives a dynamic developer update
- **WHEN** a permission or other developer-authority context update is appended after prior conversation
- **THEN** the DeepSeek adapter MUST map it to a supported system-role message at the same chronological position
- **THEN** it MUST NOT merge that update into the leading base system message

### Requirement: Cache diagnostics SHALL report structural prefix stability
The runtime MUST record bounded hashes and counts that distinguish semantic configuration changes, window changes, timeline growth, and the actual common prefix of adjacent logical requests.

#### Scenario: An ordinary turn is diagnosed
- **WHEN** a new manifest extends the prior request in the same window
- **THEN** diagnostics MUST include window identity, configuration hash, bootstrap-prefix hash, timeline hash, and common-prefix item count
- **THEN** diagnostics MUST NOT include raw prompt text, tool output, full provider payloads, secrets, or full cache keys
