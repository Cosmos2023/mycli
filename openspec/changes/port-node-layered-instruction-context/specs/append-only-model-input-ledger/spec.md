## ADDED Requirements

### Requirement: Every model-visible input SHALL be durably recorded
The runtime MUST persist the complete reconstructable value and semantic metadata of every item that enters a provider context window, including instructions, tool schemas, context fragments, conversation records, images, provider replay items, and compaction replacements.

#### Scenario: Provider input contains non-conversation context
- **WHEN** a provider request contains a skill catalog, workspace rule, memory, permission instruction, or hook context
- **THEN** the complete model-visible value MUST already exist in immutable durable storage
- **THEN** a hash without reconstructable content MUST NOT satisfy this requirement

### Requirement: Model-visible source-of-truth records SHALL be append-only
Instruction snapshots, tool-set snapshots, context events, request manifests, continuation resets, and compaction boundaries MUST be insert-only source-of-truth records.

#### Scenario: Effective context changes or disappears
- **WHEN** a previously active context section changes or is no longer active
- **THEN** the runtime MUST append a complete superseding event or tombstone
- **THEN** it MUST NOT update or delete the prior event

### Requirement: Provider requests SHALL be persisted before dispatch
The runtime MUST commit the complete logical provider input and immutable request manifest before invoking any provider transport.

#### Scenario: Durable commit fails
- **WHEN** persistence of snapshots, context events, or the request manifest fails
- **THEN** the provider transport MUST NOT be called
- **THEN** the turn MUST fail with a persistence-class error

### Requirement: Request manifests SHALL preserve exact model-input ordering
Each provider step MUST append an immutable manifest containing stable identifiers for all model-visible inputs in projected order, the provider configuration that affects input semantics, and the request signature.

#### Scenario: A historical provider step is reconstructed
- **WHEN** the runtime or diagnostics load a committed request manifest
- **THEN** they MUST reconstruct the same logical instructions, tool definitions, roles, content, and order without reading current workspace files or current runtime configuration

### Requirement: Transcript and model-context persistence SHALL remain distinct
Internal model scaffolding MUST be durably available without being represented as an ordinary user-authored transcript message or automatically rendered by the TUI.

#### Scenario: Permission context is persisted
- **WHEN** developer permission instructions enter a provider request
- **THEN** they MUST be present in the model-context ledger and request manifest
- **THEN** the normal transcript projection MUST NOT present them as a user message

### Requirement: Mutable state SHALL be a rebuildable projection only
Mutable session state or current-status tables MAY cache the latest effective context, but they MUST be reconstructable from append-only source-of-truth records and MUST NOT be the only copy of model-visible data.

#### Scenario: Mutable context baseline is lost
- **WHEN** a cached context baseline is missing or corrupt but append-only records remain valid
- **THEN** the runtime MUST be able to rebuild the effective baseline and request history

### Requirement: Continuation optimization SHALL use a complete durable logical input
Provider continuation or delta transport MUST be selected only after the runtime has assembled and persisted a complete logical request and proven that it strictly extends the prior compatible request.

#### Scenario: Request properties or prior input are incompatible
- **WHEN** the instruction snapshot, tool-set snapshot, provider-semantic configuration, or logical prefix is incompatible with continuation
- **THEN** the runtime MUST append a continuation-reset event
- **THEN** it MUST project a full replay from durable records

### Requirement: Compaction SHALL append a logical replacement boundary
Compaction MUST preserve all original durable records and append the summary, retained-tail references, rehydration content, and replacement boundary used by subsequent requests.

#### Scenario: Compaction replaces an active context window
- **WHEN** a context window is compacted
- **THEN** no prior conversation, context, manifest, or snapshot record MUST be rewritten or deleted
- **THEN** subsequent manifests MUST identify the appended compaction boundary they use

### Requirement: Sensitive persistence policy SHALL be enforced before model input
Content that policy forbids from durable storage MUST be excluded or safely transformed before instruction assembly and MUST NOT be sent to a provider in an unpersistable form.

#### Scenario: A source contains prohibited sensitive data
- **WHEN** sanitization cannot produce an allowed persistable representation
- **THEN** the source content MUST NOT enter the model context window
- **THEN** the runtime MUST persist a non-sensitive diagnostic describing the exclusion

### Requirement: Existing sessions SHALL receive an append-only compatibility boundary
Sessions created before this capability MUST remain readable and MUST establish reconstructable instruction, tool-set, and context state before their first new-format provider request.

#### Scenario: Legacy Node session sends its first migrated request
- **WHEN** a readable legacy session has no model-input ledger records
- **THEN** the runtime MUST append a compatibility bootstrap boundary and required snapshots
- **THEN** it MUST NOT rewrite the legacy conversation records
