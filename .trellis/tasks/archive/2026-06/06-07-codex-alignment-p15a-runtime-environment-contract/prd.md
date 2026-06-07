# Codex Alignment P15a Runtime Environment Contract

## Problem

P14 made Bash/run_shell execpolicy enforceable and diagnosable, but the model
still sees only a minimal `Workspace root` environment context. Codex-style
runtime behavior uses a bounded model-visible environment/permissions contract
to tell the model what local execution posture it is operating under, while
actual safety still comes from runtime enforcement.

## Goal

Add a bounded, typed runtime environment contract that is visible to the model
through the existing environment context section and request shape. The contract
must summarize workspace, sandbox, approval, and execpolicy posture without
printing raw environment values, secrets, raw command text, raw rule patterns, or
provider payloads.

## Scope

- Add a typed runtime environment contract/snapshot for model-visible
  environment facts.
- Include bounded fields:
  - workspace root
  - filesystem policy
  - network policy
  - shell policy
  - approval policy
  - command policy
  - file policy
  - tool policy
  - execpolicy status/count/source summary
- Render this contract from `TurnContextAssembler` under
  `ENVIRONMENT_CONTEXT`.
- Keep the environment context dynamic, not stable prefix.
- Keep current user input at the request tail.
- Add tests that prove the contract appears in model-visible context and
  request shape, with bounded redaction.
- Update specs/docs for the model-visible runtime contract.

## Non-goals

- No OS-level sandbox backend.
- No environment allowlist enforcement.
- No env var dumping or raw environment snapshot.
- No non-shell execpolicy expansion.
- No rule management UI.
- No compact/rehydration changes.
- No provider API calls.

## Acceptance

- Unit tests prove environment context includes bounded sandbox/approval/
  execpolicy summary.
- Unit tests prove raw execpolicy pattern tokens and secret-like values are not
  rendered.
- Request-shape tests prove environment context remains dynamic and current user
  input remains last.
- Existing P14 execpolicy tests keep passing.
- `uv run ruff check src tests evaluation` passes.
- `uv run mypy src/mycli` passes.
- `uv run pytest -q` passes.
- Context/provider-cache smoke does not regress.
- Compact/rehydration implementation files remain untouched.
