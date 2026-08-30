# Configuration Mutation Boundary Research

## Existing mycli behavior

- `config show/validate` already provide a provider-free, secret-safe effective configuration and
  provenance boundary.
- User provider and shell-settings writers use `smol-toml` parse/stringify around
  `atomicPrivateFileUpdate`. Atomicity and private modes are strong, but whole-document
  serialization does not preserve user comments or formatting.
- The atomic updater holds a per-file lock, reads the current bytes after acquiring it, writes a
  private temporary file, syncs it, renames it, hardens the target, and syncs the directory.
- `CONFIG_SECTION_KEYS` already defines canonical table keys and legacy flattened runtime aliases.
  Runtime validation also contains relational constraints that are stronger than scalar parsing.

## Codex comparison

- Local Codex source does not expose a broad public `config set` command, but its persistence core
  defines discrete `ConfigEdit::SetPath` and `ConfigEdit::ClearPath` variants.
- Codex parses configuration with Rust `toml_edit::DocumentMut`, applies all edits to one lossless
  document, preserves decor/comments, and performs one atomic write only when a mutation occurred.
- TUI settings use typed edit constructors and then re-read effective configuration so an
  enterprise or other higher layer can be reported as overriding the saved user value.
- This suggests that safe path editing and post-write provenance are the reusable foundation; a
  direct object stringify is not parity.

## Node TOML options

### Whole-document serialization with `smol-toml`

- Already installed and well tested for semantic parsing.
- Loses comments and formatting when serialized, so it is unsuitable for a user-facing generic
  mutation command.

### `@taplo/lib`

- Provides broad TOML tooling but its package is roughly 35 MB unpacked and brings a core
  dependency. That is disproportionate for three local path operations.

### `@decimalturn/toml-patch`

- MIT, ESM, typed, Node >=16, dependency-free, approximately 171 KB unpacked.
- Actively maintained since 2025 and explicitly preserves comments, whitespace, ordering, newline
  style, and formatting while patching TOML 1.1 documents.
- Its parse-modify-patch workflow can retain unknown configuration while changing or removing only
  allowlisted paths. Focused compatibility tests are still required because dependency behavior is
  part of mycli's persistence contract.

### Custom text/CST editor

- Avoids a dependency but must correctly handle dotted and quoted keys, inline tables, arrays,
  array-of-tables, comments, multiline strings, duplicate paths, and newline formats. This is too
  much parser surface for an early product and would duplicate a specialized library.

## Feasible command scopes

### Effective get only

Low risk but adds little beyond filtering `config show` and does not solve manual configuration.

### User-only get/set/unset (recommended)

Expose only known scalar settings. Use canonical paths, clear legacy aliases, preserve the existing
document, validate before rename, and report the effective source afterward. This avoids project
trust/write semantics while delivering a complete workflow.

### User and project scopes

Requires trust confirmation, repository file modes, symlink policy, ignored/tracked-file UX, and
explicit project mutation approval. This should follow after the user writer is proven.

## Safety and UX decisions

- Do not accept arbitrary dotted paths or infer TOML values generically.
- Do not accept credential-like keys; auth remains owned by setup/login/auth-store flows.
- Do not echo raw submitted values in success or failure output.
- Apply parsing and candidate validation while holding the writer lock so concurrent mutations do
  not use stale source bytes.
- Resolve after write and report the winning layer id; a successful save can still be ineffective
  when environment or trusted project configuration wins.
- Treat repeated set and absent unset as successful no-ops without replacing the file.

