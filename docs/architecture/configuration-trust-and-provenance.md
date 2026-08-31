# Configuration Trust And Provenance

Status: accepted for the v0.2 configuration foundation and diagnostics.

## Context

mycli reads system, user, profile, project, legacy, environment, and session/CLI configuration. Previously the Node
backend parsed project `.mycli/config.toml` before loading workspace trust, user configuration
silently outranked project configuration, and the resolver discarded the source of each selected
key. Repository hooks, MCP servers, plugins, skills, and execution rules could also be discovered
without sharing one trust decision.

This made startup difficult to explain and allowed project-controlled input to reach configuration
and integration boundaries before the user had trusted the canonical workspace.

## Decision

Configuration layers use this precedence, highest first:

1. session and CLI overrides;
2. environment variables;
3. trusted project configuration;
4. the launch-selected profile at `~/.mycli/<name>.config.toml`;
5. user configuration at `~/.mycli/config.toml`;
6. system configuration at `/etc/mycli/config.toml` on Unix or
   `%ProgramData%\mycli\config.toml` on Windows;
7. legacy user configuration at `~/.config/mycli/config.toml`;
8. built-in and provider defaults.

The initial layer-stack contract has version `1`. Each layer records its stable id, scope, source,
version, enabled state, disabled reason, and declared keys. Per-key provenance records the winning
layer and lower-priority layers it overrides. It never contains configuration values, credentials,
request headers, or provider payloads.

`WorkspaceTrustStore` is the authority for project admission. Runtime and default management
composition load the canonical workspace decision before project configuration or repository
integration discovery. An `unknown` or `untrusted` workspace produces a disabled project layer with
reason `workspace_not_trusted`; the project TOML is not opened or parsed. The same gate excludes:

- repository hooks;
- repository MCP servers;
- repository plugins and project plugin enablement;
- `.agents/skills` and `.mycli/skills` in the repository;
- project execution rules.

When resuming a session, the persisted session workspace, not the process launch directory, owns
the trust decision and integration discovery scope.

## Scope Semantics

Session/CLI overrides affect the active runtime resolution and outrank durable files. Environment
variables affect the process. User configuration is the durable cross-workspace default. Project
configuration is durable only for its trusted workspace. Ordinary `/model` selection defaults to
session scope and persists only active-session preferences; an explicit `Make user default` choice
uses the typed user-config writer before applying the same preferences to the active session.

`--profile <name>` and `-p <name>` are external loader inputs rather than configuration keys. Names
use the portable `[A-Za-z0-9_-]+` grammar before path construction. The base user file always loads,
then the selected sparse profile loads above it; a missing profile is an enabled empty layer.
Selection is process-scoped and is neither persisted in the user file nor copied into session
preferences. The system layer is always read-only to ordinary mycli commands and uses
`C:\ProgramData` when the Windows ProgramData directory cannot be resolved.

## Secret Boundary

API keys and tokens belong in `~/.mycli/auth.json` or the process environment. Project
configuration, selected profiles, and system configuration must not contain credentials.
Provenance and diagnostics may expose key names and source categories, but never raw values. The
existing `resolveConfig` result remains an internal runtime object and must not be serialized
directly to the TUI or logs.

## Diagnostic Boundary

The configuration package owns one versioned diagnostic vocabulary. `resolveConfigWithMetadata`
returns value-free warning diagnostics with the resolved configuration and layer stack. Fatal read,
parse, credential, and known-value failures cross the boundary as `ConfigError` with the same
diagnostic shape. Runtime and management callers consume that contract instead of classifying raw
parser or filesystem exceptions themselves.

Unknown root keys, tables, and keys inside known tables are warnings. They retain the owning file
layer and a bounded dotted key path, but do not change effective runtime behavior. TOML syntax
failures retain only the parser-provided numeric line and column. Schema findings do not claim a
source range because the current TOML parser does not retain one for ordinary keys.

Diagnostics may contain a stable version, code, severity, file-layer id, bounded key path, numeric
source position, public message, and remediation. They must not contain raw configured values,
TOML source or code blocks, exception stacks, request data, credentials, or absolute file paths.
`mycli doctor` maps this structure into bounded rows without starting a provider.

Project credential fields are fatal. For compatibility, only a root-level `api_key` in the user or
legacy-user file remains readable and emits a migration warning. Credential fields inside tables,
including `[model].api_key`, are rejected in every file layer. Environment credentials and
`~/.mycli/auth.json` remain valid without warnings.

## Compatibility

`resolveConfig` remains the compatibility facade for existing callers. Callers that need source
metadata use `resolveConfigWithMetadata`. Omitting `workspaceTrust` preserves legacy library
behavior for compatibility tests and controlled adapters; interactive runtime and default
management callers must always pass the persisted state.

Legacy flat keys remain readable. Reads do not rewrite TOML. Profile and system layers are additive:
installations without either retain their prior effective values. This batch deliberately does not
add profile management commands, a persisted active profile, profile-scoped mutation, automatic
migrations, strict unknown-key enforcement, exact source ranges for schema findings, or a complete
generated schema service.

## Operational Consequences

Repository integrations are discovered once during startup. If trust is granted in an already
running session, project model/runtime configuration can participate in later resolutions, but
repository hooks, MCP, plugins, and skills require one restart. The planned onboarding flow will
move the trust decision before normal runtime composition and remove this visible restart from the
first-run journey.

All future configuration editors, doctor output, onboarding, and migration commands must derive
effective values and explanations from the canonical layer stack.
