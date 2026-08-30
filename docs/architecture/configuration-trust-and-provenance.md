# Configuration Trust And Provenance

Status: accepted for the v0.2 configuration foundation.

## Context

mycli reads user, project, legacy, environment, and session/CLI configuration. Previously the Node
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
4. user configuration at `~/.mycli/config.toml`;
5. legacy user configuration at `~/.config/mycli/config.toml`;
6. built-in and provider defaults.

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
configuration is durable only for its trusted workspace. A later settings service must make these
destinations explicit and default interactive experiments to session scope.

The current `/model` workflow still has legacy write semantics that update both user defaults and
session preferences. Separating those actions is a follow-up change; it must consume this layer
contract rather than introducing another resolver.

## Secret Boundary

API keys and tokens belong in `~/.mycli/auth.json` or the process environment. Project
configuration must not contain credentials. Provenance and diagnostics may expose key names and
source categories, but never raw values. The existing `resolveConfig` result remains an internal
runtime object and must not be serialized directly to the TUI or logs.

## Compatibility

`resolveConfig` remains the compatibility facade for existing callers. Callers that need source
metadata use `resolveConfigWithMetadata`. Omitting `workspaceTrust` preserves legacy library
behavior for compatibility tests and controlled adapters; interactive runtime and default
management callers must always pass the persisted state.

Legacy flat keys remain readable. Reads do not rewrite TOML. The v0.2 foundation does not yet add
unknown-key diagnostics, line/column TOML diagnostics, profiles, system configuration, migrations,
or a complete schema service.

## Operational Consequences

Repository integrations are discovered once during startup. If trust is granted in an already
running session, project model/runtime configuration can participate in later resolutions, but
repository hooks, MCP, plugins, and skills require one restart. The planned onboarding flow will
move the trust decision before normal runtime composition and remove this visible restart from the
first-run journey.

All future configuration editors, doctor output, onboarding, and migration commands must derive
effective values and explanations from the canonical layer stack.
