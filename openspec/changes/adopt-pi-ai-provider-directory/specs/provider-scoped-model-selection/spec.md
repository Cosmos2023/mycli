## ADDED Requirements

### Requirement: Model listing is provider-route scoped
The internal model-list contract SHALL require an exact activated provider route and SHALL return models belonging only to that route.

#### Scenario: Active provider models are requested
- **WHEN** `model.list` receives an activated provider route
- **THEN** it returns that route id and only model entries resolved for that route

#### Scenario: Provider is omitted
- **WHEN** `model.list` receives no provider route
- **THEN** it rejects the request instead of returning a global model list

#### Scenario: Provider is inactive or unknown
- **WHEN** `model.list` receives an unknown, inactive, malformed, or unserviceable route
- **THEN** it returns a bounded request error without changing an active turn or another route

### Requirement: Provider models come from the effective pi-ai catalog
The model-directory service SHALL resolve the selected route from the exact pinned pi-ai catalog and merge only declarations owned by that route.

#### Scenario: Catalog-backed route is loaded
- **WHEN** a selected route uses an installed pi-ai provider
- **THEN** the list contains its selected-protocol catalog models with pi-ai modalities, limits, reasoning levels, and compatibility facts

#### Scenario: User overrides a catalog model
- **WHEN** a user declaration matches an exact route/protocol/model identity
- **THEN** explicit user fields override catalog defaults without modifying another provider's same-named model

#### Scenario: Installed catalog gains a model
- **WHEN** a catalog-backed route has local model declarations without an explicit subset policy and the pinned pi-ai package adds a matching-protocol model
- **THEN** the new model is selectable alongside the provider-local overrides without rewriting `models.json`

#### Scenario: User narrows a catalog route
- **WHEN** a route sets `model_policy` to `subset` and declares a non-empty model set
- **THEN** only that subset is selectable even if the installed provider contains additional models

#### Scenario: Subset policy is incomplete
- **WHEN** a route sets `model_policy` to `subset` without a non-empty `models` object
- **THEN** configuration loading fails with a bounded catalog error

#### Scenario: Current model is uncatalogued
- **WHEN** the active exact route/protocol/model/endpoint is absent from catalog and user entries
- **THEN** the list includes it as a current custom model without inventing unsupported capabilities

### Requirement: Model selection is provider first
The interactive `/model` workflow SHALL resolve a usable provider route before presenting models and SHALL load models asynchronously for only that route.

#### Scenario: One usable provider exists
- **WHEN** `/model` opens with exactly one usable route
- **THEN** the provider stage is skipped and that route's models are loaded

#### Scenario: Multiple usable providers exist
- **WHEN** `/model` opens with more than one usable route
- **THEN** it immediately loads the current route's models and keeps the provider stage reachable with one back action

#### Scenario: No current provider can be resolved
- **WHEN** `/model` opens with multiple usable routes and no current or explicitly preferred route
- **THEN** it presents the provider stage before loading any model catalog

#### Scenario: User changes provider
- **WHEN** a provider is chosen in the selector
- **THEN** the TUI requests that provider's models and shows bounded loading, empty, or error state without displaying stale models from the previous provider

#### Scenario: User cycles provider from the model list
- **WHEN** the user invokes previous-provider or next-provider while viewing or loading a provider's models
- **THEN** the TUI directly loads the adjacent activated route without first opening the provider list

#### Scenario: Model response arrives late
- **WHEN** an earlier provider's asynchronous model response arrives after another provider was selected
- **THEN** the TUI discards the stale response and preserves the latest route selection

### Requirement: Common model switching is one confirmation
The interactive model selector SHALL provide a one-confirmation session-selection path while retaining explicit reasoning and persistence controls.

#### Scenario: Model is applied with the fast path
- **WHEN** the user presses Enter on a provider-scoped model
- **THEN** the selector submits it for the current session with its valid catalog default reasoning choice without opening another stage

#### Scenario: Catalog default reasoning is absent
- **WHEN** the fast path selects a model with supported reasoning choices but no valid catalog default
- **THEN** the selector uses the first supported choice deterministically

#### Scenario: Advanced options are requested
- **WHEN** the user presses Tab on a provider-scoped model
- **THEN** the selector opens reasoning when multiple choices exist and then scope, preserving the ability to choose a user default

#### Scenario: Fast-path selection fails
- **WHEN** the gateway rejects a fast-path selection
- **THEN** the model list stays open with one bounded error and allows exactly one new submission after retry

### Requirement: Credential readiness does not define the catalog
Provider and model discovery SHALL remain separate from credential readiness while traffic and final selection continue to require a usable mycli credential.

#### Scenario: Configured provider lacks a key
- **WHEN** a configured route appears in the provider selector without a usable credential
- **THEN** it remains identifiable and selection directs the user to login rather than silently removing its catalog

#### Scenario: Provider has a key
- **WHEN** a usable credential exists for an activated route
- **THEN** its provider-scoped models may be selected without causing another provider's models to load

### Requirement: Model commands never fall back across providers
Model lookup SHALL use the active or explicitly named provider route and SHALL never choose a same-named model from another route implicitly.

#### Scenario: Active provider contains the model
- **WHEN** `/model <name>` matches a model on the active route
- **THEN** that exact route/protocol/model/endpoint entry is selected

#### Scenario: Only another provider contains the model
- **WHEN** `/model <name>` has no match on the active route but another route has the same model id
- **THEN** the command reports the model unavailable on the active provider and does not switch providers

#### Scenario: Provider is explicit
- **WHEN** the command or interactive provider stage explicitly selects another activated route
- **THEN** model lookup occurs only within that route

### Requirement: Model selection preserves exact identity and scope
The system SHALL validate and persist provider route, protocol, model, normalized endpoint, reasoning choice, and session/user scope as one selection.

#### Scenario: Session scope is selected
- **WHEN** a valid provider-scoped model is applied to the session
- **THEN** the session preference changes without rewriting the user default and resumes with the same exact selection

#### Scenario: User scope is selected
- **WHEN** a valid provider-scoped model is made the user default
- **THEN** private configuration stores its non-secret route metadata and the selected auth reference without storing the API key

#### Scenario: Model entry is incomplete or foreign
- **WHEN** selection metadata does not match a currently resolved provider-scoped entry
- **THEN** the gateway rejects it and keeps the previous runtime/session selection

### Requirement: Provider-scoped model state remains bounded and consistent
The gateway and TUI SHALL associate each model list with its provider route and SHALL keep rendering stable for large, empty, loading, and failed provider catalogs.

#### Scenario: Large provider catalog is displayed
- **WHEN** a provider exposes many models
- **THEN** search and bounded visible rows operate within that provider without resizing or mixing route identity

#### Scenario: Selection succeeds
- **WHEN** a provider-scoped model selection is accepted
- **THEN** status, footer, current marker, model cache, and credential readiness identify the newly selected route consistently

#### Scenario: Selection fails
- **WHEN** model loading or selection returns a request error
- **THEN** the selector remains usable, shows one bounded error, and does not terminalize an active or persisted model turn
