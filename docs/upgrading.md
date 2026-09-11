# Upgrading And Rolling Back

Use a provider-free backup and validation flow before changing an installed mycli version. npm
versions are immutable, so choose an explicit published version rather than relying on a replaced
artifact.

## Package Name Migration

`@cosmos2023/app` is deprecated. The maintained package is `@cosmos2023/mycli`; both expose the
same `mycli` executable name.

```bash
npm uninstall -g @cosmos2023/app
npm install -g @cosmos2023/mycli
mycli --version
mycli doctor
```

Do not install both packages into the same global prefix. They own the same executable and the last
installation would obscure which implementation is running.

The package-name migration does not convert session databases. The published
`@cosmos2023/app@0.1.0` predecessor creates schema 9, while the current candidate starts writable
sessions only on a fresh schema 12 database. There is no in-place schema 9-to-12 path. Keep the
complete old `sessions.db`, `sessions.db-wal`, and `sessions.db-shm` set together and use the old
binary for those sessions. With every mycli process stopped, move that complete set to a backup
location before starting the maintained package with a fresh session database.

## Before An Upgrade

1. Finish or interrupt the active turn and stop background shells.
2. Exit every mycli process using the session.
3. Back up the complete `~/.mycli` directory, including `sessions.db` and configuration backups.
4. Run `mycli doctor --json` and keep only its bounded status, not local configuration or secrets.
5. Read [compatibility.md](compatibility.md) for the target release's Node, config, and session
   window.

Install the selected version, then validate the installed artifact:

```bash
npm install -g @cosmos2023/mycli@<version>
mycli --version
mycli config validate --strict
mycli doctor
mycli sandbox status
```

## Configuration Migration

Migration is explicit and optimistic. First preview the operation and capture the reported
`expectedVersion` without editing the source file:

```bash
mycli config migrate --dry-run --json
mycli config migrate --apply --expected-version <expected-version> --json
```

Apply returns a private `backupId`. Keep it until the upgraded CLI and configuration are verified.
If the source changed after preview, apply stops with a version conflict and creates no different
migration.

To restore the exact pre-migration paths:

```bash
mycli config migrate --rollback <backup-id> --json
```

Rollback is local and explicit. It does not downgrade the npm package, session database, or model
catalog. Credentials are never copied into migration output.

## Package Rollback

Confirm that the older release directly supports the current session schema before installing it.
The current policy permits downgrade only across the same schema. Maintenance inspection of an
older schema is not evidence that normal resume supports it.

```bash
npm install -g @cosmos2023/mycli@<previous-version>
mycli --version
mycli doctor
```

If the previous public identity is required for the documented 0.1.0 predecessor journey, remove
the maintained package first:

```bash
npm uninstall -g @cosmos2023/mycli
npm install -g @cosmos2023/app@0.1.0
```

Do not open a session when doctor reports a schema mismatch. Reinstall the compatible candidate or
restore the backed-up `~/.mycli` directory while all mycli processes are stopped. Never copy only
`sessions.db` without its related configuration and state files.

## Recovery

- A failed npm install does not authorize deletion of `~/.mycli`.
- A failed configuration apply can be retried only after a fresh preview.
- A missing migration backup cannot be reconstructed from release evidence.
- Registry, authentication, or network failures should be resolved before retrying; they are not
  proof that a package version is absent.
- Windows sandbox setup is machine state. After a package rollback, run `mycli sandbox status` and
  follow [windows.md](windows.md) rather than bypassing the helper.
