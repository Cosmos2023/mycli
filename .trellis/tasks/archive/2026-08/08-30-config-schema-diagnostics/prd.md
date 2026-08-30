# P0 Configuration Schema Diagnostics

## Goal

Make mycli configuration failures specific and actionable without exposing configuration values or
credentials. Extend the trust/provenance foundation with a canonical validation vocabulary for the
currently supported TOML keys and surface bounded diagnostics through runtime and doctor paths.

## What I Already Know

- The previous task established deterministic layer precedence, trust-gated project reads, and
  value-free provenance metadata.
- `settings.ts` currently flattens known TOML tables through `SECTION_KEYS`; unknown keys and tables
  are silently ignored.
- Current read/parse failures are string errors such as `config_error: invalid TOML in user config`.
- `mycli doctor` deliberately returns a generic configuration failure and must remain provider-free
  and secret-safe.
- The agreed long-term plan calls for typed diagnostics, unknown-key detection, embedded-secret
  rejection, and later strict-mode/config-editor work.

## Assumptions

- This slice validates the existing supported key set rather than introducing the complete future
  config schema or profiles/system layers.
- Unknown keys should produce structured warnings for inspection/doctor while preserving current
  runtime compatibility; invalid known values and forbidden credential fields remain errors.
- Project inline credentials are forbidden. A legacy root-level `api_key` in user or legacy-user
  configuration remains readable with a migration warning until an explicit migration command
  exists. Credential fields inside tables are forbidden in every file layer.
- Diagnostics may expose layer category, bounded path, table/key name, and stable issue code, but
  never raw values or private file contents.

## Open Questions

- None.

## Requirements

- Define typed, stable configuration diagnostic codes and severity.
- Validate canonical and legacy flat keys against the currently supported schema.
- Report unknown tables/keys without changing effective runtime behavior in this slice.
- Reject project credential fields through a specific secret-safe diagnostic; warn for compatible
  user and legacy-user inline `api_key` fields.
- Preserve numeric line/column for TOML syntax failures. Schema issues report a dotted key path
  because the current parser does not retain key ranges.
- Preserve trust gating: disabled project configuration must not be opened merely for diagnostics.
- Expose bounded diagnostics through config resolution metadata and the provider-free doctor path.
- Keep `resolveConfig` source-compatible and avoid logging or serializing effective secret values.

## Acceptance Criteria

- [x] Unknown root keys, unknown tables, and unknown keys inside known tables produce deterministic
      diagnostics naming the key path and owning layer.
- [x] Known legacy flat keys remain accepted without being misclassified as unknown.
- [x] Project inline API key/token fields produce a stable forbidden-secret error without exposing
      values; compatible user/legacy inline `api_key` fields produce a migration warning.
- [x] Invalid known values retain actionable field-specific errors.
- [x] Unknown or untrusted project config remains unread and contributes no parse/schema details.
- [x] `resolveConfigWithMetadata` exposes value-free diagnostics while `resolveConfig` remains
      compatible.
- [x] `mycli doctor` reports bounded layer/key/remediation information without provider startup.
- [x] Unit/integration tests, lint, typecheck, contract drift, and release checks pass.

## Definition Of Done

- Typed diagnostics are owned by `backend/packages/config`, not reconstructed in app/TUI code.
- Runtime and doctor consume the same diagnostic output.
- Existing valid configuration and legacy compatibility tests remain green.
- User-facing configuration documentation explains warning/error behavior.
- Unrelated Windows sandbox changes remain untouched.

## Out Of Scope

- Interactive `/settings` redesign or a config editor.
- `mycli config set/get/validate` commands and strict-mode CLI flags.
- Profiles, system configuration, migrations, comment-preserving writes, or optimistic concurrency.
- A complete generated contract schema for every planned future section.
- Replacing `smol-toml` or approximating key ranges with a custom source scanner.
- Changes to provider request assembly, agent execution, compaction, or storage schemas.

## Technical Notes

- Primary modules: `backend/packages/config/src/settings.ts`, the configuration layer types, and
  `backend/apps/mycli/src/management/doctor/check-config.ts`.
- Applicable specs: `.trellis/spec/backend/configuration-trust-contract.md` and
  `.trellis/spec/backend/error-handling.md`.
- Diagnostics must remain bounded and safe for future CLI/TUI rendering.

## Research References

- [`research/config-diagnostic-boundary.md`](research/config-diagnostic-boundary.md) - parser
  capability, typed diagnostic flow, and inline-secret compatibility decision.

## Decision (ADR-lite)

**Context:** mycli needs actionable diagnostics now, but replacing the TOML parser or breaking every
legacy inline credential before a migration command would expand risk beyond this slice.

**Decision:** Add typed diagnostics around the current parser. Use parser-provided line/column only
for syntax failures, dotted key paths for schema findings, warnings for unknown keys and legacy user
inline credentials, and a hard error for project inline credentials.

**Consequences:** Doctor and future config UX get one safe diagnostic vocabulary without a parser
migration. Exact ranges for schema findings and strict unknown-key enforcement remain follow-up
work.
