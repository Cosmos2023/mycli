# Configuration Diagnostic Boundary Research

## Existing Behavior

- `backend/packages/config/src/settings.ts` parses TOML with `smol-toml`, flattens a fixed set of
  sections, and silently discards unknown tables and nested keys.
- Known flat keys are retained for compatibility. The complete accepted flat vocabulary is spread
  across setting lookups, environment mappings, and the model-ratio table special case.
- Config validation throws plain `Error` instances with `config_error:` messages.
- `collectConfigChecks` catches every error and emits only `configuration invalid`, so field and
  source information is lost before doctor rendering.
- Existing user configs may contain a legacy root `api_key`; the user config writer removes root and
  `[model]` inline keys during its next successful write.

## Parser Capability

`smol-toml@1.7.1` exports `TomlError` with numeric `line` and `column` fields. Its `message` and
`codeblock` contain source text and must not cross a diagnostic boundary. The parsed object does not
retain source ranges for ordinary tables or keys.

Consequences:

- syntax diagnostics can safely copy only numeric line/column;
- schema diagnostics can report a canonical dotted key path but not an exact range;
- adding an ad hoc TOML line scanner would be structurally unreliable and conflicts with the
  repository preference for structured parsers.

## Approaches Considered

### A. Typed diagnostics around the current parser (selected)

Parse once, validate the parsed object against a centralized vocabulary, and return value-free
warnings. Throw a typed config error for syntax, IO, forbidden project secrets, and invalid known
values. Preserve only stable code, layer, key path, and numeric source position.

Pros: minimal dependency and migration risk; directly improves doctor; preserves current valid
config behavior. Cons: schema diagnostics have no exact source range and the setting validators
still need gradual migration into the typed error helper.

### B. Replace TOML parsing with a CST-preserving parser

Pros: exact range for every key and future comment-preserving writes. Cons: large dependency and
write-path migration, high compatibility risk, and far beyond this P0 slice.

### C. Regex-scan source for unknown keys

Pros: apparently small. Cons: incorrect for quoted/dotted keys, arrays of tables, multiline values,
comments, and inline tables. Rejected.

## Secret Compatibility Decision

- Project config: inline credential fields are forbidden errors because repository-controlled
  secrets violate the trust/config boundary and should never become runtime credentials.
- User and legacy config: only a root-level `api_key` remains readable for this compatibility slice
  and emits a deprecation warning with remediation to move it into `~/.mycli/auth.json`.
- Credential fields inside tables, including `[model].api_key`, are forbidden. The existing writer
  already removes `[model].api_key` instead of treating it as a readable runtime setting.
- Environment `MYCLI_API_KEY` and the credential store remain valid and do not produce diagnostics.

## Cross-Layer Flow

```text
TOML file
  -> config parser/validator (owns diagnostic classification)
  -> ResolvedConfig.diagnostics or ConfigError.diagnostic
  -> doctor adapter (maps severity/message only)
  -> management text/JSON renderer
```

The app layer must not inspect raw exceptions or rebuild config issue codes.
