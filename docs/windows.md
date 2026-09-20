# Windows Source Checkout

mycli runs natively on Windows through Node.js. Git Bash and a separate language runtime are not
required by the installed npm CLI.

## Requirements

- Node.js 22.19 or newer; Node 24 is supported.
- npm and Git.
- Visual Studio Build Tools only when npm must compile a native dependency instead of using a
  prebuilt binary.

Install and run from PowerShell:

```powershell
npm ci
npm run build
npm run mycli
```

## Shell Selection

mycli detects the command runtime in this order:

1. `MYCLI_SHELL_PATH`, resolved through `PATH` when it is a bare command name
2. PowerShell 7 (`pwsh.exe`)
3. Windows PowerShell 5.1 (`powershell.exe`)
4. Command Prompt (`cmd.exe`)

The model sees one cross-platform `Shell` contract plus the relevant input/output control tools.
It does not receive separate Bash, PowerShell, and CMD schemas.
The environment context reports the active shell family and dialect so the model writes commands
the selected shell can actually run.

Override detection for one process:

```powershell
$env:MYCLI_SHELL_PATH = "C:\Program Files\PowerShell\7\pwsh.exe"
npm run mycli
```

An absolute path that does not exist and a bare name that is not on `PATH` are ignored, and
automatic detection continues. `mycli doctor` reports the selected shell and dialect without
exposing command or environment values.

Shell output is pinned to UTF-8: CMD commands run behind `chcp 65001`, and PowerShell commands set
`[Console]::OutputEncoding` and `$OutputEncoding` before the command text. Output that still arrives
in the console code page, such as a legacy console program on a CP936 host, is decoded with that
code page instead of degrading into replacement characters.

CMD is the final supported fallback. Its approval parser is intentionally conservative: expansion,
redirection, pipes, chained commands, or unknown syntax may require confirmation. PowerShell review
accepts the `&` call operator that precedes a quoted executable path.

## PTY And Sandbox

Interactive shell sessions use `node-pty` and ConPTY. Restricted process profiles use the packaged
`backend/packages/tools/native/windows/mycli-windows-sandbox.exe` helper built from
`native/windows-sandbox-helper`. A missing or invalid helper returns `sandbox_unavailable`; mycli
does not run the command unrestricted. On a capable Windows host with no legacy setup, the helper
selects PSEC (Process Security Environment). Setup records local state without UAC, dedicated
accounts, third-party ACL changes, or persistent firewall rules. `sandbox status` reports
`isolation=windows_psec`. Capability detection creates a real environment and tests its process
startup attribute; a Windows version number alone is insufficient.

Older hosts and existing account-based installations retain `windows_restricted_token`, with
three dedicated identities and UAC setup. The following account/ACL maintenance descriptions apply
to that backend. A recorded PSEC installation never silently downgrades if enforcement disappears.

Inspect or recover the same state without starting the TUI or a provider:

```powershell
mycli sandbox status
mycli sandbox setup
mycli sandbox setup --confirm
mycli sandbox reset
mycli sandbox reset --confirm
mycli sandbox repair
mycli sandbox repair --confirm
mycli sandbox uninstall
mycli sandbox uninstall --confirm
```

All maintenance commands preview their effects until `--confirm` is present. PSEC reset refuses
active helpers; repair/uninstall stop them and clean tracked state and empty placeholders without
elevation. PSEC repair rechecks native support. On the account backend, setup, repair, and
uninstall can display UAC; canceling reports `operation_canceled`. `reset` clears credentials and
setup markers while retaining dedicated accounts and network restrictions. It first cleans recorded
filesystem ACLs and refuses to run while sandbox commands remain active.

`repair` stops sandbox processes, removes stale recorded ACLs, refreshes account credentials and
network rules, and verifies readiness. It never reruns a user command. `uninstall` stops helpers,
disables sandbox accounts, terminates their remaining processes, removes recorded filesystem and
WFP access grants, removes firewall/WFP rules, deletes owned account profiles and accounts, and
clears known state files. It does not recursively delete the state directory or user workspaces.
Only empty directories created to reserve denied paths are removed. Failures keep recovery records
for retry; unknown or unrelated accounts are never reset or deleted solely by name.

`status` and `mycli doctor --verbose` show bounded typed codes. Uninstall additionally verifies that
managed account/state markers are absent; an unready sandbox alone is not proof of successful
uninstall. Native helper output, local paths, and stacks are not printed by the management CLI.

Read Only denies workspace writes and starts offline. Workspace permits only its configured writable
roots and enables networking by default. Offline and online commands use distinct accounts, so
concurrent commands cannot change each other's network policy. Domain-constrained commands use a
third account: WFP permits only the current logon's TCP connection to its own runtime proxy. See
[network-policy.md](network-policy.md) for supported HTTP/HTTPS traffic.

The `.git`, `.agents`, and `.codex` paths are protected from writes. PSEC also reserves missing
metadata names for the command lifetime and removes only its empty placeholders afterward.
Metadata junctions or
symlinks are rejected. Ordinary junctions cannot grant writes outside the allowed roots. Windows
ACL protection on the legacy backend applies only to existing metadata objects. The legacy backend
rejects custom process read roots and unrestricted filesystem access with constrained networking;
PSEC supports both. Full Access with unrestricted networking and no explicit filesystem restrictions
runs on the host intentionally.

## Denied Reads And Desktop Isolation

Windows helper protocol v2 supports managed denied-read rules. Put them in
`~/.mycli/managed_config.toml`, not the repository config:

```toml
[execution_policy]
denied_read_roots = ['C:\Users\you\private', 'C:\work\project\secrets']
denied_read_globs = ["**/.env", "**/.env.*", "**/secrets/**"]
```

Exact roots must be absolute. Globs use forward slashes and are relative to the active workspace.
They include dotfiles and are expanded into a bounded snapshot before process launch (2 seconds,
50,000 inspected entries, 1,024 matched roots). Exceeding a bound fails the launch; use exact roots
for large trees. Directory junctions are not recursively scanned by glob expansion; protect their
canonical targets with exact roots. Newly created glob matches are covered on the next launch.
Missing exact roots are reserved as directories, so these paths cannot later be created without
protection. Denied objects cannot be read, changed, or replaced by sandbox commands.

The same constraints reach Shell, stdio MCP, plugin/hook subprocesses, Read, view_image, file
mutation previews, and child-agent snapshots. Grants and Full Access do not remove managed denies;
a managed denied-read policy selects a restricted filesystem profile. Other platforms currently
reject process launches with these rules instead of ignoring them. The legacy Windows backend
rejects custom read roots; PSEC supports additional read roots alongside its platform reads.

Each Windows sandbox runner owns a private desktop. Children receive access for their logon SID
or exact PSEC container SID, and do not attach to the interactive desktop. On the legacy backend, a bounded
preflight audit checks common directories for Everyone write grants outside the allowed roots and
adds capability-specific write denies. It skips reparse points and inaccessible ACLs, and is not a
whole-disk scan. Failure to apply a discovered deny blocks the launch.

Filesystem ACL mutations are journaled before application under the protected sandbox state
folder. Path components are pinned against rename/reparse replacement during ACL changes.
Concurrent commands with the same denied-read snapshot are allowed. Changing that snapshot while
another sandbox process is active fails closed; stop the affected Shell/MCP processes first.
Once no helpers remain, the next launch reconciles old ACLs. Cleanup removes mycli-owned SID entries
and tracked WFP permission bits while preserving unrelated principals and permissions. Changes made
by older helpers before journaling existed cannot be fully reconstructed from these records.

## Verification

### PSEC Compatibility And Boundaries

Managed policy in `~/.mycli/managed_config.toml` supports these PSEC settings:

```toml
[execution_policy]
readable_roots = ['C:\shared']
readonly_roots = ['C:\repo\vendor']
allow_local_binding = false
writable_tmp = true
```

Readable roots extend process reads alongside platform/runtime roots. Readonly roots prevent
writes even inside writable roots and cannot be removed by file-tool approvals or child agents.
The legacy Windows backend rejects these PSEC options. Other platforms reject unsupported options.

`allow_local_binding=true` explicitly permits access to all IPv4/IPv6 host loopback ports in proxy
mode, including local services outside the domain proxy. The default remains the single owned
proxy TCP port. Offline mode stays offline. Local binding and outbound connections are verified;
host-to-sandbox service connections are blocked by the Windows Firewall's built-in
`AppContainerLoopback` filter. mycli matches Codex's design and does not request the
administrator-only per-identity loopback exemption, so inbound service access stays
unsupported. See the [feature comparison and evidence](parity/windows-sandbox-feature-parity.md).

Workspace/full requests default to a private journaled `TMPDIR`; read-only requests default off.
`writable_tmp=false` disables that additional directory, but Windows PSEC still supplies its own
private `TEMP/TMP`. Neither is the host's temporary directory. Cleanup handles nonempty trees and
recovers recorded directories after a helper crash when the next command starts. Concurrent
commands defer journal cleanup until the last helper exits.

Full filesystem access with constrained networking snapshots accessible logical drives and their
immediate entries. It keeps explicit readonly/deny rules and workspace metadata protection. It
resolves supported local junction/symlink targets before applying restrictions. It does not grant
inaccessible or sharing-locked entries, arbitrary UNC shares or volume-GUID reparse targets.
Large policies use a validated environment carrier, at most 1,000,000 UTF-8 bytes; its
variables are removed before the command starts.

### Structured Egress Rules

Managed policy may replace the coarse network switch with a deny-by-default allowlist:

```toml
[execution_policy]
network = "enabled"

[execution_policy.network_egress]
default = "deny"

[[execution_policy.network_egress.allow]]
to = [{ cidr = "10.0.0.0/8", except = ["10.1.0.0/16"] }]
ports = [{ protocol = "tcp", port = 443, end_port = 444 }]
```

Rules accept IPv4/IPv6 CIDRs with optional exclusions, port ranges and TCP/UDP/ICMP
protocols; the helper bounds every list (32 rules, 8 destinations, 8 exclusions, 8
port entries). Host loopback is authorized only by an explicit rule, so the policy
always uses a deny default; plain `network = "enabled"` without rules remains the
allow-everything profile. Structured rules are PSEC-only: the legacy backend fails
closed with `sandbox_policy_requires_psec`, and the rules cannot be combined with
`allowed_network_domains` (managed proxy) or disabled networking.

PSEC enforces filesystem and per-process TCP/UDP policy even on paths with NULL DACLs. Offline
traffic is denied; domain-constrained commands by default can connect only to their assigned IPv4 loopback
TCP proxy port. UDP verification checks actual receiver traffic, because a successful send call
does not prove delivery. Network and process-tree policies also apply to descendants.

Read access includes workspace roots, Windows, Program Files, ProgramData, existing absolute PATH
directories and the command executable's parent. It does not grant whole-drive reads to make tools
start. Private siblings stay unreadable. Denied roots override these grants, including existing
hardlink aliases of denied or read-only paths. Protected trees containing reparse points fail
closed, and alias expansion for those trees keeps its 250,000-entry limit.

Writable roots are not enumerated at launch. A hardlink alias that the host created inside a
writable root is therefore accepted, and a command that writes through it reaches the file the
alias points to; this matches the shipped Codex Windows sandbox, which accepts the same case. PSEC
still denies every link creation inside the sandbox, so only an actor outside the sandbox can
introduce such an alias. Launch preparation no longer depends on workspace size.

The native helper accepts explicit local junction/symlink roots and pins every link and target
component through execution. Handle-derived paths normalize 8.3 aliases before concurrency checks.
Resolution is bounded to 32 link hops and 16,384 handles; cycles and unsupported reparse types fail
closed. The Node adapter already canonicalizes its policy roots. Reparse points nested inside a
protected tree remain rejected. Request pins are released before journaled placeholder cleanup.

Windows PowerShell starts on an internal `MycliWorkspace:` provider drive rooted at the workspace;
native programs still receive the real cwd. PSEC launches set Node's `--preserve-symlinks` and
`--preserve-symlinks-main` options so module loading does not enumerate private ancestors. Projects
that depend on Node's default symlink canonicalization need compatibility testing. PSEC still
checks resolved targets, so these options do not authorize junction or hardlink escapes.

The journal serializes preparation, placeholder bookkeeping and cleanup but no longer rejects a
command because a peer with a different filesystem policy is active. Each PSEC launch translates
its own request into a kernel policy, so a workspace-wide hook and a plugin that only writes its
own directory coexist; this matches the pinned Codex MXC adapter, which edits no host ACLs. The
legacy restricted-token backend keeps the stricter rule because it edits shared host ACEs and
requires matching active policies. Policy scans are snapshots: an alias that already exists and is
renamed into a running command's scope afterwards is not revoked, and a command only gets the
denies it requested. Journaled cleanup (missing deny/placeholder paths and private temporary
directories) is deferred until the last active sandbox command exits, so a finished command's
temporary tree can briefly outlive it while a peer is still running. Pins prevent protected path
replacement during execution. This is process
isolation on a trusted host, not a defense against an administrator, a compromised kernel, or an
unsandboxed process deliberately modifying the workspace during policy preparation. No single
`ready` response replaces the full native, Shell/ConPTY, network and installed-package gates.

The PSEC implementation is validated on the local Windows 11 host; older Windows backends still
need their own enforcement runs. Local setup is not a clean Windows installation. See
[the local verification report](parity/windows-sandbox-local-verification.md) for the exact gates
and outstanding release evidence.

After building the helper, `npm run sandbox:check-host` runs a read-only host preflight without
setup or elevation. For PSEC it checks environment creation and the startup attribute. For the
legacy backend it reports known NULL DACL blockers and partial scan coverage. It does not
replace `sandbox status` or prove complete isolation. See [host compatibility findings and the
optimization plan](parity/windows-sandbox-host-optimization.md).

```powershell
npm run contracts:check
npm test
npm run typecheck
npm run smoke:m8
npm run smoke:package
```

To run only the sandbox integration suite on a Windows development machine, build the helper
as described in [the native helper README](../backend/packages/tools/native/windows/README.md),
then run:

```powershell
npm run dev -- sandbox setup --confirm
if ($LASTEXITCODE -ne 0) { throw "Sandbox setup failed" }
npm run dev -- sandbox status
if ($LASTEXITCODE -ne 0) { throw "Sandbox is not ready" }
$env:MYCLI_WINDOWS_SANDBOX_SETUP_TESTS = "1"
$env:MYCLI_WINDOWS_SANDBOX_MAINTENANCE_TESTS = "1"
npm run test:windows-sandbox
if ($LASTEXITCODE -ne 0) { throw "Windows isolation tests failed" }
```

Reset/reinitialization tests are excluded unless `MYCLI_WINDOWS_SANDBOX_SETUP_TESTS=1` is set.
Repair/uninstall tests also require `MYCLI_WINDOWS_SANDBOX_MAINTENANCE_TESTS=1`.
Enable these only on a disposable machine: they stop sandbox processes and modify dedicated accounts.
Release acceptance must enable both opt-ins; see the helper README for the local PowerShell commands.
The strict runner requires the original 13 passes with zero skipped, cancelled or todo tests.
When the helper selects PSEC, it additionally requires all seven PSEC parity tests without skips.
Stop at any failed step. A host NULL DACL is not an empty ACL: it permits access to everyone, and
the sandbox refuses to replace it. Do not bypass this failure to obtain passing results.

After native and platform tests pass, `npm run smoke:package -- --require-windows-ready` requires
the installed candidate's status to be `ready` and verifies its packaged helper. For a fresh
installation, additionally pass `--setup-windows-sandbox`; this refuses existing managed state,
runs confirmed setup, then checks status again. These operations affect actual machine state;
changing HOME or the npm installation directory does not create a clean Windows environment.
The release workflow requires this fresh Windows package gate before publication and publishes
the exact tested tarball. See [releasing.md](releasing.md).

CI covers Node 22.19 and Node 24 on Windows and separately compiles/tests the sandbox protocol,
restricted-token primitives, filesystem policy, and network policy on Windows Server 2022 and 2025.
The Windows gate exercises the actual Node Shell adapter, helper, ConPTY, Unicode/short paths,
online/offline concurrency, domain proxy isolation, process-tree cleanup, and reset/reinitialization.
Release artifacts are uploaded only after this same gate passes. Release compatibility uses the
stable `windows-2022` image, installs the packed candidate, and uploads a sanitized structural
evidence file. It never records local paths, commands, credentials, provider content, or native
helper stderr.

For a package upgrade or downgrade, stop all mycli windows first, back up `%USERPROFILE%\.mycli`,
and follow [upgrading.md](upgrading.md). Sandbox machine state is not part of the npm or
configuration rollback; run `mycli sandbox status` after changing versions.
