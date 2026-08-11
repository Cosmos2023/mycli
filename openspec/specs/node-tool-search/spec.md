# node-tool-search Specification

## Purpose
TBD - created by archiving change add-node-web-fetch-tool-search. Update Purpose after archive.
## Requirements
### Requirement: Deferred integration catalog
The Node composition SHALL keep built-in, `Skill`, and subagent coordination tools directly provider-visible while withholding eligible MCP and plugin definitions in an immutable deferred catalog; all corresponding adapters SHALL remain registered and route conflicts SHALL still fail closed.

#### Scenario: Initial provider request with integrations
- **WHEN** MCP and plugin tools are configured for a new turn
- **THEN** the provider receives the fixed direct tools plus `tool_search`, but not the deferred MCP/plugin definitions

#### Scenario: Core extension routes remain direct
- **WHEN** skills and subagent coordination are enabled
- **THEN** `Skill`, `spawn_agent`, and the other coordination definitions remain directly visible without requiring search

#### Scenario: Duplicate deferred route
- **WHEN** a deferred registration conflicts with any built-in, direct, or other deferred route
- **THEN** composition fails with the existing duplicate route/id diagnostic rather than silently replacing a tool

### Requirement: Bounded deterministic search
The runtime SHALL expose `tool_search` with a required non-empty `query` and optional integer `limit`; SHALL search deferred route name, description, source, and bounded origin metadata; and SHALL return at most sixteen deterministic results.

#### Scenario: Search by route or description
- **WHEN** query terms match a deferred tool's route name or description
- **THEN** the result includes that tool with its route, source, description, and bounded origin summary

#### Scenario: Search by integration origin
- **WHEN** query terms match an MCP server or plugin identifier in origin metadata
- **THEN** matching tools are eligible and sorted by score then stable route/id tie-breakers

#### Scenario: Empty query or invalid limit
- **WHEN** the query is blank or the limit is outside 1 through 16
- **THEN** the router or adapter returns a bounded invalid-arguments result without activating tools

#### Scenario: No matching deferred tool
- **WHEN** no catalog entry matches the query
- **THEN** `tool_search` succeeds with an empty result and does not change provider exposure

### Requirement: Persist-before-expose activation
A successful `tool_search` SHALL return a bounded `ToolActivationEffect` containing stable route names; storage SHALL validate and append that effect with the tool result before runtime exposure changes; and the next provider step SHALL include the resolved definitions only in `ProviderRequest.tools`.

#### Scenario: Successful activation
- **WHEN** `tool_search` selects one or more deferred tools and tool-result persistence succeeds
- **THEN** those definitions are added to the next provider request in deterministic catalog order

#### Scenario: Persistence fails
- **WHEN** appending the `tool_search` result/effect fails
- **THEN** no selected definition becomes provider-visible and the turn fails with `persistence_error`

#### Scenario: Provider calls newly activated tool
- **WHEN** the provider calls an activated route on a later step in the same turn
- **THEN** the existing router validates and executes its already-registered adapter

#### Scenario: Provider calls non-activated deferred tool
- **WHEN** the provider calls a deferred route that has not appeared in the request's exposed definitions
- **THEN** runtime rejects the response as a tool protocol failure before execution

#### Scenario: No schema message injection
- **WHEN** a search result is persisted and the next provider request is assembled
- **THEN** tool schemas appear only in the request tool-definition array and no synthetic user, developer, context, or tool-result message contains copied schemas

### Requirement: Durable turn-local recovery
The runtime SHALL restore activations for the current turn from allowlisted durable tool-result metadata, resolve names against the current allowed catalog, and ignore stale or unknown names. Activations SHALL not automatically carry into a later user turn.

#### Scenario: Approval continuation reconstructs context
- **WHEN** a later activated integration call suspends for approval and the continuation rebuilds its execution context
- **THEN** all previously persisted activations from that turn remain provider-visible after approval resolution

#### Scenario: Catalog changed after restart
- **WHEN** persisted activation metadata names a tool absent from the current catalog
- **THEN** the runtime ignores that name without fabricating a definition or failing the session

#### Scenario: Next user turn begins
- **WHEN** a completed turn activated deferred tools and a new turn starts
- **THEN** the new turn returns to direct exposure plus `tool_search` until it performs its own search

### Requirement: Continuation and cache correctness
The runtime SHALL invalidate provider continuation state only when activation adds a new definition, SHALL recompute the durable request signature from the expanded tool list, and SHALL keep the expanded list stable for the remainder of the turn.

#### Scenario: New schema changes request signature
- **WHEN** persisted search results add a previously hidden definition
- **THEN** the next provider step uses canonical replay with a new durable request signature and no unsafe previous-response continuation

#### Scenario: Repeated search selects visible tools
- **WHEN** a later `tool_search` returns only definitions already activated
- **THEN** exposure order and request schema remain unchanged and no additional continuation invalidation is required

### Requirement: Manifest metadata
The built-in manifest SHALL classify `tool_search` under a discovery toolset with low risk, `auto_allow` approval, parallel-call support, and no filesystem, network, or process effects.

#### Scenario: Inspect built-in manifest
- **WHEN** a client reads the built-in or combined manifest
- **THEN** `tool_search` has stable id `builtin:tool_search`, its bounded schema and effect metadata, and exactly one matching route

