# Build npm release pipeline

## Goal

Make mycli releasable as one application package plus platform-specific ripgrep packages through a repeatable local versioning flow and a tag-driven GitHub Actions workflow.

## What I already know

* The root project is an npm workspace and must remain private.
* Ten runtime workspaces and six release-only ripgrep platform packages share version `0.1.0`.
* Nine internal runtime workspaces can remain private and ship inside the application tarball.
* Internal runtime and optional platform dependencies use exact coordinated versions.
* CLI/runtime version text is duplicated in TypeScript source.
* The Windows sandbox helper must be compiled on Windows and inserted into `@mycli/tools` before publication.
* Existing package smoke automation can validate all six ripgrep packages.
* The user approved implementing the recommended release pipeline.

## Assumptions

* The public CLI package remains `@mycli/app`, installed with `npm install -g @mycli/app`.
* All publishable packages use one coordinated semantic version.
* npm Trusted Publishing is the preferred CI authentication mechanism; a protected GitHub `npm` environment provides the human approval boundary.

## Requirements

* Keep the workspace root and nine internal runtime workspaces private; publish only the app and six platform packages.
* Vendor the private runtime workspaces into the app without bundling platform-specific third-party native dependencies.
* Provide one command that validates and synchronizes the coordinated release version across manifests, internal dependency specifications, and the lockfile.
* Derive runtime version reporting from the app manifest instead of duplicated literals.
* Provide a guarded publisher that publishes packages in dependency order, supports dry-run, and safely resumes after partial publication.
* Build the Windows sandbox helper in a Windows job and transfer it into the release package.
* Run existing contract, lint, test, typecheck, M8, and packed-package gates before publication.
* Trigger real publication only from a semantic version Git tag whose version matches the manifests.
* Create a GitHub Release after npm publication succeeds.
* Document local preparation, CI configuration, release, retry, and rollback procedures.

## Acceptance Criteria

* [x] Root release verification rejects mismatched public/private boundaries, incomplete app dependencies, and inconsistent internal dependency versions.
* [x] `npm run release:version -- <semver>` updates every coordinated version source and supports a no-write check.
* [x] `mycli --version` and the gateway manifest read the app package version through one source.
* [x] The publisher is dry-run by default and requires explicit version confirmation for real publication.
* [x] A rerun skips package versions already visible in npm and rejects non-404 registry failures.
* [x] Release CI validates the tag, obtains the Windows helper artifact, runs all release gates, publishes with provenance, and creates a GitHub Release.
* [x] Focused release automation tests, lint, typecheck, and relevant package smoke checks pass.

## Definition of Done

* Tests added for version synchronization, release validation, argument safety, and publish ordering.
* Lint, typecheck, contract drift checks, and relevant test suites are green.
* Release documentation is complete and contains no credentials.
* A dry-run validates package contents without publishing or creating a tag.

## Out of Scope

* Publishing packages, pushing a tag, or configuring the npm organization in this task.
* Renaming `@mycli/app` to an unscoped `mycli` package.
* Supporting independently versioned workspace packages.
* Reworking the existing cross-platform test workflow.

## Technical Notes

* Release-only platform manifests live under `npm/ripgrep/<target>/package.json` outside npm workspaces.
* Existing package validation is implemented by `scripts/smoke_packed_cli.mjs`.
* Existing Windows helper build commands are present in `.github/workflows/cross-platform.yml`.
* Relevant guidance: `.trellis/spec/backend/index.md`, `.trellis/spec/guides/code-reuse-thinking-guide.md`, and `.trellis/spec/guides/cross-layer-thinking-guide.md`.
