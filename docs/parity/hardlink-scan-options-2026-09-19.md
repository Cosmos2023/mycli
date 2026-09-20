# Hardlink scan options (2026-09-19)

Follow-up to the MXC probe: can the launch-time hardlink alias scan become cheap
without changing its security semantics?

## Measurement: NTFS USN / MFT bulk enumeration needs an administrator

Probe: `native/windows-sandbox-helper/experiments/usn/usn_probe.cpp` (read-only;
`CMakeLists.txt` next to it), run from a UAC-filtered non-elevated shell
(`TokenIsElevated=0`, `BUILTIN\Administrators` = deny only).

```
volume=\\.\D: elevated=0
  open[generic_read] failed error=5
  open[read_data+attributes] failed error=5
  open[attributes_only] ok query_journal=0 error=1
enum skipped: CreateFileW(GENERIC_READ) failed error=5
```

`fsutil usn` from the same shell:

| Command | Result |
| --- | --- |
| `fsutil usn queryjournal D:` | exit 0 (journal ID, NextUsn readable) |
| `fsutil usn enumdata 0 0 3 D:` | `Error 5: Access is denied.` |
| `fsutil usn readjournal D: csv` | `Error 5: Access is denied.` |

Conclusion: `FSCTL_QUERY_USN_JOURNAL` is available to a standard user, but
`FSCTL_ENUM_USN_DATA` and `FSCTL_READ_USN_JOURNAL` both require elevation.
The PSEC backend deliberately needs no UAC, so a USN-based index (initial build
and deltas) cannot be used by the current per-command helper.

## What remains

| Option | First command | Later commands | Needs admin | Security |
| --- | --- | --- | --- | --- |
| Current cache (`MYCLI_SANDBOX_HARDLINK_SCAN_TTL_MS`, default 15 min) | ~6 s per TTL window | ~0.19 s | no | stricter than Codex |
| Raise the TTL (e.g. 1 h / 24 h) | ~6 s per that window | ~0.19 s | no | unchanged, longer staleness window |
| Parallelize the existing per-file scan | estimated 1-2 s | ~0.19 s | no | unchanged |
| Long-lived watcher process keeping an index | ~6 s once per session | ~0.19 s | no | unchanged, adds a resident process |
| Drop the scan (Codex behaviour) | ~0.19 s | ~0.19 s | no | matches shipped Codex; alias write-through is possible |
| USN/MFT index | rejected | rejected | **yes** | unchanged |

## Decision (implemented)

The writable-root scan was removed (option "drop the scan"). Rationale:

- The shipped Codex Windows sandbox accepts the same case, so this is the
  Codex-aligned behaviour.
- USN/MFT indexing is unavailable without elevation, so the only alternatives
  were a slower scan or a resident index process.
- PSEC still denies every link creation inside the sandbox, so only an actor
  outside the sandbox can place such an alias.

Measured after the change (same host, `cmd.exe /d /s /c "echo ok"` and
PowerShell `Write-Output ok` through `prepareSandboxedProcess`):

- sandboxed command: 180-200 ms, first command included (previously ~6 s cold,
  ~190 ms warm with the TTL cache);
- the hardlink fixture (`workspace\alias.txt` -> `outside\secret.txt`) is now
  accepted (exit 0) instead of failing with
  `psec_hardlink_crosses_write_boundary`.

Denied, read-only and protected metadata trees still expand their hardlink
aliases before launch, and the Windows sandbox gate (13/13 platform plus 7/7
PSEC parity) passes with the reduced helper.

## Reproduce

```powershell
$cmake = "D:/softwares/msvs/2022/BuildTools/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe"
& $cmake -S native/windows-sandbox-helper/experiments/usn -B native/windows-sandbox-helper/experiments/usn/build -G "Visual Studio 17 2022" -A x64
& $cmake --build native/windows-sandbox-helper/experiments/usn/build --config Release
& native/windows-sandbox-helper/experiments/usn/build/Release/usn-probe.exe "\\.\D:"
```
