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

1. PowerShell 7 (`pwsh.exe`)
2. Windows PowerShell 5.1 (`powershell.exe`)
3. Command Prompt (`cmd.exe`)

The model sees one cross-platform `Shell` contract plus the relevant input/output control tools.
It does not receive separate Bash, PowerShell, and CMD schemas.

Configure an explicit shell in `~/.mycli/config.toml`:

```toml
[shell]
path = "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
```

Or set a temporary override:

```powershell
$env:MYCLI_SHELL_PATH = "C:\Program Files\PowerShell\7\pwsh.exe"
npm run mycli
```

Invalid paths and unknown executables are ignored, automatic detection continues, and
`mycli doctor` reports the selected shell without exposing command or environment values.

CMD is the final supported fallback. Its approval parser is intentionally conservative: expansion,
redirection, pipes, chained commands, or unknown syntax may require confirmation.

## PTY And Sandbox

Interactive shell sessions use `node-pty` and ConPTY. Restricted process profiles use the packaged
`backend/packages/tools/native/windows/mycli-windows-sandbox.exe` helper built from
`native/windows-sandbox-helper`. A missing or invalid helper returns `sandbox_unavailable`; mycli
does not run the command unrestricted. The first restricted command initializes separate local sandbox identities for unrestricted
networking, offline execution, and domain-constrained proxy access. Windows displays a UAC prompt for this one-time setup;
mycli waits for setup to finish and verifies it before running the command.

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

All maintenance commands preview their effects until `--confirm` is present. Setup, repair, and
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

Existing `.git`, `.agents`, and `.codex` paths are protected from writes. Metadata junctions or
symlinks are rejected. Ordinary junctions cannot grant writes outside the allowed roots. Windows
ACL protection applies to existing objects; it does not reserve absent metadata names. Arbitrary
process read allowlists, and unrestricted filesystem access combined with constrained networking,
are rejected before launch. Full Access with unrestricted networking runs on the host intentionally.

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
reject process launches with these rules instead of ignoring them. Arbitrary Windows read
allowlists remain unsupported.

Each Windows sandbox runner owns a private desktop. Its restricted children use that desktop and
receive access for their actual logon SID; they do not attach to the interactive desktop. A bounded
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

The current sandbox changes are still under Windows integration validation. An earlier revision
passed native compilation, protocol tests, restricted-token primitives and setup on Server 2022
and 2025; the complete Shell/ConPTY/proxy suite has not passed yet. The current helper has also passed local Windows-target cross compilation. The latest native
changes still need MSVC compilation and runtime testing on Windows before release.

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
mycli sandbox setup --confirm
node --conditions=mycli-source --import tsx --test backend/packages/tools/test/sandbox/windows-sandbox.platform.test.ts
```

Reset/reinitialization tests are excluded unless `MYCLI_WINDOWS_SANDBOX_SETUP_TESTS=1` is set.
Repair/uninstall tests also require `MYCLI_WINDOWS_SANDBOX_MAINTENANCE_TESTS=1`.
Enable these only on a disposable machine: they stop sandbox processes and modify dedicated accounts.
Release acceptance must enable both opt-ins; see the helper README for the local PowerShell commands.

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
