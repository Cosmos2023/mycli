## ADDED Requirements

### Requirement: Node runtime SHALL assemble a layered instruction contract
The Node runtime MUST represent stable base instructions, developer instructions, contextual-user fragments, canonical conversation, and current user intent as typed layers before provider projection.

#### Scenario: Contract is assembled for a provider step
- **WHEN** the runtime is ready to build a provider request
- **THEN** it MUST assemble a typed instruction contract from the current durable and runtime sources
- **THEN** provider projection MUST consume that contract instead of reading unrelated raw context fields

### Requirement: Base instructions SHALL be complete and session-frozen
The Node application MUST ship the complete mycli system template with a version and content hash, and each session MUST use an immutable persisted snapshot of the selected template.

#### Scenario: Existing session resumes after a template update
- **WHEN** a session already has an instruction snapshot and the packaged template changes
- **THEN** the resumed session MUST continue using its persisted snapshot
- **THEN** a new session MUST use the updated template

### Requirement: Workspace instructions SHALL be discovered and bounded
The Node runtime MUST discover one workspace instruction source using Python-compatible precedence and MUST validate, fence, diagnose, and bound it before model use.

#### Scenario: AGENTS instructions are selected
- **WHEN** `AGENTS.md` exists and no higher-precedence `.mycli.md` or `MYCLI.md` exists
- **THEN** its accepted bounded content MUST become a contextual-user workspace fragment

#### Scenario: Unsafe workspace content is detected
- **WHEN** the selected file contains prohibited invisible controls or obvious instruction-hijack content
- **THEN** the raw content MUST NOT enter model input
- **THEN** the runtime MUST persist a bounded diagnostic context result

### Requirement: Runtime sources SHALL retain semantic authority
The runtime MUST map policy-producing sources to developer authority and factual or untrusted sources to contextual-user authority without allowing untrusted content to elevate itself.

#### Scenario: Permission and hook context are assembled
- **WHEN** a turn has execution-policy state and ordinary `user_prompt_submit` hook context
- **THEN** permission and sandbox guidance MUST use developer authority
- **THEN** ordinary hook context MUST use contextual-user authority

### Requirement: Cache class SHALL NOT control persistence
Static, dynamic, and ephemeral cache classes MUST affect ordering, cache behavior, and activation only; every fragment included in a model request MUST remain durably reconstructable.

#### Scenario: Ephemeral hook context enters one provider step
- **WHEN** ephemeral hook context is included in a provider request
- **THEN** its complete model-visible value and metadata MUST be persisted
- **THEN** later activation rules MAY omit it only through an explicit durable request shape or context boundary

### Requirement: Current user intent SHALL retain final contextual position
Provider request construction MUST place reference scaffolding before the current user intent while preserving later steering inputs as later real user messages.

#### Scenario: Dynamic context accompanies a user request
- **WHEN** workspace, memory, or hook context is active for a submitted user request
- **THEN** the request manifest MUST order those contextual fragments before the current user item
- **THEN** it MUST preserve the user's text without rewriting it

### Requirement: Instruction budgeting SHALL be deterministic and preserve required content
The Node runtime MUST budget the complete logical model input deterministically and MUST preserve base rules, required permission constraints, tool schemas, and current user intent.

#### Scenario: Context exceeds the model budget
- **WHEN** the assembled logical input exceeds the configured prompt budget
- **THEN** optional sections MUST be trimmed in a deterministic documented order
- **THEN** the persisted request manifest MUST reference the exact trimmed values sent to the provider

### Requirement: Provider adapters SHALL preserve the instruction contract
Responses, Chat Completions, and Anthropic Messages projections MUST preserve semantic authority and logical ordering, using explicit compatibility fallback only where a wire protocol lacks a native role.

#### Scenario: The same contract targets multiple protocols
- **WHEN** an equivalent instruction contract is projected to each supported protocol
- **THEN** base, developer, contextual-user, conversation, and tool semantics MUST remain equivalent

### Requirement: Main agents and subagents SHALL share instruction assembly
Main agents and subagents MUST use the same base, workspace, policy, context persistence, budgeting, and provider projection pipeline.

#### Scenario: Parent spawns a child agent
- **WHEN** a child session is created
- **THEN** it MUST inherit the product and workspace contract through immutable snapshots or references
- **THEN** its path, task, tool scope, and narrowed authority MUST be appended as developer context without an agent profile
