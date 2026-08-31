# Current UX Test Coverage

## Finding

The repository already has provider-free coverage for nearly every OMX Phase 0 journey. The
missing foundation is not another end-to-end framework; it is a canonical evidence manifest that
keeps those distributed tests discoverable, adds explicit UX budgets, and fails when canonical
command/settings surfaces drift from help and documentation.

## Existing Journey Evidence

- Fresh setup and cancellation: `backend/apps/mycli/test/setup.test.ts` and TUI startup auth/trust
  tests in `tui/mycli-shell/test/shell-app.test.ts`.
- Missing credentials: backend submit-time readiness tests in
  `backend/apps/mycli/test/node-gateway.test.ts` and TUI draft-preserving recovery tests.
- Malformed user config and untrusted project config:
  `backend/apps/mycli/test/config-management.test.ts` plus config package precedence tests.
- Session-only model selection: `backend/apps/mycli/test/node-backend.integration.test.ts` and
  `tui/mycli-shell/test/model-selector.test.ts`.
- Permission changes: gateway policy reconfiguration tests and the TUI permission selector suite.
- Resume repair: gateway preview/apply tests, session service tests, and the TUI repair selector.
- Narrow/CJK/IME behavior: broad shell-app, selector, command result, file change, markdown, and
  hardware-cursor regressions.
- Windows sandbox readiness: management status tests and tools package handshake/readiness tests.
- Startup timing: `StartupProfiler` emits bounded stage-only snapshots; native PTY smoke already
  applies a five-second readiness ceiling. Background update startup tests prove refresh is not
  awaited.

## Existing Drift Evidence

- Slash commands have a frozen parity matrix and `docs/commands.md` alignment test.
- Settings use `SHELL_SETTING_DESCRIPTORS` and a versioned runtime settings catalog.
- Root CLI help and the management parser still maintain separate command lists; the current help
  test checks only a subset and can miss a new management command.
- Appearance setting keys are documented, but there is no direct descriptor-to-doc assertion.

## Selected Approach

1. Add a versioned JSON UX baseline manifest listing required journeys, exact test evidence,
   supported platform variants, privacy policy, and explicit budgets.
2. Add one focused test that validates the manifest, referenced test declarations, redaction-safe
   content, management CLI help/catalog parity, and setting descriptor documentation.
3. Export the existing management command names and root help string so the drift test consumes
   canonical values without parsing TypeScript source.
4. Add a root `test:ux-contracts` command and a sanitized baseline report explaining what is
   enforced versus locally measured.

This stays within Phase 0: no onboarding, migration, sandbox setup, accessibility preference, or
release behavior is implemented here.
