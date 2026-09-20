# Windows Sandbox Host Compatibility

## Current Implementation (2026-09-18)

The follow-up is implemented as a native PSEC backend in the existing C++ helper.
Actual environment creation, process launch, private desktop, filesystem and
network enforcement now pass on this host. All 13 Windows platform tests pass
without skips. PSEC does not require rewriting the host's NULL DACL or provisioning
dedicated accounts. Older hosts retain the account backend and its fail-closed
checks. See [current verification](windows-sandbox-psec-verification.md) and the
[Windows behavior contract](../windows.md) for results and compatibility limits.

The sections below preserve the earlier investigation and pinned source review.
Statements about unimplemented experiments or outstanding local enforcement tests
describe the 2026-09-17 investigation, not the current implementation. A clean
Windows installation and a separate legacy-backend host are still unavailable.

## Historical Investigation (2026-09-17)

This follow-up to [the local verification](windows-sandbox-local-verification.md) uses the same
Windows x64 host. Its purpose is to improve diagnostics and failure behavior, and to identify an
isolation design that does not depend on rewriting third-party permissions. It does not certify
this host or the current helper for release.

## Findings

1. The existing account setup check does not test the requested filesystem policy. `sandbox_ready`
   verifies identities, restricted-token construction and network rules. A ready setup can still
   fail when a command audits public directories.
2. Public-directory auditing currently scans and writes ACLs in one pass. A later incompatible
   directory can therefore be discovered after unrelated audit paths have already been changed.
3. Auditing is bounded by time, count, depth and child count, and skips inaccessible/reparse paths.
   It is a compatibility check and mitigation over selected paths, not a kernel-enforced write
   allowlist over every volume. Expanding these bounds cannot establish a complete boundary.
4. The host's problematic directory has a NULL DACL and implicit medium integrity (RID 8192).
   No special case for its vendor or path is appropriate in production code.

## Changes Implemented

- Split public-directory inspection from ACL application. A discovered NULL DACL rejects the plan
  before any planned deny is applied. Run this step before request preparation reserves missing
  denied paths or adds account read grants.
- Keep the existing bounded audit scope and execution behavior. Record truncated and uninspectable
  coverage explicitly rather than implying that inspection covered the whole host.
- Add `npm run sandbox:check-host`, backed by the built helper's read-only `--check-host` option.
  It needs neither account setup nor elevation and emits no paths or raw security descriptors.
- Recheck ACLs when applying a plan. A path changed to a NULL DACL after inspection still fails
  closed. Existing journaling remains responsible for recovery if a later application fails.
  Application checks a separate two-second budget between writes and fails with
  `host_audit_apply_timeout` instead of performing an unbounded batch of discovered mutations.
- Add the `windows_host_audit` CTest target. Fixtures cover a NULL DACL after a public writable
  path, no writes during inspection or rejection, allowed-root exclusion, apply/cleanup, a DACL
  changed after inspection, and reported child-count truncation.

The change does not convert a NULL DACL, lower integrity labels on real workspaces, or replace the
existing sandbox token. Request-time journaling is still needed: inspection and application do
not form an atomic filesystem transaction. Time checks are cooperative between filesystem calls;
they cannot cancel an individual stalled Win32 call.

## Diagnostic Contract

Build the helper first, then run:

```powershell
npm run sandbox:check-host
```

The helper reports only structural information:

```json
{
  "status": "blocked",
  "code": "host_null_dacl",
  "scope": "bounded_public_paths",
  "paths_checked": 100,
  "paths_uninspectable": 0,
  "scan_truncated": false
}
```

The counts above illustrate the schema, not fixed expected host counts.

| Result | Meaning | Exit |
| --- | --- | --- |
| `blocked` / `host_null_dacl` | A known incompatible NULL DACL was found | 1 |
| `partial` / `host_audit_incomplete` | No known blocker found, but bounds or inaccessible paths limited inspection | 1 |
| `no_known_blocker` / `no_known_blocker` | No known blocker in the selected bounded scope | 0 |

None of these results is `ready`. The command does not initialize identities, test WFP, prove
whole-disk confinement, or replace the 13 real Windows tests. Production execution retains the
existing best-effort handling of scan bounds and inaccessible ACLs; this diagnostic additionally
surfaces partial coverage to the operator.

## Integrity Experiment

The reproducible source lives in
[`experiments/host-integrity`](../../native/windows-sandbox-helper/experiments/host-integrity/README.md).
It uses actual Windows access checks in temporary fixtures, with no third-party ACL writes.

| Scenario | Observed create-file access |
| --- | --- |
| Current restricted token into a medium-integrity NULL DACL directory | Allowed |
| Low-integrity restricted token into the same fixture | Denied |
| Low-integrity restricted token into a low-integrity NULL DACL directory | Allowed |
| Another same-user low-integrity process into a lowered workspace | Allowed |

Mandatory Integrity Control helps against this host's particular directory, but simply lowering
the production token and workspace labels does not preserve the intended boundary. It also
requires separate verification of Node, PowerShell, ConPTY, private desktops, inherited handles,
temp files, package caches and network enforcement. No production switch to low integrity was made.

## Recommended Next Design

The source comparison below changes the evaluation order: test the native MXC/PSEC capability
before investing in a staged-workspace backend. Neither route is accepted for production yet.

### 1. Make Readiness Specific

Keep setup readiness distinct from policy readiness. Add a versioned, read-only policy preflight
to the Node management boundary before requesting UAC or starting a command. It must identify
known host incompatibility, incomplete inspection and missing enforcement separately. Expose
bounded error codes by default; any path-level troubleshooting must be an explicit local action.
The new native diagnostic is the first building block, not a completed management integration.

### 2. Evaluate Native MXC/PSEC First

Codex has a separate adapter for Microsoft's MXC process security environment. It translates
filesystem permissions into native policy rather than installing host ACLs. This directly
addresses the architectural dependence exposed by this host, but the NULL DACL boundary still
needs an actual access test. Preserve the current backend and its rejection behavior while
evaluating this route independently.

This host passes the support-query prerequisite recorded below. Next, reproduce the pinned SDK's
create/close and startup-attribute probe, then execute fixture-only tests for outside writes,
medium/low NULL DACLs, readonly roots, denied metadata, reparse points, hardlinks, and child
processes. Test Node, Windows PowerShell, pwsh and ConPTY. Reject unsupported network or desktop
policies explicitly; do not silently drop them to select this backend. A successful support query
alone must never set `sandbox status` to ready.

### 3. Prototype An Isolated Workspace Backend

Evaluate an AppContainer or low-integrity worker with a private staged workspace and a trusted
host broker for reviewed file changes. Keep the real workspace's labels and third-party DACLs
unchanged. The broker must independently validate paths, reparse points, denied metadata and
concurrent edits; raw worker requests must not grant host filesystem authority.

This is a new execution mode with explicit filesystem semantics. It must not silently replace
direct workspace execution. AppContainer access to NULL DACLs, inherited handles, executable
loading, ConPTY and per-mode networking still requires actual Windows tests before choosing it.
The integrity experiment alone does not prove that backend secure or compatible.

### 4. Preserve A Stronger Isolation Option

Where direct host execution cannot enforce the requested policy, a VM/Windows Sandbox backend is
an architectural option for supported machines. It cannot be assumed on this host and must never
be an implicit dependency or an unrestricted fallback. Check its availability independently.

### 5. Use This Host As A Regression Profile

Represent its difficult properties in disposable fixtures: NULL and empty DACLs, public writable
directories, protected inheritance, inaccessible parents, scan bounds, junctions, concurrent ACL
changes, and recovery after partial preparation. Keep real vendor names out of production rules.
Add low-integrity NULL DACLs and other same-user low-integrity processes to any new backend's tests.

## Codex Source Comparison (2026-09-17)

Inspected upstream main at `c11fdc944f116b5f995059db58ef01f179733122`, including the native
Windows sandbox, runner, policy adapter, MXC adapter, and relevant tests. This is a source review,
not a successful execution of Codex's sandbox or its Windows suite. The official Windows web
documentation returned HTTP 403 in this environment; findings below use pinned source links.

### Existing Restricted-Token Backend

| Area | Observed Codex implementation | Implication for mycli |
| --- | --- | --- |
| Identity and token | Elevated setup provisions online/offline users; the runner creates a restricted token using `DISABLE_MAX_PRIVILEGE`, `LUA_TOKEN`, and `WRITE_RESTRICTED`, with capability, logon and Everyone SIDs | This is the same general design already used here; it does not itself resolve NULL DACL writes |
| Filesystem permissions | Workspace capability ACLs, readonly carveouts and explicit deny-read paths; unsupported policy combinations are rejected before execution | Preserve explicit capability checks; successful setup is not proof that a particular policy is enforceable |
| Public-path audit helper | Bounded two-second scan of selected directories and immediate children; `/programdata` is skipped during child scanning and ProgramData is not a separately gathered root | Copying the narrower scan can hide this host's blocker without closing the access path |
| NULL DACL in that audit | `path_has_world_write_allow` calls `path_mask_allows`; its DACL mask helper returns false for NULL | This checks allow ACE presence, not actual Windows access. Do not copy this behavior as a security fix |
| Networking | Offline-account firewall rules plus persistent WFP filters covering additional protocol/port cases | Verify actual IPv4/IPv6, loopback, DNS and proxy enforcement; proxy environment variables are insufficient |
| Paths and helper outputs | No-reparse directory handles, relative opens and atomic output replacement through pinned parent handles | Compare these patterns with mycli's path guards, including hardlinks and replacement races |
| Cleanup | `revoke_ace` preserves a NULL DACL and avoids rewriting an unchanged ACL; it still uses `REVOKE_ACCESS` | Keep mycli's tested explicit allow/deny ACE removal; add an absent-SID/no-change inheritance regression before copying upstream cleanup |

Relevant sources: [token construction][codex-token], [runner token selection][codex-runner],
[public-path audit][codex-audit], [NULL mask check][codex-null], [policy validation][codex-policy],
[network rules][codex-firewall], [WFP filters][codex-wfp], [path handles][codex-paths],
[atomic outputs][codex-outputs], and [ACL cleanup][codex-cleanup]. The audit helper is exported;
this review does not assert that every upstream launch calls it. There is also a separate
standard-user mutation check that correctly classifies NULL DACL as writable, so the audit
finding must not be generalized to every ACL check in Codex.

No AppContainer transition or low-integrity label change was found in the inspected
restricted-token creation path. The earlier mycli fixture experiment remains evidence about
mycli's token behavior, not a reproduction against Codex's full elevated backend.

### Separate MXC/PSEC Backend

[Codex's MXC adapter][codex-mxc] directly uses Microsoft's native process security environment,
without editing host ACLs, creating sandbox users or invoking the older AppContainer dispatcher.
The inspected [default platform selector][codex-selector] still chooses `WindowsRestrictedToken`;
the presence of MXC code does not mean every Codex installation uses it.

The adapter requires a real create/close capability probe. Explicit deny paths additionally
require `PSE_SUPPORT_FS_DENY`. Its documented constraints matter here: private desktop requests
are rejected, managed networking with `allow_local_binding=false` is rejected, and remaining
descendants are terminated when the foreground command exits. These are contracts to evaluate,
not details to suppress when porting the backend. Review the [native launch checks][codex-mxc-native]
and [request validation][codex-mxc-validation] before choosing it.

Codex pins Microsoft MXC at `6cd3d58f05d3447e67109cfb75e042803b843ca4`. Its
[API loader and support query][mxc-support] use the system `processmodel.dll`; its
[availability probe][mxc-probe] creates and closes an environment and checks startup attributes.

Read-only inspection on this host found Windows build `26200.9445` and system `processmodel.dll`
version `10.0.26100.9444`. `dumpbin /exports` found the required create/query/close exports.
A direct call to `QueryProcessSecurityEnvironmentSupport`, loaded only from System32, returned:

```json
{"hresult":"0x00000000","support_flags":"0x0000000000000003","filesystem_deny_supported":true}
```

Only bit 0 (filesystem deny support) is interpreted here. This query created no security
environment or workload and changed no accounts, ACLs or network rules. The create/close probe,
real enforcement, NULL DACL confinement and compatibility tests remain outstanding. This result
makes MXC worth evaluating on this machine; it does not establish availability or readiness.

[codex-token]: https://github.com/openai/codex/blob/c11fdc944f116b5f995059db58ef01f179733122/codex-rs/windows-sandbox-rs/src/token.rs#L463
[codex-runner]: https://github.com/openai/codex/blob/c11fdc944f116b5f995059db58ef01f179733122/codex-rs/windows-sandbox-rs/src/bin/command_runner/win.rs#L255
[codex-audit]: https://github.com/openai/codex/blob/c11fdc944f116b5f995059db58ef01f179733122/codex-rs/windows-sandbox-rs/src/audit.rs#L28
[codex-null]: https://github.com/openai/codex/blob/c11fdc944f116b5f995059db58ef01f179733122/codex-rs/windows-sandbox-rs/src/acl.rs#L157
[codex-policy]: https://github.com/openai/codex/blob/c11fdc944f116b5f995059db58ef01f179733122/codex-rs/sandboxing/src/windows.rs#L104
[codex-firewall]: https://github.com/openai/codex/blob/c11fdc944f116b5f995059db58ef01f179733122/codex-rs/windows-sandbox-rs/src/setup_provisioning/firewall.rs#L90
[codex-wfp]: https://github.com/openai/codex/blob/c11fdc944f116b5f995059db58ef01f179733122/codex-rs/windows-sandbox-rs/src/wfp/filter_specs.rs#L26
[codex-paths]: https://github.com/openai/codex/blob/c11fdc944f116b5f995059db58ef01f179733122/codex-rs/windows-sandbox-rs/src/no_reparse_dir.rs#L118
[codex-outputs]: https://github.com/openai/codex/blob/c11fdc944f116b5f995059db58ef01f179733122/codex-rs/windows-sandbox-rs/src/file_write.rs#L54
[codex-cleanup]: https://github.com/openai/codex/blob/c11fdc944f116b5f995059db58ef01f179733122/codex-rs/windows-sandbox-rs/src/acl.rs#L902
[codex-mxc]: https://github.com/openai/codex/blob/c11fdc944f116b5f995059db58ef01f179733122/codex-rs/mxc-sandbox/README.md
[codex-selector]: https://github.com/openai/codex/blob/c11fdc944f116b5f995059db58ef01f179733122/codex-rs/sandboxing/src/manager.rs#L68
[codex-mxc-native]: https://github.com/openai/codex/blob/c11fdc944f116b5f995059db58ef01f179733122/codex-rs/mxc-sandbox/src/native.rs#L21
[codex-mxc-validation]: https://github.com/openai/codex/blob/c11fdc944f116b5f995059db58ef01f179733122/codex-rs/sandboxing/src/manager.rs#L399
[mxc-support]: https://github.com/microsoft/mxc/blob/6cd3d58f05d3447e67109cfb75e042803b843ca4/src/backends/learning_mode/windows/src/secenv.rs#L449
[mxc-probe]: https://github.com/microsoft/mxc/blob/6cd3d58f05d3447e67109cfb75e042803b843ca4/src/backends/appcontainer/common/src/base_container_runner.rs#L555

## Acceptance Still Required

Local checks after this change: the MSVC Release build, `protocol` and `windows_host_audit` passed.
The full three-entry CTest run remains unsuccessful because `windows_primitives` now stops with
the explicit `host_null_dacl` code. The npm diagnostic returned `blocked`, with 414 paths checked,
44 uninspectable paths and `scan_truncated=true` in the observed run; these counts may change.
The integrity experiment returned all five expected access-check results. No production token,
third-party ACL, sandbox account or network rule was changed by the experiment or diagnostic.
The 36 release regressions, lint, typecheck, contract drift and configuration drift checks passed.
The earlier full `npm test` failures in unchanged config tests remain outstanding; see the initial
verification report. The complete Windows platform and installed-package gates were not rerun
past the known native blocker.

Native protocol, primitives and host-audit tests must pass, followed by all 13 real Windows tests
without skips. The installed candidate must pass helper inclusion, setup and independent readiness
checks. Include one ordinary installed Windows machine and a fresh Windows environment, and retain
evidence for the exact tested artifact. This follow-up does not waive the existing local blocker.
