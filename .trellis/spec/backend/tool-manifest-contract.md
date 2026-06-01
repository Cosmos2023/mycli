# Tool Manifest Contract

## Overview

`mycli` exposes built-in local tools through a stable read-only manifest. The
manifest is the source of truth for local tool ids, toolset grouping, provider
schema metadata, risk policy metadata, effect profile, and availability.

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
- `DoctorService` includes a `tool_manifest` check that validates required
  fields, uniqueness, risk levels, parameter shape, and availability.
- Doctor output must remain bounded and must not print raw tool arguments,
  file contents, command strings, headers, or secret-like values.

## Validation

Required tests for manifest changes:

- Registry manifest shape, uniqueness, toolset counts, and representative
  entries.
- Extension manifest exposes `tool_manifest` and the `tools.manifest`
  capability.
- Doctor reports `tool_manifest=ok` for a valid built-in registry.
- Safety policy remains aligned with manifest risk/approval metadata for core
  local tools.
- Existing tool tests continue to pass.

## Non-goals

This manifest does not productize MCP, ACP, skills, subagents, browser, or
computer-use. Those capabilities may have foundation code elsewhere, but this
contract only stabilizes built-in local tools.
