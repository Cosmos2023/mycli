# Codex Config Layer Research

## Evidence Inspected

Local source: `/Users/cosmos/Downloads/codex-main`, primarily:

- `codex-rs/config/src/loader/mod.rs`
- `codex-rs/config/src/state.rs`
- `codex-rs/core/src/config/mod.rs`
- `codex-rs/protocol/src/config_types.rs`
- `codex-rs/cli/src/main.rs`

## Profile Contract

- Codex profile-v2 names are validated plain ASCII names containing only letters, digits, `_`, and
  `-`; empty strings and paths such as `../foo` are rejected before filesystem access.
- `--profile <name>` resolves to `$CODEX_HOME/<name>.config.toml` and is passed into the loader as
  `user_config_path` plus typed `user_config_profile` metadata.
- The base user config is always loaded first. The selected profile is loaded as a sparse second
  user layer on top, so it only needs overrides.
- Profile selection is loader input, not a value resolved from the selected profile. Codex rejects
  ambiguous coexistence with its legacy in-document `profile` / `[profiles.*]` mechanism.
- Codex does not provide a durable `profile use` command in the inspected surface; callers select a
  profile per launch. mycli therefore needs its own small activation-state contract if switching is
  intended to persist.

## System Contract

- Unix system config is `/etc/codex/config.toml`.
- Windows system config is `%ProgramData%\\OpenAI\\Codex\\config.toml`; Codex resolves the known
  folder and falls back to `C:\\ProgramData`.
- The system layer is loaded as an enabled empty layer when absent. Ordinary user config editing
  targets user/profile files, not the system layer.

## Ordering And Trust

Codex builds low-to-high layers as system, cloud/managed fragments, base user, selected profile,
trusted project tree, then runtime/session flags. Project files stay disabled when untrusted.
Project-local configuration also has a denylist for endpoint/provider and command-bearing fields.

The roadmap-approved mycli precedence differs slightly because environment and one project file are
explicit layers, but the durable pattern is the same: profile activation is external loader state,
the profile is sparse over the base user layer, system config is lowest normal config, and project
trust is evaluated before project contents participate.

## Adoptable Behaviors

- typed plain profile names before path construction;
- sparse profile overrides over base user config;
- explicit system paths with Windows known-folder fallback;
- activation metadata carried alongside the layer rather than embedded in it;
- missing files represented consistently and invalid selected profiles failing with actionable
  diagnostics instead of silently falling back.

