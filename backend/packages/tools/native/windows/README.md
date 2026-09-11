# Windows sandbox helper

Release builds place `mycli-windows-sandbox.exe` in this directory. The Node
runtime resolves the helper from the packaged `@mycli/tools` assets. The helper
validates the protocol request and setup state before restricted commands can
run. On first use, it requests elevation, completes its one-time setup, and
verifies the resulting state before it starts the restricted command.

The helper's host-facing recovery operations are:

- `--handshake`: bounded, read-only protocol and setup state.
- `--ensure-setup`: serialize setup, request UAC when needed, and verify the result.
- `--reset`: clear only the encrypted credential and setup markers under the same setup lock.

`--reset` intentionally preserves the dedicated local account and all firewall/WFP restrictions.
The public `mycli sandbox setup|reset` commands preview these operations and require `--confirm`;
users should not invoke the packaged helper directly.
