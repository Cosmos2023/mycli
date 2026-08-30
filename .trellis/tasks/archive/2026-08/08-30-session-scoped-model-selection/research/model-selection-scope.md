# Model Selection Scope Research

## Current mycli behavior

- `model.select` accepts provider, protocol, model, base URL, reasoning effort, and collaboration
  mode, but has no scope field.
- The Node backend always calls `writeUserProviderConfig`, then re-resolves the user configuration,
  and finally persists the same selection into `session_preferences`.
- The TUI model selector has model and optional reasoning stages only. Its callback cannot express
  whether the selection is session-local or a user default.
- Failed backend selection already keeps the selector mounted and renders an inline error. That
  interaction should remain unchanged.

## Local Codex evidence

- Codex models runtime updates and persistent defaults as distinct events:
  `UpdateModel` / `UpdateReasoningEffort` versus `PersistModelSelection`.
- Some temporary paths deliberately call `apply_model_and_effort_without_persist`, proving the
  runtime/persistence boundary is intentional rather than an implementation accident.
- Plan-mode reasoning adds an explicit scope prompt when a choice could update global defaults.

Relevant source:

- `/Users/cosmos/Downloads/codex-main/codex-rs/tui/src/chatwidget/model_popups.rs`
- `/Users/cosmos/Downloads/codex-main/codex-rs/tui/src/chatwidget/tests/plan_mode.rs`

## Approaches considered

### A. Explicit scope in the selection contract (selected)

Add `session | user` to the gateway request and make the TUI scope choice a final selector stage.
The backend always persists session preferences and writes user configuration only for `user`.

Pros:

- Scope is visible and testable across TUI, gateway, runtime, storage, and config.
- Permanent writes require an explicit user action.
- Future `/settings` and CLI scope controls can reuse the same vocabulary.

Cons:

- Changes the gateway contract and several tests.
- Adds one interaction step to model selection.

### B. Session-only model selector plus a separate settings command

Make `/model` always session-only and require `mycli config set` for defaults.

Pros: smallest runtime change and safest default.

Cons: does not satisfy the plan's discoverable `Make user default` journey and makes the TUI less
capable than the CLI.

### C. Modifier key for persistence

Use Enter for session and a modified key for persistence.

Pros: fewer visible steps for experienced users.

Cons: poor discoverability, fragile across terminals, and inconsistent with the selector's existing
keyboard model.

## Selected boundary

- Scope is a closed `session | user` value.
- Missing scope defaults to `session` for backward-compatible callers and safer behavior.
- The TUI final scope stage defaults to `session`.
- Both scopes save durable session preferences so resume is stable.
- Only `user` calls the user-config writer and updates the backend's default preferences.
- A failed user-config write does not mutate active session preferences or dismiss the selector.
- Responses report the applied scope without exposing config paths, credentials, or submitted
  secret values.

## Edge cases

- Selecting the current model is allowed and remains idempotent.
- A missing credential fails before either session or user state is changed.
- Unsupported reasoning effort fails before persistence.
- Inline `/model ...` requests that do not specify a scope remain session-local.
- Resume continues to use durable session preferences without rewriting user defaults.
