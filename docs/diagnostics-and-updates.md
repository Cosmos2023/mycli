# Diagnostics And Updates

mycli exposes one provider-free health report and one conservative cached update flow. Neither
surface sends prompts, tool content, credentials, or raw provider responses to a support service.

## Diagnostics

Run the concise local report first:

```bash
mycli doctor
mycli doctor --verbose
mycli doctor --json
mycli doctor --fix --json
mycli doctor --support-bundle --json
```

The default report checks authoritative local configuration, credential readiness, sandbox and
terminal support, session storage and ownership, extensions, and cached update state. It does not
call a model provider. One collector failure becomes one bounded diagnostic and does not prevent
the remaining collectors from running.

Every row has a stable category and code, a short summary, optional bounded details, remediation,
recovery actions, and collector duration. `--verbose` shows those details in the human report.
`--json` emits the same structured rows plus a bounded support manifest containing only runtime
versions, platform identity, diagnostic codes, and safe log references.

Diagnostic output excludes API keys, environment values, prompts, commands, tool content, raw
provider bodies, internal stacks, and unnecessary absolute paths. Share the stable category, code,
and remediation instead of copying private configuration or session files.

`mycli doctor --fix` is a read-only repair preview. It returns a plan id bound to the listed actions,
value-free configuration changes, and authoritative source versions. Apply that exact plan with:

```bash
mycli doctor --fix --confirm <plan-id>
```

mycli rebuilds the plan before applying it. A changed source returns `version_conflict`; it never
silently applies the replacement plan. Repairs are reported individually, reuse their owning
services, and continue to exclude provider calls, package installation, privilege escalation, and
arbitrary shell scripts.

`mycli doctor --support-bundle` writes `~/.mycli/support/diagnostic-support.json` using a private
atomic replacement. The deterministic schema contains allowlisted diagnostic rows, configuration
layer metadata, Sandbox/session/extension readiness, runtime versions, and relative log references.
It does not copy logs, transcripts, prompts, commands, tool content, provider bodies, credentials,
headers, internal stacks, or unnecessary local paths, and mycli never uploads it automatically.

## Cached Update Checks

Startup reads `~/.mycli/version.json` once and immediately continues with that cached state. A
missing or older-than-20-hours cache starts a five-second npm registry refresh in the background.
The refresh never delays runtime readiness or first TUI paint. A version fetched in the background
is first eligible for a notice on the next startup.

Only a strict stable semantic version for `@mycli/app` can be advertised. Offline requests,
timeouts, malformed responses, cache corruption, and failed cache writes are non-fatal and preserve
the previous valid cache. The cache is private, versioned, bounded, locked, and replaced atomically.

Inspect or refresh update state without starting the agent:

```bash
mycli update
mycli update status
mycli update check
mycli update --json
```

Inside the TUI, `/update` shows the cached state and installation guidance. `/update check` is the
only TUI form that explicitly contacts the registry. mycli reports an npm, pnpm, Yarn, or Bun
command when the installation method is known; otherwise it labels the npm command as a manual
fallback. It never launches a package manager or requests elevated permissions.

Dismiss only the currently advertised version with either command:

```bash
mycli update dismiss 0.2.0
/update dismiss 0.2.0
```

Dismissing version X suppresses X only. A later version Y remains eligible for a future startup
notice.

Disable all automatic startup refreshes and notices through canonical user configuration:

```bash
mycli config set updates.check_on_startup false
mycli config get updates.check_on_startup
```

An explicit `mycli update check` or `/update check` still performs the user-requested registry
check. Re-enable automatic checks with `mycli config set updates.check_on_startup true`.
