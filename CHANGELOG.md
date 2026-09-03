# Changelog

All notable changes to mycli are documented in this file. Versions are assigned only by the
coordinated release workflow.

## Unreleased

### Added

- Codex-aligned configuration provenance, onboarding, permission, diagnostics, session recovery,
  terminal accessibility, completion, and non-TTY contracts.
- Explicit configuration migration preview, apply, backup, and rollback commands.
- Provider-free packed artifact and registry-backed release compatibility verification across
  macOS, Ubuntu, and Windows.

### Changed

- The maintained public application identity is `@cosmos2023/mycli`.
- Platform ripgrep packages use the `@cosmos2023` scope and remain optional target-specific
  dependencies.
- Writable sessions now use fresh-only schema 12. Schema 9 predecessor sessions are not converted
  in place and require their complete database sidecars plus a compatible old binary.

### Deprecated

- `@cosmos2023/app` is deprecated in favor of `@cosmos2023/mycli`. Removal is not yet scheduled;
  see `docs/upgrading.md#package-name-migration`.

## 0.1.0 - 2026-08-27

### Added

- Initial public Node.js/TypeScript mycli release and target-specific ripgrep packages.
