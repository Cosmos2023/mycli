# Current Config Kernel Research

## Scope

This note traces the existing Node configuration resolution and management paths that the profile
and system-layer work must preserve.

## Resolution Path

- `resolveConfig()` and `resolveConfigWithMetadata()` in
  `backend/packages/config/src/settings.ts` are the canonical public entry points.
- Both call `loadConfigLayers()`, which currently reads user, trusted-project, and legacy-user TOML
  concurrently and builds the ordered metadata stack:
  `session > environment > project > user > legacy_user`.
- Runtime values are then assembled separately by `resolveConfigFromSources()`. Its `sources` array
  contains only file-backed layers because session and environment values are consulted directly.
  The file array order must therefore stay identical to the metadata stack order when profile and
  system layers are added, or runtime values and reported provenance can disagree.
- The same resolver feeds model-runtime resolution, the Node backend, configuration management,
  doctor, update startup checks, and session management. There is no legitimate second runtime
  configuration loader to update.

## Validation And Diagnostics

- `config-schema.ts` owns section/alias normalization, unknown-key warnings, duplicate aliases, and
  inline-secret rejection.
- `ConfigFileLayerId` currently admits only `project | user | legacy_user`; profile and system must
  become first-class file layer ids so parse/read/schema errors retain source metadata.
- Missing files are represented as enabled empty layers. An untrusted project remains a disabled
  empty layer and its file is not opened.
- Management output intentionally projects stable ids, scopes, and disabled reasons without source
  paths or raw values. API key output is reduced to `present | missing`.

## Persistence

- `atomicPrivateFileUpdate()` already performs a locked read/transform/write, temporary-file fsync,
  atomic rename, directory fsync, and best-effort mode hardening on Windows.
- The per-file lock prevents two writers from blindly replacing the same starting payload, but it
  does not expose an expected-version contract to a caller that made a decision from an older
  snapshot. Profile state mutations can reuse this kernel; interactive layer edits will eventually
  need an explicit expected version for full roadmap parity.
- `applyUserConfigEdits()` is deliberately private and losslessly patches TOML. Its validation path
  first checks the candidate as an isolated untrusted user layer, then checks the effective stack.
- There is no existing general-purpose state file for an active profile. Codex parity does not need
  one because the profile is launch-scoped loader input.

## Management Surface

- `parser.ts`, `types.ts`, `services.ts`, `config.ts`, and `render.ts` form one provider-free command
  pipeline. Profile commands should use the same command/response/error/redaction boundary.
- Current config mutations target only the user layer. This remains unchanged because the parity
  scope adds no profile management or profile mutation commands.

## Implementation Constraints

- Add profile/system exactly once to `loadConfigLayers()` and derive both effective source order and
  metadata from the same ordered layer inputs.
- Keep profile selection as validated launch input outside the configuration document so a profile
  cannot select itself or another profile and create recursive loading.
- Keep ordinary system-layer commands read-only and inject/resolve platform paths in a unit-testable
  function rather than writing host system locations in tests.
- Reuse the schema and atomic private-file kernel; do not add a second TOML parser or direct CLI IO.
