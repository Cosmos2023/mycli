# Skills Tool Lifecycle Foundation

## Problem

`mycli` has a prompt-style `Skill` tool and a basic `SkillRegistry`, but skills
are not yet a stable extension/tools foundation. They are not exposed as
contributed tools, not visible in the combined manifest as skill-origin
capabilities, and doctor cannot diagnose malformed, duplicate, or unreadable
skill assets.

## Goal

Build the minimum Hermes-like local skill lifecycle foundation without
productizing a skill marketplace or subagent orchestration.

This slice must prove that `mycli` can discover local and repo skills, diagnose
the skill catalog, expose skill-origin tools through the same manifest/toolset
surface as MCP/contributed tools, and invoke a fake/local skill through the
runtime router lifecycle.

## Scope

- Skill discovery supports built-in, user/local, and repo skill directories.
- Skill metadata includes name, description, source path, source kind, trigger
  hints, dependencies, guardrails, availability, and lifecycle-ready origin
  fields.
- Skill diagnostics report duplicate names, malformed frontmatter, missing
  required fields, unreadable files, and bounded catalog counts.
- Skill-origin contributed tools render into combined tool manifest and toolset
  manifest as `source=skill`, `toolset=external`.
- Doctor reports skill diagnostics without printing skill file content.
- Runtime can invoke a fake/local skill through `ToolOrchestrator`,
  `ToolContributionRegistry`, and `ToolRouter`.
- Deterministic skill smoke covers discovery, invocation, manifest, and doctor.

## Non-goals

- Skill marketplace, install/sync UX, remote skills, subagent productization,
  ACP, or copying Hermes-agent code.

## Acceptance Criteria

- Unit tests cover skill discovery, source precedence, diagnostics, manifest
  source attribution, doctor output, and runtime router lifecycle.
- `uv run python evaluation/skill_smoke.py` passes.
- `uv run pytest tests/unit tests/integration -q` passes.
- `uv run python evaluation/tool_smoke.py` passes.
- `uv run python evaluation/mcp_smoke.py` still passes.
- Documentation records completed scope and remaining Hermes gaps.
