# Coordinated npm Release Contract

## Scenario: Publish a mycli version

### 1. Scope / Trigger

Apply this contract whenever a runtime workspace, ripgrep platform package, package dependency, or
user-visible runtime version changes. mycli uses one coordinated version for 16 components, but
publishes only `@cosmos2023/mycli` and six ripgrep platform packages. Nine private runtime workspaces are
vendored into the app tarball; the workspace root is never published.

### 2. Signatures

```text
npm run release:version -- <semver>
npm run release:version -- --check [semver]
npm run release:verify -- [--tag v<semver>] [--require-windows-helper]
npm run release:compatibility
npm run release:dry-run
npm run smoke:package -- [--all-platforms] [--require-windows-helper]
npm run smoke:release-compatibility -- [--allow-external-blocker] [--evidence <path>]
npm run release:publish -- --confirm <semver> [--tag <dist-tag>] [--provenance]
```

`scripts/release-config.mjs` is the canonical inventory for both versioned and published packages.
Platform packages precede `@cosmos2023/mycli`; private runtime workspaces are versioned but never sent to
the registry.

### 3. Contracts

* Root `package.json`: `private: true`.
* Public application identity: npm package `@cosmos2023/mycli` with
  `bin.mycli = "dist/cli.js"`.
* Every published manifest: the coordinated `version`, `private: false`, and
  `publishConfig.access: "public"`.
* Every vendored workspace manifest: the coordinated `version`, `private: true`, and no
  `publishConfig`.
* Internal dependency ranges: the same coordinated version, retaining only an existing `^` or `~`
  prefix.
* Application artifact: all nine private workspaces under `dist/node_modules`, including each
  workspace's declared runtime files. The app manifest exposes their complete third-party
  dependency closure and the six optional platform packages, but no private workspace dependency.
* Ripgrep resolution: the matching optional platform package precedes the generic package vendor,
  user vendor, and existing `PATH`. `ShellEnvironmentInput.platformPackageRoot` is a deterministic
  test/tooling override: `undefined` performs normal package discovery and `null` disables only the
  platform-package candidate without changing production defaults.
* Runtime identity: app, integrations, and TUI read their own published package manifest through
  the shared pure `parsePackageVersion()` validator.
* Compatibility policy: `release/compatibility-policy.json` is the single machine-readable source
  for supported Node/platforms, config and catalog formats, directly readable and
  maintenance-inspectable session schemas, deprecations, predecessor identity, and documentation
  paths. `scripts/verify-release-compatibility.mjs` must compare it with runtime constants,
  manifests, startup budgets, workflow matrices, and referenced documents.
* Session compatibility: schema 12 is fresh-only. The normal runtime reads schema 12 directly;
  maintenance may inspect schemas 9-12, but there is no in-place schema 9-to-12 or v11-to-v12
  migration. Release and upgrade guidance must not imply that predecessor sessions are converted.
* Registry: always `https://registry.npmjs.org/`; npm cache is `.npm-cache/release`.
* CI: a `v<semver>` tag on `main`, protected `npm` environment, Windows helper artifact,
  `id-token: write`, and optional `NPM_TOKEN` only for bootstrap/fallback authentication.
* Stable versions publish under `latest`; prereleases publish under `next`.
* Evidence: `.github/workflows/release-compatibility.yml` runs one installed-artifact job each on
  macOS, Ubuntu, and Windows. Every job owns separate bounded `*-packed.json` and `*-upgrade.json`
  evidence; evidence contains structural status and package/platform identity only, never secrets,
  prompts, command output, provider bodies, or local absolute paths.
* External blockers: registry-backed compatibility smoke uses exit `77` only for an allowlisted
  registry installation stage with a bounded network failure code. `--allow-external-blocker` may
  turn that result into a green PR/matrix job while preserving `status=blocked_external`; it must
  never waive candidate packing, migration, downgrade, rollback, auth, or other product failures.
  The tag release never supplies this flag, so registry unavailability remains a hard publish gate.

### 4. Validation & Error Matrix

| Condition | Required failure |
|---|---|
| Invalid semantic version | `invalid_release_version` |
| Manifest or lockfile drift | `release_version_drift` |
| Root is publishable | `release_root_must_remain_private` |
| Application or platform manifest has the wrong package name | `release_package_name_mismatch` |
| Published package is private or not public | `release_package_is_private` / `release_package_access_invalid` |
| Vendored workspace is public | `release_vendored_package_must_be_private` |
| App exposes or omits a vendored dependency | `release_app_vendored_dependency_exposed` / `release_app_dependency_missing` |
| Tag differs from manifest version | `release_tag_version_mismatch` |
| Windows helper missing or not PE | `release_windows_sandbox_helper_missing` / `release_windows_sandbox_helper_invalid` |
| Real publish lacks matching confirmation | `release_publish_confirmation_required` / `release_publish_confirmation_mismatch` |
| Registry lookup returns 404 | Treat as unpublished and continue to publish |
| Registry lookup returns auth/network/other error | `release_registry_check_failed`; never treat as missing |
| Compatibility policy differs from runtime, workflow, budget, or docs | `release_compatibility_drift` |
| Compatibility policy shape or semantic relationship is invalid | `release_compatibility_policy_invalid` |
| Registry install hits an allowlisted network failure | Evidence `status=blocked_external`; exit `77` unless the non-tag matrix explicitly allows the blocker |
| Candidate pack, migration, downgrade, rollback, or any non-registry stage fails | Evidence `status=failed`; exit `1`; never classify as external |
| Tag workflow encounters any compatibility blocker | Fail before `release:publish`; no blocker waiver |

### 5. Good / Base / Bad Cases

* Good: bump with `release:version`, commit on `main`, tag the exact version, pass every package
  gate, publish with provenance, then create the GitHub Release.
* Good: each platform matrix job uploads separate packed and predecessor-upgrade evidence; an npm
  outage is visibly `blocked_external` without being reported as a product pass.
* Base: run `release:dry-run`; all packages are packed in dependency order and nothing is published.
* Bad: publish a private runtime workspace or remove it from the app artifact. This exposes an
  implementation package or creates an incomplete CLI installation.
* Bad: use `--allow-external-blocker` in the tag workflow, treat a zero-byte evidence file as a
  pass, or claim predecessor session migration when the schema window is incompatible.

### 6. Tests Required

* Unit: semantic version parsing, manifest/lockfile transformation, publisher argument gates,
  registry 404 classification, credential redaction, and Windows PE validation.
* Repository contract: seven release manifests are public, nine vendored manifests are private,
  all are coordinated, and release workflow gates occur before publication.
* Package smoke: no `src/`, `test/`, TypeScript config, Python runtime, or embedded generic ripgrep;
  all vendored workspace files are present, and release CI additionally requires the Windows
  sandbox helper inside the app artifact.
* Ripgrep resolver tests must cover platform-package priority and explicitly pass
  `platformPackageRoot: null` when exercising user-vendor fallback or isolated environment
  sanitization on a development install that contains the optional package.
* Compatibility policy: assert predecessor/package identity, Node versions, exact three-platform
  matrix, session schema windows, startup budgets, deprecation guide anchors, referenced docs, and
  malformed-policy rejection.
* Compatibility smoke: assert exit `77` classification is limited to registry install network
  failures; auth, candidate, migration, downgrade, and rollback failures remain hard failures.
* Workflow contract: parse all release YAML, assert each platform uploads its own packed and upgrade
  paths, and assert strict tag compatibility gates occur before `release:publish` without
  `--allow-external-blocker`.
* End-to-end dry-run: all seven `npm publish --dry-run` commands complete without creating a tag or
  registry version.

### 7. Wrong vs Correct

#### Wrong

```bash
npm publish --workspace @mycli/runtime
npm publish --workspace mycli-shell-tui
```

This leaks private implementation packages and bypasses the app artifact and platform gates.

#### Correct

```bash
npm run release:version -- 0.2.0
npm run release:verify
npm run release:compatibility
npm run release:dry-run
git tag -a v0.2.0 -m "mycli v0.2.0"
git push origin v0.2.0
```

The protected tag workflow owns the real publish and safely skips exact versions already present
after a partial release.
