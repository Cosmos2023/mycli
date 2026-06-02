# Subagent Task Tool Lifecycle Foundation Research

## Current State

- `TaskTool` is a built-in workflow tool bound to `SubAgentService` at runtime.
- `SubAgentService` already supports sync/background execution, profile lookup,
  child tool scope resolution, recent run summaries, and transcript inspection.
- MCP and skills already expose external contributed tools through
  `ToolContributionRegistration`, `ToolOrchestrator`, `ToolRouter`,
  `ExtensionManifestService`, doctor diagnostics, and deterministic smoke
  scripts.

## Gap

Task/subagent has runtime behavior, but it is not exposed like MCP/skills:

- no subagent-origin contributed tool provider
- no `subagent.*` entries in combined manifest/toolset manifest
- no doctor check for subagent profile diagnostics
- no deterministic smoke proving manifest + runtime lifecycle + doctor together

## Direction

Reuse the existing contribution path. Do not replace `TaskTool`; keep it as the
manual generic delegation tool. Add profile-specific `subagent.<profile>` tools
that delegate to the same `SubAgentService`.

This gives extension/TUI clients discoverable profile metadata without
productizing full multi-agent orchestration.
