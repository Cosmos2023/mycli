# Startup Authentication Readiness Research

## Compared Behavior

### Local Codex

- `codex-rs/tui/src/lib.rs` resolves login status before constructing the main application and runs
  onboarding when an auth-requiring provider is not authenticated or directory trust is undecided.
- `codex-rs/tui/src/onboarding/onboarding_screen.rs` coordinates welcome, authentication, and trust
  as ordered steps. Canceling active authentication exits instead of exposing an unusable composer.
- Configuration is reloaded after login/trust so the running process observes the persisted result.
- Composer submission separately refuses or queues input while the session is not configured; UI
  readiness is not treated as the only enforcement boundary.

### Current mycli

- The Node bootstrap already returns provider rows with a bounded `configured` boolean, but the
  value currently observes only credentials stored under the provider id. It misses the current
  environment credential, a custom `auth_ref`, and legacy-compatible resolved credentials.
- `turn.submit` is synchronous at the gateway boundary and reserves/persists a turn before provider
  creation eventually reports `auth_error`.
- The TUI already restores composer input when `onSubmit` rejects and already has reusable login,
  model, and trust selectors.
- Gateway request handling already supports Promise-returning handlers, so the submit boundary can
  perform an asynchronous provider-free credential check before reserving a turn.
- All current provider registries require `apiKey`; an anonymous compatible-provider exception does
  not exist in the current transport contract.

## Feasible Approaches

### A. TUI-only startup check

Open the existing login selector when bootstrap says the current provider is unconfigured.

- Smallest visual change.
- Insufficient authority: non-TUI clients can bypass it and credentials can disappear after
  bootstrap.

### B. Backend-only submit rejection

Resolve credentials immediately before `turn.submit` and return `auth_required` before reserving a
turn.

- Correct enforcement and clean persistence behavior.
- First-run users still reach a composer that looks ready and discover the problem only after Enter.

### C. Startup guidance plus backend enforcement (selected)

Expose a current, secret-free readiness projection during bootstrap and independently re-check it at
`turn.submit`. The TUI sequences trust then login before focusing the composer. A later
`auth_required` restores the draft and reopens login without adding a generic transcript error.

- Matches Codex's staged startup behavior while preserving a server-side invariant.
- Reuses current components and requires no provider call.
- Adds a small gateway/control contract and focused TUI coordination.

## Edge Decisions

- Readiness sources are bounded metadata only: `environment`, `stored`, `legacy_config`, or
  `missing`. Secret values never cross the gateway.
- The authoritative check resolves the active session preferences, workspace trust, current
  environment, and credential store each time.
- A custom model-catalog `auth_ref` must be retained through recovery; saving under the provider id
  alone would leave the selected model unusable.
- Canceling startup login exits, like Codex. Canceling recovery after a later submission attempt
  returns to the composer with the draft intact.
- Successful recovery does not automatically transmit the retained prompt. The user presses Enter
  again, which prevents surprising or duplicate submissions.
- Connectivity validation remains explicit and offline startup remains possible.

## Relevant Files

- `backend/packages/config/src/settings.ts`
- `backend/packages/config/src/auth-store.ts`
- `backend/apps/mycli/src/node-runtime/node-backend.ts`
- `backend/apps/mycli/src/node-runtime/node-gateway.ts`
- `tui/mycli-shell/src/gateway.ts`
- `tui/mycli-shell/src/shell-runtime.ts`
- `tui/mycli-shell/src/components/login-flow.ts`
- `/Users/cosmos/Downloads/codex-main/codex-rs/tui/src/lib.rs`
- `/Users/cosmos/Downloads/codex-main/codex-rs/tui/src/onboarding/onboarding_screen.rs`

