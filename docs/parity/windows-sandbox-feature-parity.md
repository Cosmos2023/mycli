# Windows Sandbox Feature Alignment

Comparison target: Codex `c11fdc944f116b5f995059db58ef01f179733122`, specifically
its MXC/PSEC policy adapter. Microsoft schema/API reference remains pinned to
`6cd3d58f05d3447e67109cfb75e042803b843ca4`. This is feature alignment in mycli's
C++ helper, not a port of the entire Codex Windows implementation or its test suite.

## Implemented Behavior

| Feature | mycli behavior |
| --- | --- |
| Custom read roots | Explicit roots supplement workspace/platform/runtime reads |
| Readonly carveouts | Arbitrary existing directories; nested write grants, file-tool approvals and child inheritance cannot override them |
| Temporary storage | Journaled private TMPDIR, normal and crash recovery cleanup; Windows separately owns private TEMP/TMP |
| Full filesystem with constrained network | Accessible volume snapshot; preserves explicit denies, readonly masks and workspace metadata |
| Large request transport | Base64 environment chunks, 1,000,000-byte UTF-8 limit, strict native validation, removal before workload launch |
| Local loopback option | Opt-in all-port IPv4/IPv6 loopback egress and local binding; strict per-command proxy port remains default |
| Concurrent policies | PSEC keeps one kernel policy per command, so divergent peers run side by side (Codex parity); the legacy ACL backend still requires matching active policies |
| Linked policy roots | Explicit local junction/symlink chains resolve to pinned canonical roots before lease admission; short-path aliases share the same identity |
| Durable authority | Managed config, frozen run state, persisted child state, Shell/hooks/plugins/MCP and file mutations preserve restrictions |
| Plugin worker startup | Source and compiled workers receive bounded runtime read grants; explicit read bounds and denials still fail closed |

`writable_tmp=false` controls the additional managed directory. It does not deny
Windows PSEC's own private temporary storage. This distinction was established by
real filesystem writes and cleanup checks, not environment variable inspection alone.

## Remaining Differences And Failed Experiment

### PSEC Policy Translation Comparison (2026-09-18)

Compared against the pinned Microsoft MXC sources that Codex uses
(`src/backends/appcontainer/common/src/base_container_helpers.rs`,
`base_container_runner.rs`, `src/core/mxc_engine/src/policy/network.rs` at
`6cd3d58f05d3447e67109cfb75e042803b843ca4`) and Codex's
`codex-rs/mxc-sandbox/src/policy.rs` at `c11fdc944f116b5f995059db58ef01f179733122`.
The helper's wire format and marker strings match upstream: host loopback is
`capabilities += "networkLoopback"` plus `allowed_appcontainer_peer = "MXC-Loopback"`,
exactly the constants in `base_container_helpers.rs`. The remaining differences are:

| Aspect | Codex / MXC behavior | mycli helper | Assessment |
| --- | --- | --- | --- |
| Spec construction | `BaseContainerRunner` selects PSEC or SBOX from a rich `ExecutionRequest` and builds the FlatBuffers spec internally | builds the PSEC FlatBuffers spec directly and calls `CreateProcessSecurityEnvironment` | Same wire format, different orchestration; no ingress model in the direct form |
| Capabilities | directional networking recomputes the set: caller-owned network capabilities are stripped, then `internetClient` is added when egress is allowed, `privateNetworkClientServer` when the ingress default is allow, and `networkLoopback` when host loopback is allowed | hard-coded per mode; the online string is `registryRead,internetClient,privateNetworkClientServer,networkLoopback` | Equivalent for the online case: Codex's derivation produces exactly that string. The proxied string adds `networkLoopback` without an ingress decision |
| Host loopback ingress | explicit `network_ingress.host_loopback = Allow` maps to the same two wire markers | markers are always set when networking is enabled or proxied; there is no explicit ingress decision | Same markers, but the ingress intent is implicit |
| Proxy | sets `NetworkPolicy.proxy.url`; proxy and direct egress are mutually exclusive forms (`runtime_network_proxy` requires deny-by-default egress with no rules) | never sets `proxy.url`; expresses the proxy as a loopback egress allow rule plus the loopback peer | Different mechanism; mycli relies on the peer marker instead of the proxy form |
| Egress rules | preserves allow/deny endpoint rules, destination `except`, port ranges and ICMP family splitting | managed `[execution_policy.network_egress]` builds the same endpoint rules; structured policies are deny-by-default allowlists and reject a non-deny default | Implemented for PSEC; verified by native enforcement tests (allow rule connects, unmatched rule and empty deny default are blocked). `default = "allow"` stays unsupported because host loopback is only authorized by an explicit rule |
| Volume roots | grants volume root plus immediate children and re-normalizes conflicts | snapshot of the accessible volume; volume-root reads stay nonrecursive | Documented difference |
| Default backend | platform selector still prefers the restricted-token backend | PSEC is selected when the setup marker reports ready | Intentional difference; mycli is stricter here |

Consequence: for a network-enabled, non-proxied command the helper's policy is
equivalent to Codex's derivation, field for field: same capability set, same
`MXC-Loopback` peer, same egress default. The unresolved inbound-loopback failure is
therefore **not** a missing capability or peer constant. The remaining candidates are
the proxy-form difference and host-side WFP/firewall state; WFP inspection needs
elevation and has not been performed.

Upstream evidence stops at the spec shape as well: MXC's unit tests assert that
`network_ingress.host_loopback = Allow` yields the `networkLoopback` capability and the
`MXC-Loopback` peer, while `tests/scripts/run_base_container_network_tests.ps1` checks
configured default actions and markers rather than a real host-to-container
connection. The claim that managed networking permits host ingress remains an
end-to-end gap on both sides, not something mycli is currently diverging from.

Direction check: `experiments/psec-loopback-container-pair.mjs` starts a listener in
one PSEC container and connects from a second PSEC container. That connection also
times out (`error:ETIMEDOUT`), so the failure sits on the listener/inbound side
rather than in host-specific policy. Upstream's `psec_policy_compatible` does not
divert policies with ingress rules or `allow_local_network` to another backend, so
the same shape runs on PSEC there too. Until an elevated WFP inspection or an
upstream runner comparison is available, treat inbound loopback into a PSEC
container as unverified on this Windows build rather than as a mycli-only gap.

Root cause (elevated WFP capture, 2026-09-19): the drops come from the built-in
Windows Firewall filter `AppContainerLoopback` ("This filter blocks AppContainer
loopback traffic"), provider `FWPM_PROVIDER_MPSSVC_WF`, sublayer
`FWPM_SUBLAYER_MPSSVC_APP_ISOLATION`, layers `ALE_AUTH_RECV_ACCEPT_V4/V6`, action
`FWP_ACTION_BLOCK`, effective weight max-1. The capture recorded 17 loopback drops,
each carrying a **distinct** `S-1-15-2-...` package SID, so PSEC creates a fresh
AppContainer identity per command. Allowing inbound loopback therefore requires the
documented per-identity loopback exemption (`NetworkIsolationSetAppContainerConfig`
or `CheckNetIsolation LoopbackExempt`), which needs administrator rights and
machine-global state that would have to be added and removed around every launch.
Neither mycli nor upstream Codex does that: Codex's MXC adapter explicitly avoids
elevation and setup, and its tests never verify a real host-to-container connection.
Conclusion: inbound loopback into PSEC containers is a Windows platform constraint,
not a mycli divergence. Closing it is an elevation-based design decision.

- Host-initiated connections to sandbox listeners failed with `ETIMEDOUT` on
  Windows 26200.9445, despite the same upstream loopback peer/capability policy.
  Outbound IPv4/IPv6 loopback and binding listeners succeeded. Inbound local
  service access is blocked by the Windows platform (see the root cause below) and
  mycli deliberately matches Codex's no-elevation design instead of exempting each
  container identity. Keep it out of any "supported" claim.
  Reproduce separately with:

  ```powershell
  node --conditions=mycli-source --import tsx native/windows-sandbox-helper/experiments/psec-loopback-ingress.mjs
  ```

  This diagnostic returns nonzero on failure. It is retained outside the seven-test
  accepted-capability suite, which only asserts outbound access and local bind.
  The expanded matrix passes ordinary host IPv4/IPv6 listeners, but fails both
  ordinary PSEC networking and opt-in proxy loopback ingress. A standalone native
  probe on the inherited desktop reproduces the failure, excluding mycli's private
  desktop and production launch wrapper as necessary causes. This is not proof
  that the upstream Codex executable fails: it has not been built and run here.
  The elevated WFP capture described below later identified the exact filter; the
  cause is no longer unconfirmed. No extra broad network grant or global firewall
  exemption was added to hide this failure.

  To compare the standalone native launch after building the experiment:

  ```powershell
  cmake -S native/windows-sandbox-helper/experiments/psec -B native/windows-sandbox-helper/build/psec -A x64
  cmake --build native/windows-sandbox-helper/build/psec --config Release --target psec-probe
  node --conditions=mycli-source --import tsx native/windows-sandbox-helper/experiments/psec-loopback-ingress.mjs (Resolve-Path native/windows-sandbox-helper/build/psec/Release/psec-probe.exe).Path
  ```

  Negative cases only count as blocked after a listener reports its port and the
  connection times out; startup failures cannot pass a negative case.
  A further isolated probe adds `internetClientServer` to the online/loopback
  specifications: both still time out on IPv4 and IPv6. This experimental grant
  is never included in the production helper and did not resolve the failure.
- Concurrent PSEC commands are independent, matching Codex's MXC adapter, which edits no host
  ACLs and carries one policy per command. The journal still serializes preparation,
  placeholder bookkeeping and cleanup, and the legacy restricted-token backend still rejects
  a peer whose filesystem policy differs, because it edits shared host ACEs.
  A local reproduction (`experiments/psec-hardlink-concurrency.mjs` against
  `build/psec/Release/psec-probe.exe`) records the accepted snapshot boundary: PSEC denied
  every new link creation the probes attempted, yet a hardlink that already existed could be
  renamed by a wider writer into a narrower command's directory after its launch scan, and the
  narrower command then modified the file outside its write scope. Codex documents the same
  snapshot semantics for its deny-glob resolver; do not describe the launch scan as revoking
  aliases introduced later.
  Alias creation itself is closed: `experiments/psec-hardlink-creation.mjs` shows a sandboxed
  process receiving `EPERM` for hardlink, junction and file-symlink creation even when both ends
  are inside its own write root and the source file was created by that same process. The native
  `--link-fresh` regression pins the hardlink case, so the residual rename boundary requires an
  actor outside the sandbox.
- Full-filesystem mode is an accessible logical-volume snapshot, including supported
  immediate local junction/symlink targets. The pinned Codex adapter also uses a
  volume snapshot; that snapshot itself is not a parity gap. Inaccessible or
  sharing-locked entries can be omitted. Arbitrary UNC shares, volume-GUID targets
  and reparses nested inside protected trees remain unsupported. Workspace metadata
  remains protected.
- mycli retains explicit setup/maintenance and a private desktop. Existing legacy
  account installations retain their backend; advanced PSEC options fail closed.
- Source application M7 extension acceptance passes 6/6 in
  `build/extensions-m7-aligned2.log`. A long-lived project plugin writes its own nested
  directory while the configured hook requests workspace-wide writes; both now run because
  each PSEC command carries its own kernel policy. The release gate also re-runs green with
  the promoted helper: 13/13 platform tests plus 7/7 parity tests, zero skips
  (`build/windows-sandbox-aligned2.log`). The direct regression in
  `plugin-sandbox.platform.test.ts` now proves the overlapping writer executes while the
  plugin host keeps its own scope.
- This local machine does not provide clean-OS or legacy-only host acceptance.
  A dirty-source package cannot satisfy publication evidence requirements.

## Verification

The strict runner now checks the actual ready backend. It requires the original
13 tests, plus all seven added tests on PSEC, with no skips, failures, cancellations
or todo cases. It also checks that the final handshake retains the selected backend.
Installed package setup and readiness remain a separate mandatory release gate.

Local results on 2026-09-18, main baseline
`b17383011ed91061567388b16374a531b3d5a1db` with the working changes:

| Check | Result |
| --- | --- |
| Native Release build and CTest | 4/4 passed, including snapshot junction targets, allowed/denied writes and short-path policy identity |
| Strict Windows acceptance | Original 13/13 plus PSEC 7/7; zero skips, natural process exit |
| Storage package | 373/373 passed, zero skips; includes failed-initialization handle cleanup |
| Changed integrations fixtures | 16/16 passed, zero skips |
| Build, lint, typecheck, contracts, config reference, release compatibility | Passed |
| Helper-required release verification | Passed |
| Candidate pack and installed helper hash | Passed |
| Installed candidate fresh setup and separate ready status | Passed; PSEC |
| Complete package smoke | Current candidate `f38d05b5...` passes 10/10 with fresh installed setup and ready status; see `build/aligned-release-evidence/windows-package-smoke.json` |
| Current installed plugin runtime | Fresh prefix install, matching helper hash (`98f167c3...`), fresh setup/ready and the exact strengthened integrations journey pass |
| Plugin runtime boundary regressions | 11/11 focused and 61/61 broader plugin tests passed, zero skips; source/compiled startup, denied access and concurrency protection |
| Repository unit and contract groups | Passed through canonical-catalog continuations after Windows fixture and reviewed emitter-inventory fixes |
| Integration groups | Tools 9, providers 8, storage 43, integrations 54, runtime 91 and TUI 9 pass; app latest full group 186/193, with subsequent fixes checked separately |
| Canonical platform and release groups | All 12 selected files passed; 38 release tests passed; 10 unrelated platform skips remain distinct from strict sandbox acceptance |
| Host-to-sandbox loopback diagnostic | Host controls pass; original PSEC and experimental internetClientServer modes fail on IPv4 and IPv6 with ETIMEDOUT (`build/ingress-aligned-final.log`) |
| Clean OS and legacy-only acceptance | Unavailable |

The current PSEC suite verifies reader/writer overlap in both launch orders,
admits divergent concurrent writers and changed denied-read policies because each
command carries its own kernel policy, and proves the reader cannot write or create
hardlinks. Full-filesystem coverage now exercises
allowed writes through a junction and rejected accesses through junction/hardlink
aliases of readonly or denied paths, with the secret unchanged and networking
still offline. Native lease regressions cover ancestor and outside write grants,
dot-segment traversal, different denies, full-filesystem policies and nonrecursive
volume-root reads.

Explicit native request coverage now uses a two-hop directory junction without
the Node adapter's prior canonicalization. Real writes verify the allowed target,
readonly and denied targets, and an outside sibling. Renaming the alias, intermediate
link or target fails while the workload runs. Canonical and aliased copies of the
same policy admit concurrency; a conflicting writer is rejected. Cycle handling is
bounded. Pins are released before journal cleanup, and abandoned placeholders are
recovered before acquiring new pins. Both shared missing-deny cleanup and recovery
after abrupt helper exit pass. Native snapshot tests exercise resolved local junction
grants while retaining readonly and denied masks.

The previous config failures are fixed. A repeated concurrent-writer probe captured
Windows `EPERM` during exclusive lock creation, rather than a lock timeout; bounded
retry preserves exclusive ownership and fails on persistent permission errors.
Cache status now distinguishes missing ancestors from file collisions on Windows.
Tools fixtures use platform PATH delimiters/executable names, compare supported
permission bits, and exercise Windows junction paths without requiring global
symlink privileges. POSIX file-symlink fixtures remain on other platforms. The
Full Access deny test now asserts forwarding into the helper and fail-closed
behavior when the helper is unavailable.

Real platform testing also exposed Node's Windows `kill("SIGBREAK")` behavior for
pipe processes: it killed the parent instead of invoking the child's console
handler. Pipe interrupt now uses explicit tree termination and reports termination;
the controller only waits for a graceful interrupt when delivery succeeded. The
real descendant-cleanup test now runs on local Windows as well as CI.

Quoted cmd commands previously received CRT backslash escapes instead of cmd's
command text, breaking quoted executable paths. Host pipe, ConPTY and the native
helper now preserve the canonical `/d /s /c` command using an outer quote pair.
Ordinary program argv encoding is unchanged. Real PSEC tests verify both allowed
and denied writes to quoted paths containing spaces and `&`.

Application fixtures now send CRLF to cooked Windows consoles and wait for the
actual `shell.completed` event: echo can finish a `WriteStdin` call before the
child exit arrives. The transport continues to preserve input characters exactly.

The storage failures are now fixed. Fixture directories are removed after every
primary, reopened and inspection connection has closed. Constructor initialization
failure also closes the SQLite database before rethrowing; a regression immediately
renames the file after a failed migration to verify Windows has released the handle.
Permission-mode assertions remain POSIX-only, while functional assertions execute
on Windows. All 373 storage tests pass without skips. Integrations fixtures also
close SQLite before removal and use directory junctions for escape tests on Windows;
the changed fixtures pass all 16 tests.

The earlier 71 runtime failures are resolved. Runtime and app SQLite fixtures close
connections before cleanup; filesystem and policy fixtures use native paths and
directory junctions for Windows escape checks. Unicode terminal fixtures run with
`TERM=xterm-256color` and `MYCLI_TUI_ASCII=0`, while dedicated ASCII tests retain
their own mode. The CJK resize test waits boundedly for its expected rendered frame.
All runtime, TUI (935) and app (474) unit tests pass. The syntax-level error-emitter
inventory was reviewed and regenerated for the policy-lock and sandbox boundaries.
Integration continuations now pass tools, providers, storage, integrations, runtime
and TUI. App integration initially reports 186 passed / 7 failed. The invalid-temp
fixture now sets Windows TEMP/TMP as well as TMPDIR, and the repaired-notification
assertion uses the actual native output path; both focused regressions pass. The
child environment snapshot also dropped PSEC's Windows startup variables, causing
real CreateProcessW error 203. It now retains only the additional non-secret Windows
keys, matching their names case-insensitively. Focused tests verify real child Shell
execution, persisted LOCALAPPDATA and continued exclusion of the API key. M7 now passes
workspace trust/revocation; at that point its two combined hook/plugin journeys still failed
because divergent overlapping writers were rejected. The later per-command PSEC alignment
removed that rejection and M7 passes 6/6. Full repository acceptance is not claimed. Tools
platform files run serially to avoid setup/maintenance racing active workloads.

The Hook host launcher now shares canonical cmd argument encoding with Shell.
The real bundle test executes a plugin path under a directory containing spaces
and `&`, using the platform's environment-variable syntax. Plugin fixtures close
workers before deleting their working directories; Windows cannot remove a live
process cwd. This change does not broaden the sandbox's filesystem grants.

Earlier focused evidence includes cross-layer policy/launcher tests (129/129),
release/catalog tests (44/44), Shell regressions (23/23), application interaction
tests (5/5) and all 10 canonical platform files. These are historical runs, not
new full-suite acceptance for the current candidate.

The plugin startup repair grants the fixed worker, package metadata, contracts and
installed dependencies, plus tsx dependencies in source mode. Node requires read
access to the dependency containers themselves before resolving a package. These
`node_modules` trees can include other installed dependencies; repository/home roots
are not granted. Runtime packages remain readonly, dependency containers cannot
overlap writable roots, and explicit readable-root bounds and denies are preserved.
The M7 hook and process-marker fixtures now reside within their authorized roots.
Source and compiled real-worker regressions prove own-root writes, denied sibling
reads/parent listing/runtime writes, API-key exclusion and explicit runtime denial.
A live plugin permits both independent and overlapping workspace writers, each under
its own command policy. Build, lint, workspace typecheck, contracts/config, release verification,
release compatibility, 38 release tests and 7 emitter/catalog tests pass. The reviewed
emitter inventory includes the new startup-validation errors, which are caught at
the existing plugin host boundary.

Tested helper SHA-256:
`502edb46e2dfa48e178ba3247531ae17cfe45e3463bc980a6b73eb71b2df1d05`.
Candidate SHA-256:
`a92008caa3b7991d0b624dcc981e9bf85e19793be81045a7b3e29ab1967d9853`.

The current candidate and partial evidence are retained under
`native/windows-sandbox-helper/build/extensions-release-evidence/` as
`cosmos2023-mycli-0.1.1.tgz` and `windows-package-smoke.json`. Complete smoke failed
twice while packing ripgrep because GitHub downloads timed out. A separate current
application pack was installed into a fresh prefix. Helper hash comparison, initial
setup-required handshake, installed setup, separate ready status and the exact
strengthened installed integrations journey passed. The latter really invokes the
compiled sandbox plugin and checks filesystem/environment boundaries. Evidence
records `status=partial`, `installed_journeys=0`, `plugin_sandbox_journey=passed`,
`fresh_setup=true` and `source_dirty=true`; it cannot authorize publication.
This is a fresh mycli installation on the existing host, not clean-OS acceptance.

The earlier complete 10-journey smoke is retained in `build/paths-child-release-evidence/`
with candidate SHA-256 `712933ee8cf891847d72e6f54e5dbfb8339b97cac8d8b1a5ff73026a756f9585`.
That result predates the plugin startup repair and is historical evidence only.

Current logs are under `native/windows-sandbox-helper/build/`:
`paths-ctest.log`, `paths-strict-windows.log`, `paths-npm-test.log`,
`paths-runtime-fixtures.log`, `paths-resume-tests.log`, `paths-resume-final.log`,
`paths-resume-contract.log`, `paths-resume-runtime-integration.log`,
`paths-final-platform-release.log`, `paths-child-final.log`,
`paths-child-package-smoke.log` and `paths-child-restore-status.json`.
Current extension logs include `extensions-isolation.log`, `extensions-plugins.log`, `extensions-m7.log`,
`extensions-package-smoke.err.log`, `extensions-partial-setup.log`,
`extensions-partial-status.log`, `extensions-installed-exact-journey.log` and
`extensions-restore-status.log`. The local reproduction scripts are
`build/verify-extension-package.mjs` and `build/verify-extension-installed.mjs`.
`ingress-capability-matrix.log` retains the earlier
failed ingress experiment; it was not rerun for this path-resolution change.
Evidence in `build/parity-release-evidence/`, `build/continue-release-evidence/`,
`build/final-release-evidence/`, `build/alignment-release-evidence/` and
`build/paths-release-evidence/` and `build/paths-final-release-evidence/` describe older
candidates only. Source setup/status
was restored to ready afterward and independently rechecked.
No publication, remote changes or GitHub CI runs were performed.

The 169 failed storage fixture directories remain in the local temporary directory.
An attempted cleanup verified each test-owned path, but automatic command approval
rejected the recursive deletion with `blocked by policy` and no more specific reason.
