# Session Discovery And Recovery

mycli stores canonical session state in `~/.mycli/sessions.db`. The interactive TUI and the
provider-free `mycli session` commands use the same backend session service, ordering, filters,
metadata, and ownership rules. Listing or previewing a session never starts a provider request.

## Discover Sessions

Use the TUI `/resume` command to open the searchable session selector. Each row prioritizes the
session title or id, last activity, model and reasoning effort, collaboration mode, permission
profile, lifecycle status, owner lock, fork relation, and working directory.

The equivalent provider-free commands are:

```bash
mycli session list
mycli session list --last
mycli session list --all
mycli session list --workspace /path/to/project
mycli session list --search release --model gpt-5.6-sol
mycli session list --mode plan --permission full-access
mycli session list --status interrupted --limit 50
mycli session list --json
```

Results are ordered by most recent activity and then stable session id. By default, archived and
deleted sessions are hidden. `--all` includes both. Supported status filters are `active`,
`archived`, `deleted`, `waiting_approval`, `waiting_clarification`, and `interrupted`.

## Resume And Repair

Start the interactive UI on a known session with:

```bash
mycli session resume <session-id>
```

`/resume <session-id>` performs the same transition from an existing TUI. Before switching, mycli
builds a provider-free, non-mutating repair preview from the saved workspace, model, credential
reference, permission profile, metadata version, pending state, and owner lease.

When the session is ready, resume is immediate. Recoverable blockers open a keyboard-only selector:

- `unarchive` restores an archived session before resuming it.
- `fork_with_current_settings` creates a child using the current workspace, model, credential
  reference, and permission profile. The source transcript and preferences remain unchanged.
- `takeover_stale_owner` confirms replacement of a lease whose process is no longer running. The
  coordinator performs the replacement atomically when it acquires the session.

An active owner cannot be displaced. Missing or incompatible session state without a safe repair
remains blocked with one actionable diagnostic. Press Esc in the repair selector to cancel without
changing the source session.

Pending approvals and questions resume on their owning turn. Interrupted turns and recoverable tool
results are rebuilt from canonical transcript events, so the resumed TUI shows each notice once.

## Manage Sessions

These operations are provider-free:

```bash
mycli session fork <session-id> [new-session-id]
mycli session rename <session-id> "Release investigation"
mycli session archive <session-id>
mycli session unarchive <session-id>
mycli session delete <session-id> --force
mycli session export <session-id>
mycli session export <session-id> --json
```

A unique title may be used anywhere a session id is accepted. Ambiguous titles fail without
choosing a session. Archive is reversible. Delete is a logical tombstone, is hidden by default,
and requires `--force`; it does not rewrite raw storage or silently remove descendants. Active or
stale-owned sessions cannot be renamed, archived, or deleted through management commands.

Export returns bounded user and assistant text plus sanitized session metadata. It excludes API
keys, auth-store records, encrypted reasoning, provider bodies, tool arguments and output, and raw
SQLite rows.

## Session-Scoped Settings

An established session pins provider, protocol, model, endpoint identity, credential reference,
reasoning effort, collaboration mode, and permission profile. Those values survive process restart
without changing user defaults. A fresh or legacy session without a pinned value uses the current
default for that value. The working directory remains owned by the canonical session record rather
than the preference payload.

Use `/status` to inspect the active session lifecycle, lock, recovery state, effective permissions,
and sandbox readiness. Session summaries expose only `owned`, `active`, `stale`, or `unlocked` lock
states; they do not expose raw process identifiers.
