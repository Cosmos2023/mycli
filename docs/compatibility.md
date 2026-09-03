# Compatibility Policy

The machine-readable source of truth for release compatibility is
[`release/compatibility-policy.json`](../release/compatibility-policy.json). Run
`npm run release:compatibility` to detect drift between that policy, package manifests, runtime
schema constants, startup budgets, and these documents.

## Supported Runtime

| Surface | Supported contract |
| --- | --- |
| Node.js | 22.19.0 or newer; release CI tests 22.19.0 and Node 24 |
| Operating systems | Current macOS, Ubuntu, and Windows release runners |
| Public CLI package | `@cosmos2023/mycli`; executable name `mycli` |
| Model catalog | Provider-grouped catalogs are preferred; legacy flat catalogs remain readable |
| Configuration migration | Contract version 1 with explicit preview, apply, backup, and rollback |

The six public ripgrep packages are selected by operating system and CPU architecture. A packed
release gate validates all six artifacts; an installed smoke uses only the package for the current
host. Missing native sandbox support fails closed and is not treated as an unrestricted fallback.

## Configuration Window

The canonical user file is `~/.mycli/config.toml`. The legacy
`~/.config/mycli/config.toml` path remains readable and can be migrated explicitly:

```bash
mycli config migrate --dry-run
mycli config migrate --apply --expected-version <version>
mycli config migrate --rollback <backup-id>
```

Migration never runs during normal startup. Apply writes a private backup before changing the
canonical file. Rollback requires that backup id and restores the pre-migration paths. Provider
credentials are not part of the TOML migration and remain in `~/.mycli/auth.json` or the
environment.

Provider-grouped `models.json` is the maintained catalog format. Existing legacy flat catalogs are
still accepted so upgrading does not require an immediate rewrite. In provider-grouped version 2,
catalog-backed `models` entries are overrides or explicit additions; the route follows new models
from the pinned pi-ai catalog unless it declares `model_policy: "subset"`. Legacy flat catalogs keep
their explicit-subset behavior.

## Session Window

The current runtime session schema is `12`. Normal startup and resume directly read schema `12`
only. The provider-free session maintenance path can inspect schemas `9`, `10`, `11`, and `12`, and
offers these explicit forward migrations:

| From | To | Maintenance action |
| ---: | ---: | --- |
| 9 | 10 | `/session maintenance --apply-transcript-normalization` |
| 10 | 11 | `/session maintenance --apply-content-blobs` |

Inspection support does not make an older schema directly resumable. Back up `~/.mycli` before a
package downgrade or maintenance migration. Downgrade is supported only when the target release
uses the same session schema; mycli does not silently rewrite sessions for an older release.

## Deprecations

Stable deprecations include introduction, deprecation, removal, replacement, and migration fields
in the policy file.

| ID | Subject | Introduced | Deprecated | Removed | Replacement |
| --- | --- | --- | --- | --- | --- |
| `npm-package-cosmos2023-app` | `@cosmos2023/app` | 0.1.0 | 0.1.0 | Not scheduled | `@cosmos2023/mycli` |

The old package is retained only as the real published predecessor used by compatibility testing.
New installations must use `@cosmos2023/mycli`. See [upgrading.md](upgrading.md#package-name-migration)
for the replacement procedure.

## Release Evidence

`.github/workflows/release-compatibility.yml` runs the packed candidate on macOS, Ubuntu, and
Windows. It validates configuration migration and rollback, session resume, update non-blocking
behavior, sandbox readiness, completions, no-color output, and non-TTY management commands. A
separate registry-backed journey installs the real predecessor, upgrades to the candidate,
downgrades, and rolls the migration back. Each platform artifact contains one packed-journey
summary and one upgrade/downgrade summary.

Registry or network unavailability is recorded as `blocked_external` with a bounded stage and
error code. It is never reported as a product pass. Candidate failures always fail the gate. The
tag release workflow applies the same checks strictly before npm publication.

Startup evidence uses the checked-in fixture at
`tests/fixtures/configuration_ux/baseline.json`. No update, doctor, or migration network operation
may be awaited before first paint, and packed native PTY readiness is bounded to 5000 ms. Evidence
contains structural status only; credentials, prompts, provider bodies, command output, and local
absolute paths are excluded.

The complete eight-outcome roadmap mapping is in
[parity/configuration-ux-release-evidence.md](parity/configuration-ux-release-evidence.md).
