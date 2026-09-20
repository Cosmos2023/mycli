# Windows PSEC Verification

This report records the initial PSEC baseline. The later feature changes, new
artifact hashes and remaining failures are in
[Windows sandbox feature alignment](windows-sandbox-feature-parity.md).

Date: 2026-09-18. Environment: the user's existing Windows x64 machine, not a clean VM.

## Implementation

The native C++ helper now selects PSEC on supported hosts without legacy sandbox
provisioning. Existing account installations retain the restricted-token backend.
A PSEC setup marker pins the selected backend; unavailable enforcement fails closed.
The CLI and TUI both report `windows_psec`. Setup, reset, repair and uninstall use
the existing lifecycle and journal boundaries without provisioning PSEC accounts
or changing third-party ACLs or persistent host network rules.

The implementation was informed by pinned Codex/Microsoft MXC source, retaining
Node/CMake/MSVC. The Microsoft schema and FlatBuffers generator are pinned and
their licenses are included with the helper. See the [source comparison](windows-sandbox-host-optimization.md#codex-source-comparison-2026-09-17).

Policy enforcement includes workspace write roots, read-only mode, denied reads,
protected metadata, hardlink aliases, path pinning, offline/enabled/proxy networking,
private desktop, explicit inherited handles, and job-based descendant cleanup.
Missing protected paths are reserved and journaled because PSEC does not enforce
rules for absent paths. Concurrent requests must share their filesystem policy;
different proxy ports retain independent network policy.

Compatibility fixes include workspace-rooted PowerShell provider drives, lexical
Node module resolution, and ConPTY worker cleanup after terminal exit. These
choices and the bounded hardlink scan are documented in [Windows support](../windows.md).

## Source And Artifact Identity

- Repository: `https://github.com/Cosmos2023/mycli`, branch `main`.
- Baseline: `b17383011ed91061567388b16374a531b3d5a1db`, plus uncommitted task changes.
- Windows build: `26200.9445`; System32 processmodel.dll: `10.0.26100.9444`.
- Node 24.14.0, CMake 3.31.6, MSVC 19.44, SDK 10.0.26100.0; x64 Release.
- Built and promoted helper SHA-256:
  `99cb7b3564d91d23e8fd23000ced520575dec77a52f671b257e4aa2f8feabb4f`.
- Candidate `cosmos2023-mycli-0.1.1.tgz` SHA-256:
  `8d31af6a8f51fa35d29e7032ed842434dd078e7bbf25628f1af129fcfd966f4d`.
- Candidate and structured evidence are retained under
  `native/windows-sandbox-helper/build/release-evidence/` (ignored local artifacts).
  `windows-packed.json` preserves the successful smoke result; the complete command
  log is `native/windows-sandbox-helper/build/package-smoke.log`.
- Tar inventory includes the helper and FlatBuffers, Microsoft PSEC, and
  nlohmann-json licenses. The installed helper hash equals the tested source helper.

## Verification

| Check | Result |
| --- | --- |
| Native Release build | Passed |
| CTest with `MYCLI_REQUIRE_PSEC_TESTS=ON` | 4/4 passed: protocol, primitives, host audit, PSEC |
| Strict Windows platform runner | 13/13 passed, zero skips/failures/cancellations/todos; normal process exit |
| Source setup and status after maintenance tests | Ready, `windows_psec` |
| Focused sandbox/environment/release regressions | 77 passed |
| Shell/controller/PTY regressions | 34 passed |
| TUI permission selector and runtime state | 179 passed |
| Final release-script regressions | 37 passed |
| Lint, root and TUI typecheck | Passed |
| Contract drift, configuration drift, release compatibility | Passed |
| Build and helper-required release verification | Passed |
| Installed candidate smoke, fresh setup and readiness | Passed: 10 installed journeys, `fresh_setup: true`, ready `windows_psec` |
| Whole-repository `npm test` | Failed in two unchanged config tests; see limitations |

Native fixtures verify writes against medium- and low-integrity NULL DACLs,
readonly and denied access, private sibling reads, private desktop separation,
runtime forbidden hardlink creation, existing denied/protected hardlink aliases
(including explicit writable aliases), absent metadata and nested grant conflicts.
The host's `C:\ProgramData\Alibaba` still reports a NULL DACL after these checks.

The original 13 platform tests cover filesystem boundaries, network modes and
per-command proxy isolation, terminal interaction, process cleanup and maintenance.
UDP fixtures require a reply from the expected endpoint and assert receiver counts;
a successful UDP send callback alone is not evidence of network access.

## Limits And Release Status

- No clean Windows VM or dedicated machine was available. A fresh sandbox setup
  on this machine does not establish clean-OS installation acceptance.
- This host exercises PSEC. The legacy account backend still requires its own
  complete real-host acceptance run; native primitive tests do not replace it.
- The full npm test run again failed in unchanged config tests:
  `policy/exec-policy-store.test.ts:83` (concurrent rule-lock acquisition timeout)
  and `update-cache.test.ts:323` (Windows reports `missing`, expected `unreadable`).
  Later test groups in that command did not execute.
- Trusted unsandboxed host processes are assumed. This is not protection from
  administrators, a compromised kernel, or external workspace mutation. PSEC API
  availability is checked dynamically; one tested Windows build is not a universal
  support guarantee. Host TEMP is not automatically granted write access.
- Local evidence records dirty source and cannot satisfy the publisher's clean
  source/commit/artifact checks. The task remains open for release acceptance.
- No remote commits, pushes, tags, publication or GitHub CI runs were performed.

The release gate requires all 13 source tests without skips and a separately
installed candidate with successful setup and independent ready status. Evidence
binds the candidate and helper hashes to the source commit and dirty-state flag.
Generic cross-platform package smoke remains separate from this strict gate.
