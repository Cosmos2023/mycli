# Approval Decision Choice Contract

## Problem

`approval.respond.choice` is part of the Hermes-like runtime/TUI approval
state machine, but the current protocol contract still exposes it as an
unconstrained string. Runtime, TUI, extension, and future ACP clients need a
stable machine-readable decision-choice taxonomy.

Hermes-agent is the maturity reference only. Do not copy Hermes code.

## Scope

Baseline branch: `feature/mycli-foundation-hardening-audit`

Default integration policy: do not merge to `main`.

This slice covers Tool / approval / safety foundation and Runtime event
contract parity by making approval decision choices a cross-language contract.

## Requirements

- Define canonical approval decision choices in the Python domain runtime
  contract:
  - `approve_once`
  - `reject`
  - `allow_session`
- `approval.respond` payload schema must enumerate `choice` with those values.
- `approval.request` must expose enough schema metadata for clients to know
  option `choice` values are approval decision choices.
- TypeScript protocol types must expose the same `ApprovalDecisionChoice`
  union.
- TypeScript `ApprovalRespondPayload.choice` and `ApprovalOptionPayload.choice`
  must use the shared union.
- TypeScript `GATEWAY_EVENT_PAYLOAD_CONTRACTS["approval.respond"]` must
  enumerate the same choices so the Python-vs-TS contract test catches drift.
- Existing approval behavior remains compatible:
  - `approval.respond` accepts the canonical choice values.
  - Unsupported choices still fail with `invalid_params`.
  - Compatibility method `decision.resolve` remains unchanged.
- Update the runtime/TUI gateway spec with the choice taxonomy.

## Acceptance Criteria

- Python unit test proves `approval.respond.choice` schema includes the
  canonical enum.
- Extension manifest test proves the enum is published for external clients.
- Node protocol contract test proves TypeScript enum metadata matches Python
  manifest schemas.
- TypeScript reducer or protocol test proves typed approval responses preserve
  canonical choices.
- Focused checks pass:
  - `uv run pytest tests/unit/domain/runtime/test_gateway_contract.py tests/unit/services/test_extension_manifest.py tests/unit/cli/node_tui/test_gateway.py -q`
  - `npm --prefix tui/node test -- protocol`
  - `npm --prefix tui/node test -- reducer`
  - `npm --prefix tui/node run typecheck`
  - `uv run ruff check src/mycli/domain/runtime/gateway_contract.py tests/unit/domain/runtime/test_gateway_contract.py tests/unit/services/test_extension_manifest.py`
- Trellis research, PRD, implementation context, check context, and check
  results are present.
- Task is archived after verification.

## Non-goals

- No new approval UI panel or keybinding changes.
- No approval policy changes.
- No provider/tool runtime error taxonomy changes.
- No MCP, skills, subagent/multi-agent, or ACP productization.
- No merge to `main`.
