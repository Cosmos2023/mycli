# P22 Research: ToolRuntime Coverage Consolidation

## Current state

- `ToolExecutionService` is the main execution entry for model-called tools.
- `RuntimePolicyGate` resolves sandbox, execpolicy, approval decisions, and emits bounded `runtime_policy_decision` traces.
- `ToolExecutionService` emits `tool_runtime_lifecycle` traces for planned/started/terminal phases.
- Shell lifecycle, shell backend, background job, skill activation, hook execution, plugin/MCP adapters, and subagent jobs have separate bounded diagnostics.
- Doctor can summarize each diagnostic family, but it cannot yet answer whether each tool-like lane is covered by lifecycle, policy, approval, sandbox, cancellation, and bounded diagnostics.

## Gap

The runtime has strong pieces, but no single coverage contract that names each tool-like action lane and states which runtime gates apply. This makes it hard to see drift when hooks, MCP, plugins, subagents, skills, or shell background paths bypass or only partially participate in ToolRuntime semantics.

## Direction

Add a metadata-only ToolRuntime coverage registry:

- Built-in tool execution
- Shell foreground/background
- MCP tool
- Plugin tool
- Hook execution
- Subagent job
- Skill activation
- Background job control

Each lane should publish bounded booleans/labels for lifecycle, effect profile, sandbox, execpolicy, approval, hooks, background, cancellation, diagnostics, and known gap. Doctor can summarize this as `tool_runtime_coverage` without inspecting raw tool arguments, commands, prompts, outputs, or payloads.

## Non-goals

- Do not rewrite all execution paths into a new runtime in this phase.
- Do not add new dependencies.
- Do not make hooks provider-visible tools.
- Do not implement remote sandbox, ACP, gateway, or background maintenance.
- Do not touch compact/rehydration implementation.

## Redaction

Coverage diagnostics may include lane ids, owner labels, boolean support flags, and bounded gap labels. They must not include raw commands, raw args/env, stdout/stderr, raw prompts, raw tool outputs, hook stdin/stdout/stderr, provider payloads, headers, secrets, or local file payloads.
