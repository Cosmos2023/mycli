# Check Results

Date: 2026-05-31

## Passed

- `uv run pytest tests/unit/services/test_extension_manifest.py tests/unit/cli/node_tui/test_gateway.py tests/unit/cli/test_main.py -q`
  - Result: `104 passed in 1.79s`
- `npm --prefix tui/node test`
  - Result: `122 pass`
- `npm --prefix tui/node run typecheck`
  - Result: passed
- `uv run ruff check src/mycli/domain/runtime/gateway_contract.py src/mycli/cli/node_tui/gateway.py src/mycli/services/extensions/manifest.py tests/unit/services/test_extension_manifest.py tests/unit/cli/test_main.py tests/unit/cli/node_tui/test_gateway.py`
  - Result: `All checks passed!`

## Contract Evidence

- `ExtensionManifestService().manifest()["rpc_methods"]` names now equal the
  domain gateway contract RPC set.
- `ExtensionManifestService().manifest()["event_streams"]` names now equal the
  domain gateway contract event stream set.
- Manifest counts after convergence: `rpc_methods=16`, `event_streams=23`.
- `runtime.event` and `session.changed` are advertised as supported event
  streams.
- TypeScript `KnownGatewayEvent` now includes `session.changed` with
  `session_id` payload typing.

## Architecture Note

An initial implementation tried to import gateway constants from
`mycli.cli.node_tui.gateway` inside the extension manifest service, which caused
an application/service/CLI circular import. The final implementation puts the
shared contract constants in `mycli.domain.runtime.gateway_contract`, then has
both the CLI gateway and service manifest read from that domain module.
