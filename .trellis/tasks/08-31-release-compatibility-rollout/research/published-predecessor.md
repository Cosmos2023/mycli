# Published Predecessor Audit

## Scope

Determine which real npm artifact can act as the predecessor for release compatibility testing and
identify any branch state that would make the candidate artifact differ from the public release
identity.

## Evidence

- Git tag `v0.1.0` points to `252c341c` and its application manifest is
  `@cosmos2023/app@0.1.0` with `bin.mycli = "dist/cli.js"`.
- The npm registry reports `@cosmos2023/app@0.1.0` as published and exposes the matching tarball.
- Commit `bfb1f8bb` renamed the public application package to `@cosmos2023/mycli` while preserving
  the `mycli` executable name.
- The npm registry reports `@cosmos2023/mycli@0.1.0` as published.
- The current feature branch forked before the public-scope commits and still declares the
  unpublished `@mycli/app@0.1.0`; the registry returns 404 for `@mycli/app`.
- The current feature branch contains the later configuration and UX work, so merging `main`
  wholesale would also merge unrelated Trellis state. The release task should restore the public
  package identity through a focused change instead.

## Compatibility Pair

The reproducible predecessor is `@cosmos2023/app@0.1.0`. The candidate is the locally packed
`@cosmos2023/mycli` artifact after the public package identity is restored. This is a real
package-name migration even while both manifests remain at `0.1.0` in the working tree.

The rollout gate must exercise both directions:

1. install `@cosmos2023/app@0.1.0`, create representative user state, install the candidate
   tarball, and verify the `mycli` executable plus state migration;
2. install the candidate tarball, create only state documented as backward-compatible, replace it
   with `@cosmos2023/app@0.1.0`, and report any deliberate downgrade boundary instead of claiming
   transparent compatibility.

The task must not publish or silently select a new version. Before a real release, an authorized
release operator must run `npm run release:version -- <new-semver>` because npm versions are
immutable and `@cosmos2023/mycli@0.1.0` already exists.

## Compatibility Boundaries

- Config migration version `1` supports explicit preview, apply with backup, and rollback.
- Runtime session schema `12` is the only schema accepted by the normal runtime store. Explicit
  maintenance migrations for older schemas do not make them directly runtime-readable.
- Upgrade and downgrade evidence must use isolated `MYCLI_HOME` and npm prefixes, contain no
  credentials, and record only sanitized structural results.
- Registry/network unavailability is an external evidence blocker. It must be reported distinctly
  from a candidate product failure.

## Implementation Consequences

- Restore the canonical public package and platform package names before extending packed smoke.
- Keep compatibility and deprecation data in one machine-readable source and validate docs against
  it.
- Split deterministic local artifact tests from the registry-backed predecessor journey so source
  and pull-request gates remain provider-free and failures stay attributable.
- Do not treat a source-tree import or fabricated old tarball as upgrade evidence.
