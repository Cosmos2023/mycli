# Tool Manifest Contract

## Overview

`mycli` exposes built-in local tools through a stable read-only manifest. The
manifest is the source of truth for local tool ids, toolset grouping, provider
schema metadata, risk policy metadata, effect profile, and availability.

`ToolsetRegistry` exposes a second read-only manifest for extension
foundation clients. It groups tools by toolset and reports enablement,
aliases, sources, availability, and conflicts without changing the
provider-visible tool schema.

## Scope / Trigger

Apply this contract when changing:

- `src/mycli/tools/registry.py`
- `src/mycli/tools/base.py`
- built-in tool specs under `src/mycli/tools/`
- approval/safety behavior for built-in tools
- extension manifest discovery
- doctor checks for local tools
- TUI or integration clients that inspect available local tools

## Manifest Shape

`ToolRegistry.manifest()` returns:

- `schema_version`: integer, currently `1`
- `source`: currently `builtin`
- `toolsets`: list of `{id, tool_count}`
- `tools`: list of tool entries

Each tool entry must include:

- `id`: stable id, currently `builtin:<tool-name>`
- `name`: route name used by the model/runtime
- `source`: `builtin`, `contributed`, `provider`, `mcp`, `plugin`, `skill`,
  or `subagent`
- `toolset`: logical grouping such as `file`, `search`, `terminal`, `web`,
  `workflow`, `dev`, or `interaction`
- `description`: provider-visible description
- `parameters`: provider-visible parameter schema rows
- `risk_level`: `low`, `medium`, or `high`
- `approval_policy`: stable policy string such as `auto_allow`,
  `auto_allow_or_request`, or `shell_safety_analysis`
- `capability_tags`: bounded machine-readable tags
- `effects`: filesystem/network/process effect profile
- `availability`: currently `{status: "available"}` for built-in tools
- contributed-tool entries may include `contribution` metadata with bounded
  display name, scope, lifecycle state, and origin fields.

## Contracts

- The manifest is read-only. Building or validating it must not create files,
  logs, sessions, traces, shell processes, provider requests, or network calls.
- Built-in tool ids and names must be unique.
- `ToolRegistry.render_for_model()` remains the provider-facing schema surface;
  manifest additions must not change provider schema ordering or contents unless
  the tool spec itself intentionally changes.
- `ExtensionManifestService.manifest()` includes `tool_manifest` so gateway and
  extension clients can discover local tools without scraping human `/tools`
  output.
- `ExtensionManifestService.manifest()` includes `toolset_manifest` so gateway
  and future MCP/plugin/skills/subagent clients can inspect toolset grouping,
  availability, alias, and conflict state without scraping human output.
- `ToolRegistry.toolset_manifest()` must be read-only and must not alter
  `ToolRegistry.render_for_model()` ordering or provider-visible schema.
- `combined_tool_manifest()` may merge built-in and contributed tool
  registrations into the same manifest shape. This is a discovery view only;
  it does not productize plugin/skills/subagent lifecycle.
- MCP-origin contributed registrations use stable `mcp:<server>:<tool>` tool ids
  and `origin_metadata.server` / `origin_metadata.tool`; the combined manifest
  renders those entries with `source="mcp"` and `toolset="external"` even though
  they flow through the generic provider contribution path.
- Default runtime skill invocation uses the built-in stable `Skill` tool plus
  the model-visible skill catalog. Individual skills must not be registered as
  provider-visible default tools, because adding/removing a skill would mutate
  the stable tool schema and degrade prefix-cache stability.
- Successful `Skill` invocations append the loaded skill instructions as a
  persistent, model-visible transcript message with bounded metadata
  (`kind=skill_instructions`, `cache_class=dynamic`,
  `durability=persistent`, `scope=transcript`). The message must be fenced as a
  loaded skill reference, not rendered as the current user request.
- Skill-origin contributed registrations use stable `skill:<name>` tool ids and
  `origin_metadata.skill` only for legacy/non-default discovery surfaces. The
  combined manifest may render those entries with `source="skill"` and
  `toolset="external"` when such registrations are explicitly supplied, but
  default runtime assembly must not inject per-skill contributed tools.
- MCP discovery diagnostics may start configured local stdio servers through
  the MCP client path. Human-facing doctor output must remain bounded to server
  names, transport kind, counts, status, and failure kind; it must not include
  command args, env values, headers, raw tool arguments, or secret-like values.
- Toolset entries include `id`, `enabled`, `aliases`, `sources`, `tool_count`,
  `tools`, and `availability`.
- `ToolsetRegistry.manifest_issues()` reports malformed toolset rows and
  alias/route conflicts. Conflicts are diagnostic-only in this foundation
  slice; runtime enable/disable enforcement is a later productization step.
- `DoctorService` includes a `tool_manifest` check that validates required
  fields, uniqueness, risk levels, parameter shape, availability, and
  toolset manifest health.
- Doctor output must remain bounded and must not print raw tool arguments,
  file contents, command strings, headers, or secret-like values.

## Validation

Required tests for manifest changes:

- Registry manifest shape, uniqueness, toolset counts, and representative
  entries.
- Toolset manifest shape, enablement, aliases, sources, conflict reporting, and
  representative toolset entries.
- Combined manifest with at least one contributed registration preserving
  builtin entries and contributed source/toolset metadata.
- Combined manifest with at least one MCP-origin contributed registration
  rendered as `source=mcp`, `toolset=external`.
- Combined manifest with at least one skill-origin contributed registration
  rendered as `source=skill`, `toolset=external`.
- Extension manifest exposes `tool_manifest` and the `tools.manifest`
  capability.
- Extension manifest exposes `toolset_manifest` and the `toolsets.manifest`
  capability.
- Doctor reports `tool_manifest=ok` for a valid built-in registry.
- Safety policy remains aligned with manifest risk/approval metadata for core
  local tools.
- Existing tool tests continue to pass.

## Non-goals

This manifest does not productize ACP, subagents, browser, or computer-use.
MCP remains a minimum local stdio tool lifecycle foundation here; hosted MCP
auth, OAuth, SSE, plugin marketplace, and user-facing MCP management remain out
of scope. Skills remain a local discovery/invocation/diagnostics foundation;
skill marketplace, sync, install, and subagent skill orchestration remain out
of scope.
