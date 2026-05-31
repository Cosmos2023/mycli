# Runtime Contract TypeScript Schema Bridge

## Problem

`mycli` has Python runtime event schemas and TypeScript event payload types, but
the TypeScript side does not have a machine-readable payload requirement map.
The current Node test only checks event method names against Python. Required
payload fields can drift between Python manifest and TypeScript clients without
a direct cross-language test failure.

## Goal

Make runtime event contract drift between Python manifest schemas and Node TUI
protocol expectations fail in Node tests.

## Scope

- Add a TypeScript event payload contract map for all known gateway event
  methods.
- Include each event's required payload keys.
- Add TypeScript compile-time checks that the contract map and
  `KnownGatewayEventMethod` cover the same events.
- Add a Node test that loads Python `ExtensionManifestService().manifest()` and
  compares Python manifest required fields against the TypeScript contract map.
- Update runtime gateway contract spec to document that TS protocol contracts
  must stay aligned with Python manifest schemas.

## Non-Goals

- No code generation.
- No JSON schema validator dependency.
- No runtime validation in the hot path.
- No UI rendering changes.
- No merge to `main`.

## Acceptance

- `npm --prefix tui/node test -- client.test.ts` or equivalent Node test path
  fails before the TS contract map exists and passes after implementation.
- `npm --prefix tui/node test` passes.
- `npm --prefix tui/node run typecheck` passes.
- Relevant Python manifest/doctor tests continue passing.
