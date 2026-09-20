# Releasing mycli

mycli coordinates one version across 16 components, while publishing only `@cosmos2023/mycli` and six
optional ripgrep platform packages. The other nine runtime workspaces are private and are vendored
under the app's `dist/node_modules` directory during packing. The workspace root is never published.

## One-Time Repository Setup

1. Ensure the npm account owns the `@cosmos2023` scope and has publish access to all seven public
   packages.
2. Create a protected GitHub environment named `npm`. Require a reviewer so pushing a version tag
   cannot publish without a separate approval.
3. Configure npm Trusted Publishing for `.github/workflows/release.yml` on all seven public packages.
   The workflow grants only `id-token: write` and `contents: write` in the protected publish job.
4. For the first release, packages that do not exist yet may need a granular npm access token in
   the environment secret `NPM_TOKEN`. After bootstrapping the packages and configuring Trusted
   Publishing, remove that secret. An explicit token takes precedence over OIDC.

Never commit an npm token or write one into a project `.npmrc`.

## Prepare A Version

Start from a clean, current `main` checkout. Do not release from a feature worktree.

```bash
npm ci
npm run release:version -- 0.2.0
npm install --package-lock-only --ignore-scripts
npm run release:verify
npm run release:compatibility
npm run contracts:check
npm run lint
npm run test:ci
npm run typecheck
npm run smoke:m8
npm run smoke:package -- --all-platforms
npm run smoke:release-compatibility -- --evidence release-evidence/local.json
```

When credentials are available, run the opt-in curated-provider smoke after the deterministic
gates and retain only its redacted evidence:

```bash
npm run smoke:providers -- --dry-run
npm run smoke:providers -- --evidence release-evidence/providers-live.json
```

Rows without credentials remain `skipped`; only `passed` rows may be described as live-verified.
See [providers.md](providers.md) for single-provider launch-scoped key usage and evidence fields.

`release:version` updates all coordinated manifests, internal dependency specifications, and the
workspace lockfile. Refresh registry resolution with `npm install --package-lock-only --ignore-scripts`
after a version change, then verify `npm ci` succeeds. Existing ripgrep lock entries must match the
coordinated version; stale platform package entries fail `release:verify`.
`release:verify` also fails when the root is publishable, a public package is private,
a vendored workspace is public, the app dependency closure is incomplete, versions drift, or
publish access is invalid.

Review and commit the version change before tagging. A local package publication preview is also
available:

```bash
npm run release:dry-run
```

The preview builds every workspace and invokes `npm publish --dry-run` for all seven public
packages. It does not publish, tag, or create a GitHub Release. The complete CI package smoke
additionally inserts the Windows sandbox helper compiled by the Windows release job. Publish
commands use the ignored workspace cache at `.npm-cache/release`, so a broken or differently owned
user-level npm cache does
not make the release result machine-dependent.

## Publish

Create an annotated tag matching the manifest version and push it:

```bash
git tag -a v0.2.0 -m "mycli v0.2.0"
git push origin v0.2.0
```

The independent `release-compatibility` workflow runs installed-artifact journeys on macOS, Ubuntu,
and Windows. Its registry-backed predecessor journey exits `77` or records `blocked_external` only
for a bounded registry/network infrastructure failure; candidate product failures remain hard
failures. A tag release repeats this journey strictly and does not waive an external blocker.

The release workflow then:

1. builds the Windows sandbox helper and requires native tests plus all 13 Windows platform tests
   without skips (and all six feature-parity tests when PSEC is selected), then installs the packed candidate on a separate fresh Windows runner, completes
   setup and independently verifies `sandbox status` is `ready`;
2. verifies the tagged commit belongs to `main` and validates the tag and coordinated metadata;
3. runs contract, lint, categorized test, typecheck, compatibility-policy, M8 smoke, packed-artifact, and real
   predecessor upgrade/downgrade gates;
4. publishes the six platform packages followed by the exact application tarball tested on Windows;
5. publishes stable versions under `latest` and prereleases under `next`;
6. creates a GitHub Release only after npm publication succeeds.

The publisher pins the public npm registry and uses provenance. Real publication requires both the
`--publish` mode embedded in `release:publish` and an explicit `--confirm X.Y.Z` matching the app
manifest, plus `--candidate <app.tgz> --windows-evidence <windows-packed.json>`.
Before registry lookups or publication, the evidence must report fresh setup and `ready`, match
the current Git commit and version, originate from a clean tracked worktree, and match SHA-256
hashes of the candidate tarball and tested helper. Missing, stale or mismatched evidence fails closed.
A rerun checks each exact package version first, skips versions already published, and
continues from the first missing package. Authentication, connectivity, and other non-404 registry
errors stop the release instead of being treated as missing packages.

The same installed-package gate can run locally without starting GitHub CI. First complete the
[native and 13-test acceptance](../backend/packages/tools/native/windows/README.md), then use a
fresh Windows VM or dedicated test machine with that same checkout and helper:

```powershell
$ErrorActionPreference = "Stop"
npm ci
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed" }
npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed" }
New-Item -ItemType Directory -Force release-evidence | Out-Null
node scripts/smoke_packed_cli.mjs --require-windows-ready --setup-windows-sandbox --artifacts-dir release-evidence |
    Out-File -Encoding utf8 release-evidence/windows-packed.json
if ($LASTEXITCODE -ne 0) { throw "Installed Windows sandbox gate failed" }
```

PowerShell 5.1 writes a UTF-8 BOM with this command; the evidence reader accepts it.
Keep the JSON and retained application `.tgz` together. `--require-windows-ready` implies helper
inclusion and rejects unavailable status. `--setup-windows-sandbox` also requires no existing
managed state before setup; it must not be used to reset a daily-use machine. A temporary npm
directory is not a clean OS. Testing existing ready state without this setup flag is useful locally
but does not produce fresh-install evidence accepted by the publisher. The ordinary
`--require-windows-helper` smoke checks packaging and still permits unavailable sandbox status.

## Failed Or Partial Release

Do not delete or replace versions already accepted by npm. Fix the workflow or infrastructure
failure, then rerun the failed GitHub Actions job. The ordered publisher safely skips completed
packages.

If no package was published, delete the bad tag, correct the release commit, and create a new tag.
If any package was published, keep the immutable version and finish that same release; publish a
new patch version for code corrections. Rollback for users is installation of the previous app
version:

```bash
npm install -g @cosmos2023/mycli@0.1.0
```

Compatibility windows, package-name migration, configuration rollback, and session-schema limits
are documented in [compatibility.md](compatibility.md) and [upgrading.md](upgrading.md). Release
operators must update [../CHANGELOG.md](../CHANGELOG.md) and [release-notes.md](release-notes.md)
before creating the tag.
