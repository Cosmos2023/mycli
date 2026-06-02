# Local Hook CLI Design Research

## Existing shape

- `mycli.cli.main` currently parses global flags, eval flags, and one optional positional command with only `doctor`.
- `doctor` is handled before runtime construction, which is the correct model for hook management because hook list/approve/revoke must not require API keys or start the agent runtime.
- Configured hook discovery is already owned by `HookConfigRegistry(workspace_root, home_dir).discover()`.
- Consent state is already owned by `HookAllowlist(home_dir)` and the file format must not change.
- `/hooks` and doctor already consume the same registry/allowlist concepts, so the CLI should be a thin management surface rather than a new source of truth.

## Implementation direction

- Add a dedicated `mycli.services.hooks.management` service for read/approve/revoke operations. This keeps CLI formatting out of domain/config parsing and avoids putting allowlist mutation logic into `main.py`.
- Extend `HookAllowlist` with targeted write operations while preserving `write_allowed(specs)` for existing tests/smoke.
- Identify configured hooks by `source:hook_id:hook_point` for approve/revoke to avoid ambiguity between repo/user hooks or duplicate hook ids on different hook points.
- Human output should be bounded and avoid raw command strings. Show command digest and config metadata, not the full command.
- JSON output should include structured hook rows and config/allowlist issues.

## Safety notes

- `approve` and `revoke` mutate only `<home>/.mycli/hook-allowlist.json`.
- Built-in hooks are intentionally not manageable through this CLI.
- Bad hook config should be visible in list/inspect JSON and human output; approve/revoke should fail if the target configured hook cannot be resolved.
