# Codex Onboarding And Auth Parity Research

## Scope

This note compares the local Codex checkout at `/Users/cosmos/Downloads/codex-main` with mycli's
current Node/TypeScript startup, setup, and credential-management paths. It is behavioral evidence
for the unified onboarding task, not a requirement to copy Codex's Rust structure.

## Codex Evidence

- `codex-rs/tui/src/onboarding/onboarding_screen.rs` builds an ordered `Vec<Step>` beginning with
  Welcome and conditionally appending Auth and Trust. Rendering and input stop at the first
  in-progress step, so only required stages become active.
- Canceling while authentication is active marks onboarding complete and exits. Codex does not
  leave an unauthenticated composer available after a canceled required-auth step.
- Trust is persisted only after the trust choice succeeds. A failed write keeps the trust widget
  active and shows a bounded error.
- `codex-rs/cli/src/main.rs` exposes `login`, `login status`, and `logout` as management commands.
  `--with-api-key` is a boolean switch; the secret is never an argv value.
- `codex-rs/cli/src/login.rs` rejects `--with-api-key` when stdin is a terminal, reads the complete
  secret from piped stdin, trims it, rejects empty input, and reports only bounded status text.
- Login status and logout inspect or mutate the local credential store. They do not require a
  provider request.

## Current mycli Evidence

- `tui/mycli-shell/src/shell-runtime.ts` currently chains Trust -> Login -> Model with separate
  selector methods. Permission selection remains a slash-command/editor action and there is no
  Welcome or Ready stage.
- Startup cancellation already exits for required Trust or Login, while submit-time credential
  recovery keeps the existing composer mounted. This distinction should remain.
- `backend/apps/mycli/src/management/setup.ts` owns a separate provider/base URL/model/API-key
  wizard. In non-TTY mode it consumes a sequence of line prompts and can wait indefinitely when no
  explicit input contract was supplied.
- Setup currently writes provider config before the API key. If credential persistence fails, the
  new config can remain, so the pair is not transactional.
- `backend/packages/config/src/auth-store.ts` exposes only `readApiKey` and `writeApiKey`. It has no
  typed provider-free status or delete operation.
- `backend/apps/mycli/src/management/parser.ts` and `types.ts` expose `setup` but no login status,
  login, or logout management commands.
- Gateway operations already provide the authoritative primitives for saving an API key, selecting
  a model and scope, setting workspace trust, and selecting permissions. The TUI should coordinate
  those operations instead of creating another persisted store.

## Decision

Implement one explicit onboarding coordinator in the TUI over the existing selectors and gateway
operations. The coordinator owns stage order and pending in-memory choices; backend/config modules
remain authoritative for durable state.

The ordered stages are:

1. Welcome, shown only when startup authentication is missing.
2. Credential/provider.
3. Model, reasoning effort, and session-only versus user-default scope.
4. Optional connectivity validation, defaulting to Skip so offline setup remains valid.
5. Workspace trust when unresolved.
6. Permission preset for a fresh onboarding journey.
7. Ready, then mount and focus the composer.

Only required stages are queued. A normal startup with complete auth and resolved trust goes
directly to the composer. Submit-time `auth_required` recovery continues to use the focused login
flow and must not restart onboarding.

Cancellation is step-scoped, matching the trust model of Codex's ordered flow: canceling an active
stage performs no write for that stage and exits if the stage is required for a usable startup.
Previously confirmed durable choices remain in place. The provider config plus stored credential is
one logical replacement transaction and must restore the previous bytes if either write fails.

Add provider-free CLI management commands:

- `mycli login status [--json]`
- `mycli login --with-api-key [--provider <id>] [--auth-ref <ref>] [--json]`
- `mycli logout [--provider <id>] [--auth-ref <ref>] [--json]`

`login --with-api-key` reads the secret only from non-TTY stdin. A direct API-key argv option is
invalid and must return guidance without echoing the submitted value. Status and logout never call
the provider. Existing environment credentials are reported as environment-sourced and logout
does not claim to remove them.

## Risks And Test Focus

- Trust must still gate repository config and integrations until a successful trust write and
  backend reload; an onboarding coordinator must not activate project-owned inputs early.
- Existing sessions must keep session-scoped model/reasoning selections without rewriting user
  defaults.
- Authentication replacement and deletion must preserve unrelated auth references, file mode, and
  valid bytes on failure.
- TUI tests should cover queued-stage reduction, Esc at each stage, save failures, draft retention,
  ready focus, and submit-time recovery staying focused.
- CLI tests should cover TTY rejection, empty stdin, piped stdin, malformed auth files, custom auth
  references, environment-only credentials, JSON redaction, and provider-free execution.
