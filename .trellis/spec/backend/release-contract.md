# Coordinated npm Release Contract

## Scenario: Publish a mycli version

### 1. Scope / Trigger

Apply this contract whenever a runtime workspace, ripgrep platform package, package dependency, or
user-visible runtime version changes. mycli uses one coordinated version for 16 components, but
publishes only `@mycli/app` and six ripgrep platform packages. Nine private runtime workspaces are
vendored into the app tarball; the workspace root is never published.

### 2. Signatures

```text
npm run release:version -- <semver>
npm run release:version -- --check [semver]
npm run release:verify -- [--tag v<semver>] [--require-windows-helper]
npm run release:dry-run
npm run release:publish -- --confirm <semver> [--tag <dist-tag>] [--provenance]
```

`scripts/release-config.mjs` is the canonical inventory for both versioned and published packages.
Platform packages precede `@mycli/app`; private runtime workspaces are versioned but never sent to
the registry.

### 3. Contracts

* Root `package.json`: `private: true`.
* Every published manifest: the coordinated `version`, `private: false`, and
  `publishConfig.access: "public"`.
* Every vendored workspace manifest: the coordinated `version`, `private: true`, and no
  `publishConfig`.
* Internal dependency ranges: the same coordinated version, retaining only an existing `^` or `~`
  prefix.
* Application artifact: all nine private workspaces under `dist/node_modules`, including each
  workspace's declared runtime files. The app manifest exposes their complete third-party
  dependency closure and the six optional platform packages, but no private workspace dependency.
* Runtime identity: app, integrations, and TUI read their own published package manifest through
  the shared pure `parsePackageVersion()` validator.
* Registry: always `https://registry.npmjs.org/`; npm cache is `.npm-cache/release`.
* CI: a `v<semver>` tag on `main`, protected `npm` environment, Windows helper artifact,
  `id-token: write`, and optional `NPM_TOKEN` only for bootstrap/fallback authentication.
* Stable versions publish under `latest`; prereleases publish under `next`.

### 4. Validation & Error Matrix

| Condition | Required failure |
|---|---|
| Invalid semantic version | `invalid_release_version` |
| Manifest or lockfile drift | `release_version_drift` |
| Root is publishable | `release_root_must_remain_private` |
| Published package is private or not public | `release_package_is_private` / `release_package_access_invalid` |
| Vendored workspace is public | `release_vendored_package_must_be_private` |
| App exposes or omits a vendored dependency | `release_app_vendored_dependency_exposed` / `release_app_dependency_missing` |
| Tag differs from manifest version | `release_tag_version_mismatch` |
| Windows helper missing or not PE | `release_windows_sandbox_helper_missing` / `release_windows_sandbox_helper_invalid` |
| Real publish lacks matching confirmation | `release_publish_confirmation_required` / `release_publish_confirmation_mismatch` |
| Registry lookup returns 404 | Treat as unpublished and continue to publish |
| Registry lookup returns auth/network/other error | `release_registry_check_failed`; never treat as missing |

### 5. Good / Base / Bad Cases

* Good: bump with `release:version`, commit on `main`, tag the exact version, pass every package
  gate, publish with provenance, then create the GitHub Release.
* Base: run `release:dry-run`; all packages are packed in dependency order and nothing is published.
* Bad: publish a private runtime workspace or remove it from the app artifact. This exposes an
  implementation package or creates an incomplete CLI installation.

### 6. Tests Required

* Unit: semantic version parsing, manifest/lockfile transformation, publisher argument gates,
  registry 404 classification, credential redaction, and Windows PE validation.
* Repository contract: seven release manifests are public, nine vendored manifests are private,
  all are coordinated, and release workflow gates occur before publication.
* Package smoke: no `src/`, `test/`, TypeScript config, Python runtime, or embedded generic ripgrep;
  all vendored workspace files are present, and release CI additionally requires the Windows
  sandbox helper inside the app artifact.
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
npm run release:dry-run
git tag -a v0.2.0 -m "mycli v0.2.0"
git push origin v0.2.0
```

The protected tag workflow owns the real publish and safely skips exact versions already present
after a partial release.
