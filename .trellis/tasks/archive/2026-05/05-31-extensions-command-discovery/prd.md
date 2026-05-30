# Extensions Command Discovery

## Problem

`extension.manifest` gives external clients a machine-readable discovery
surface, but local users still need a simple way to inspect the same extension
capability status from the CLI/TUI command layer.

## Goal

Add a read-only `/extensions` slash command that summarizes the current
extension/integration manifest.

## Scope

- Add `TurnService.inspect_extensions()`.
- Route `/extensions` through the command handler.
- Add `/extensions` to help and slash completion.
- Keep the output human-readable and compact.
- Add unit tests.

## Requirements

- `/extensions` is read-only.
- Output includes the agent name, schema version, RPC method count, event stream
  count, and capability statuses.
- Output must show `extension.manifest` and `trace.export` as available
  discovery/integration surfaces.
- Output must show `extensions.lifecycle` and `acp.server` as unavailable until
  implemented.

## Non-Goals

- No dynamic extension lifecycle.
- No JSON dump command; use `extension.manifest` RPC for machine-readable data.
- No ACP server.
- No merge to `main`.

## Acceptance

- Command routing test covers `/extensions`.
- Completion and help list `/extensions`.
- TurnService formatting test covers key manifest fields.
- Relevant Python tests, lint, typecheck, and diff check pass.
