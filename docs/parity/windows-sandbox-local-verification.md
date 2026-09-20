# Windows Sandbox Local Verification

## Current Status (2026-09-18)

The PSEC backend now passes native enforcement tests and all 13 real Windows
platform tests on this host, with zero skips. The host's Alibaba NULL DACL remains
unchanged. See [the current PSEC verification](windows-sandbox-psec-verification.md)
for the exact helper, package results, and remaining release limitations.

## Historical Verification (2026-09-17)

Date: 2026-09-17. Result: **blocked; not release acceptance**.

This records the initial verification stage. Later host-preflight changes and integrity
experiments are described in [the optimization follow-up](windows-sandbox-host-optimization.md).
The helper hash below belongs to this initial stage.

This run used the local Windows x64 host because no clean VM or dedicated test machine was
available. No GitHub workflow was triggered, and no package, tag or branch was published/pushed.

## Source And Toolchain

- Repository: `https://github.com/Cosmos2023/mycli`, branch `main`.
- Source baseline: `b17383011ed91061567388b16374a531b3d5a1db`.
- The final verification uses uncommitted fixes on that baseline, not a released commit.
- Node: 24.14.0; CMake: 3.31.6; MSVC: 19.44; Windows SDK: 10.0.26100.0.
- Build: CMake Visual Studio x64, Release configuration.
- Final local helper SHA-256:
  `21740158a09f68fd0b9f727faff663d48c0b00a392e6f9fda5ad72cd37aefc95`.
- The compiled helper remains under `native/windows-sandbox-helper/build/Release/`.
  It was not copied into release assets because native acceptance failed.

## Results

| Check | Actual result |
| --- | --- |
| CMake configure and Release build | Passed |
| CTest `protocol` | Passed |
| CTest `windows_primitives` | Failed, CTest exit 8; host NULL DACL blocks request-level policy |
| `npm ci` | Passed after correcting six stale ripgrep platform lock entries from 0.1.0 to the manifest's 0.1.1 |
| `npm run build` | Passed |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm run contracts:check` | Passed |
| `npm run config:check` | Passed |
| `npm run release:compatibility` | Passed |
| `npm run release:verify` (metadata only) | Passed; does not assert helper inclusion or readiness |
| `npm run test:release` | 36 passed, zero failed/skipped |
| Test catalogue regression | 6 passed, zero failed/skipped |
| `npm test` | Failed in the config unit group; subsequent groups did not run |
| Source `sandbox status --json` | Exit 1, unavailable/helper_missing; consistent with not installing the unaccepted helper |
| Source setup and 13 real Windows platform tests | Not run after the native failure |
| `release:verify -- --require-windows-helper` and helper-required package smoke | Not run after the native failure; no release asset promoted |
| Fresh Windows installed-candidate setup and readiness | Not run; no clean environment available |

The 36 release regressions exercise gate behavior with fixtures. They are not the 13 real Windows
isolation tests and must not be described as such.

## Native Findings And Fixes

1. **Path pinning did not prevent rename.** Attribute/control-only Win32 handles do not enforce
   the intended delete-sharing restriction. `PathGuard` now requests `FILE_READ_DATA`; the native
   regression requires rename of the guarded file, its directory and parent to fail specifically
   with `ERROR_SHARING_VIOLATION`, and requires rename to succeed after release.
2. **Journal cleanup left deny ACEs behind.** `SetEntriesInAclW(REVOKE_ACCESS)` did not remove
   the sandbox's deny entries. Cleanup now removes ordinary allow and deny ACEs for the exact
   recorded SID while preserving unrelated entries. A regression first failed on the old code,
   then passed after the fix. It compares directory and child ACL entries against their baseline,
   including unrelated allow/deny ACEs, and repeats cleanup to check idempotence.
3. **Request-level native tests could mutate audited host paths without cleanup on failure.**
   They now install a scoped ACL journal and clean it on both success and exceptions.

The final primitives run passed path pinning, deny cleanup, crash recovery, policy coordination,
private desktop, restricted command and child-process cleanup stages. Its basic access probes
reported `allowed=0 outside=9 secret=10 metadata=9`, before the request-level audit failed.
These partial results do not establish complete Shell, ConPTY, network or maintenance coverage.

## Remaining Host Blocker

The request-level audit reports `sandbox cannot safely modify a null DACL`.
Read-only inspection through native `GetNamedSecurityInfo` identified a NULL DACL on
`C:\ProgramData\Alibaba`. A NULL DACL permits access to everyone; an empty DACL is different and
denies access. The helper intentionally refuses to replace a NULL DACL.

No third-party baseline permissions or audit roots were changed to bypass this condition.
The current host therefore cannot satisfy full acceptance with this helper and its current ACLs.
An eventual full run still needs native tests, all 13 platform tests without skips, source readiness,
helper-required packaging, and independent fresh installed-package readiness. Compilation or a
single successful status response cannot substitute for those checks.

## Local Cleanup

The early audit runs left six explicit deny entries on three temporary objects. Their SIDs were
re-derived from the exact test process fixtures and owner using the helper's SHA-256 algorithm.
Only those exact test SID entries were removed; unrelated explicit rules were compared and
preserved. A subsequent bounded inspection of 12,255 candidate paths found zero matches for
those old test SIDs or the final journaled run's capability SID. The final request journal was
also empty. This is a scoped test cleanup check, not a whole-disk ACL certification.

## Other Test Failures

`npm test` stopped in unmodified config tests:

- `policy/exec-policy-store.test.ts`: concurrent writers failed to acquire the global rule lock.
  The same test passed when rerun separately; the full-run failure remains recorded.
- `update-cache.test.ts:323`: the path-collision fixture expected cache state `unreadable`, but
  Windows returned `missing`. This failure reproduced separately.

These failures were not waived or changed as part of the sandbox work.

## Release Gate Changes

- `npm run test:windows-sandbox` requires Windows and both maintenance opt-ins, then rejects any
  result other than 13 passing tests with zero failed, skipped, cancelled or todo tests.
- `smoke:package -- --require-windows-ready` requires installed helper inclusion and ready status
  with a successful process exit. Explicit `--setup-windows-sandbox` additionally requires absent
  managed state, confirmed setup and a separate final ready check.
- `--artifacts-dir` retains the tested application tarball. Evidence binds the commit, version,
  clean tracked source state, and SHA-256 of that tarball and helper.
- The tag workflow requires source Windows acceptance and a separate fresh Windows package job.
  The publisher requires matching evidence before registry operations, and publishes the tested
  tarball. Ordinary package smoke still permits unavailable sandbox status for other local checks.

These changes passed local regression checks. The actual fresh Windows workflow has not been run.
See [the helper commands](../../backend/packages/tools/native/windows/README.md) and
[release instructions](../releasing.md) for the remaining acceptance steps.
