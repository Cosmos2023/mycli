# Node Runtime M0 Contract Foundation Smoke Report

Date: 2026-08-03
Commit under test: `55f3a965669a`

## Scope

Verified the M0 shared-contract foundation for the staged Python-to-Node.js runtime migration:

- the root npm workspace installs the contracts package and existing Node TUI together;
- Draft 2020-12 gateway schemas generate deterministic TypeScript declarations and Python
  package resources;
- Ajv and Python `jsonschema` accept and reject the same sanitized fixture corpus;
- Python and Node gateway boundaries consume the canonical contract without changing provider
  request or response behavior;
- cross-platform CI includes contract drift, lint, test, and type-check gates.

## Environment

| Tool | Version |
| --- | --- |
| Node.js | `v24.14.1` locally; CI targets `22.19.0` |
| npm | `11.11.0` |
| Python | `3.13.12` |

## Verification

| Command | Result |
| --- | --- |
| `npm ci --cache /tmp/mycli-node-runtime-npm-cache --offline` | PASS: 153 packages installed, 0 vulnerabilities |
| `npm run contracts:check` | PASS: generated TypeScript and Python resources have no drift |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm test --workspace @mycli/contracts` | PASS: 11 tests |
| `uv run pytest tests/unit/domain/runtime/test_gateway_contract.py tests/unit/domain/runtime/test_gateway_contract_resources.py tests/unit/domain/runtime/test_gateway_contract_fixtures.py tests/unit/cli/node_tui/test_protocol.py tests/unit/cli/node_tui/test_gateway.py tests/integration/test_node_tui_gateway.py -q` | PASS: 161 tests |
| `uv run ruff check src/mycli tests` | PASS |
| `uv run mypy src/mycli` | PASS: 319 source files |
| `uv run pytest -q` | PASS: 2454 passed, 30 skipped in 96.41s |
| `uv build --wheel` plus wheel archive inspection | PASS: wheel built and contains both generated JSON contract resources |

The canonical catalog contains 33 RPC methods and 36 event streams. The shared corpus contains
6 fixture cases, exercised by both Ajv and Python `jsonschema`.

## Node 24 Compatibility Note

The root `npm test` command completed the contracts suite with 11 passing tests and the TUI suite
with 358 passing tests plus one known failure:

`native chat runtime appends transcript without fullscreen control sequences`

On local Node `v24.14.1`, readline emits `ESC[1A`, which violates that pre-existing assertion.
The failure is unrelated to the M0 contract boundary changes. Cross-platform CI remains pinned
to the supported minimum Node `22.19.0`; this report does not claim that CI was run locally.

## Packaging Evidence

The built Python wheel includes both generated resources copied from the canonical schema source:

- `mycli/schemas/generated/catalog.json`
- `mycli/schemas/generated/gateway-events.schema.json`

No credentials, provider payloads, environment values, or private local paths are recorded here.

## Live API

Live API: not applicable. M0 changes no provider request or response behavior, so a real provider
call would not add a meaningful assertion to this milestone.
