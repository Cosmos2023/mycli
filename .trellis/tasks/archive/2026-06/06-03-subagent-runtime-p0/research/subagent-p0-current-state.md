# Subagent Runtime P0 Current State

## Baseline

- Branch: `feature/mycli-subagent-runtime-p0`
- Base: `feature/mycli-hermes-parity-consolidated`
- MCP P0 is integrated into consolidated and verified before branching.

## Existing Capabilities

- `domain.subagents` already defines `SubAgentProfile`, `SubAgentInvocation`, `SubAgentResult`, and run summaries.
- `domain.subagent_profiles` has built-in `executor`, `explore`, and `review` profiles plus a global denylist.
- `application.runtime.subagents.service.SubAgentService` already supports sync/background execution, child session ids, recent run summaries, transcript recording, and XML-style bounded reports.
- `application.runtime.subagents.loop.SubAgentChildLoop` runs a child loop through model requests and tool execution.
- `tools.task.TaskTool` delegates to `SubAgentService` and returns `ToolResult`.
- `services.subagents.provider.SubAgentToolContributionProvider` exposes per-profile contributed tools such as `subagent.explore`.
- `tools.registry.combined_tool_manifest()` already renders `subagent:*` contributed tools as `source=subagent` and `toolset=external`.
- `DoctorService` has a basic `subagents` check using built-in profiles.

## Gaps Against Goal

- Profiles are hard-coded only; no `.mycli/subagents/*.toml` or `~/.mycli/subagents/*.toml` discovery.
- Subagent diagnostics do not report parse issues, enabled/disabled counts, unknown tool references, or high-risk exposure warnings.
- No provider-free `mycli subagents list|inspect`.
- Runtime profile lookup uses global `get_sub_agent_profile`, so configured profiles cannot be invoked.
- Subagent contributed provider uses the hard-coded profile list only.
- No provider-free subagent smoke that proves profile discovery, CLI, invocation ToolResult, and failure diagnostics.

## Implementation Direction

- Add a service-layer profile registry that merges built-ins, user profiles, and repo profiles.
- Keep built-ins as fallback and let repo config override user/builtin by id.
- Support TOML profiles with: `id`, `name`, `description`, `instruction` or `system_prompt`, `allowed_tools`, `denied_tools`, `model`, `enabled`, and optional `[budget]`.
- Preserve domain purity; parsing stays in services, domain dataclasses remain generic.
- Inject a profile resolver/list provider into `SubAgentService` and `SubAgentToolContributionProvider` instead of direct global lookup.
- Add provider-free CLI management and enhanced doctor diagnostics.
- Add a deterministic fake child loop smoke for single sync invocation without model/API key.
