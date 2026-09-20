# MXC feasibility probe (2026-09-19)

Question: should mycli replace its own PSEC policy translation with Microsoft's
MXC (`@microsoft/mxc-sdk`), the component Codex integrates on Windows, to remove
the launch-time hardlink alias scan?

Probe: `native/windows-sandbox-helper/experiments/mxc/probe.mjs`
(`npm install @microsoft/mxc-sdk@0.8.0`, schema `0.8.0-alpha`). Host: the user's
Windows x64 machine, PSEC ready, Node 24.14.0.

## Raw results

| # | Case | Result |
| --- | --- | --- |
| – | `getPlatformSupport()` | `isSupported=true`, `availableMethods=["processcontainer"]`, `isolationTier="base-container"` |
| 1 | `cmd /c echo` inside the sandbox | exit 0, output delivered |
| 2 | Write a plain workspace file | exit 0, file updated |
| 3 | Write through a host-created hardlink `workspace/alias.txt` -> `outside/secret.txt` | **exit 0; `outside/secret.txt` changed to `CHANGED`** |
| 4 | `node -e ...` inside the sandbox | exit `3221225794` (`0xC0000142`, DLL init failed) |
| 5 | Read a `deniedPaths` path | exit 1, `拒绝访问。` |
| 6 | Egress `default: deny` with `curl https://example.com` | curl exit 6, "Could not resolve host" |
| 7 | Concurrent egress `allow` and `deny` peers | both ran; the allow peer reached the host |

## Findings

- MXC runs on this host, and its `processcontainer` backend enforces `deniedPaths`,
  egress default-deny, and divergent concurrent network policies.
- It did **not** deny the hardlink alias write: a pre-existing alias inside a
  writable root still reached the file outside the write roots. On this host the
  SDK path is therefore path-based for hardlinks, exactly like PSEC, so switching
  to it would not remove the reason mycli scans writable roots.
- `node.exe` could not start inside the sandbox (`0xC0000142`) even with
  `D:\node`, `%SystemRoot%`, `%WINDIR%`, and the SDK's tool paths granted
  read-only. A coding agent that cannot run `node`/`npm` inside its sandbox
  cannot use this entry point as-is.
- Codex does not use this SDK path either: its `mxc-sandbox` crate drives MXC's
  `BaseContainerRunner` directly in PSEC mode and explicitly avoids MXC's
  AppContainer dispatcher. That is closer to what mycli already implements than
  to what the SDK does here.

## Conclusion

Adopting `@microsoft/mxc-sdk` would not deliver the expected identity-based
hardlink behaviour and cannot currently run Node inside its sandbox on this host.
The probe does not support replacing mycli's backend with the SDK.

Remaining options, unchanged from the latency discussion:

- keep PSEC and make the alias snapshot incremental (NTFS USN journal) so the
  cold launch cost drops from seconds to a few hundred milliseconds;
- only if a future MXC build enforces file-identity writes in PSEC mode **and**
  supports Node inside the container, re-evaluate `BaseContainerRunner`
  integration (not the SDK) as a backend replacement.

## Reproduce

```powershell
cd native/windows-sandbox-helper/experiments/mxc
npm install @microsoft/mxc-sdk@0.8.0
node probe.mjs
```
