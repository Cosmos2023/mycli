# Windows sandbox helper

Release builds place `mycli-windows-sandbox.exe` in this directory. The Node
runtime resolves the helper from the packaged `@mycli/tools` assets. The helper
validates the protocol request and setup state before restricted commands can
run. On first use, it requests elevation, completes its one-time setup, and
verifies the resulting state before it starts the restricted command.

The helper's host-facing recovery operations are:

- `--handshake`: bounded, read-only protocol and setup state.
- `--ensure-setup`: serialize setup, request UAC when needed, and verify the result.
- `--reset`: reconcile recorded ACLs and clear credential/setup markers; refuse active helpers.
- `--repair`: stop processes, reconcile ACLs, refresh setup, and verify readiness.
- `--uninstall`: disable/stop owned accounts, remove tracked ACL/network state, profiles and accounts.

`--reset` intentionally preserves the dedicated local accounts and all firewall/WFP restrictions.
The public `mycli sandbox setup|reset|repair|uninstall` commands preview these operations and require `--confirm`;
users should not invoke the packaged helper directly.

Protocol v2 sends exact denied-read roots and an empty glob field: Node resolves globs before launch. `network=enabled` selects the online identity;
`network=disabled` selects the offline identity. A validated `network_proxy_port` selects a separate
proxy identity. All three keep the same restricted-token filesystem boundary. WFP's per-account
sublayers and per-logon dynamic exceptions prevent concurrent processes from sharing proxy authority.
The proxy exception is installed while the runner is suspended and is revoked when its host exits.

The handshake verifies credentials, restricted-token creation, live firewall/WFP filters, and
host access to the proxy sublayer. It has no hard-coded ready flag. Setup/reset and ACL preparation
are serialized without serializing command execution. Reset preserves accounts and network denies.

Build with CMake/Visual Studio, run `ctest`, install the helper in this directory, then run the
Windows platform suite after `mycli sandbox setup --confirm`. The reusable Windows CI workflow
also exercises reset/reinitialization on its disposable runner. Restricted launch failure never
falls back to an unrestricted host process.

From a Visual Studio developer PowerShell at the repository root:

```powershell
cmake -S native/windows-sandbox-helper -B native/windows-sandbox-helper/build -A x64
cmake --build native/windows-sandbox-helper/build --config Release
ctest --test-dir native/windows-sandbox-helper/build -C Release --output-on-failure
Copy-Item native/windows-sandbox-helper/build/Release/mycli-windows-sandbox.exe backend/packages/tools/native/windows/mycli-windows-sandbox.exe
```

On a disposable Windows development machine, verify the checkout without starting GitHub CI:

```powershell
npm ci
npm run dev -- sandbox setup --confirm
$env:MYCLI_WINDOWS_SANDBOX_SETUP_TESTS = "1"
$env:MYCLI_WINDOWS_SANDBOX_MAINTENANCE_TESTS = "1"
node --conditions=mycli-source --import tsx --test --test-reporter=spec backend/packages/tools/test/sandbox/windows-sandbox.platform.test.ts
```

Check each command's exit code before proceeding. Both opt-ins are required for release validation:
they exercise credential reset, repair, uninstall, and reinstallation, stopping sandbox processes
and modifying the dedicated accounts. The reusable Windows release gate enables both before
uploading its helper artifact.

An earlier revision passed native compilation, protocol/primitives tests and setup on Windows
Server 2022/2025. The current sources also support private desktops, bounded public-directory auditing, and ACL recovery.
Local Windows-target compilation is not runtime validation: the latest fixes still need MSVC and
Windows runtime verification; the complete
Shell, ConPTY and proxy suite has not passed yet. macOS tests do not satisfy the Windows gate.

See [Windows policy and maintenance](../../../../../docs/windows.md) for managed denied-read settings,
concurrent policy changes, upgrade limitations, and opt-in destructive maintenance tests.
