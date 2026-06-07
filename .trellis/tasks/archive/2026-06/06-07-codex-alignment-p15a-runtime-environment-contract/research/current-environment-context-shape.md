# Current Environment Context Shape

## Findings

- `TurnContextAssembler._render_environment_context()` currently renders only
  `Workspace root: <path>` plus deduplicated baseline environment content.
- `InstructionContractAssembler` turns the `ENVIRONMENT_CONTEXT` section into a
  contextual user fragment with the prefix `这是本轮相关的环境事实。`.
- `message_builder.build_runtime_items()` and `build_legacy_messages()` send
  contextual user sections to the model.
- `RequestShapeBuilder` includes `environment_context` as a dynamic contextual
  fragment and lists it before conversation replay/memory/plan and before the
  current user intent tail.
- `ExecutionPolicy` and `SandboxProfile` already exist, but their sandbox data
  currently flows to trace/doctor/dry-run diagnostics through
  `ToolRuntimeDecision.to_trace_payload()`, not to the model-visible
  environment context.
- P14 added `ExecPolicyRuleSet`, but model-visible context does not yet expose
  whether user/project/session execpolicy rules are loaded.

## Design Direction

- Add a small typed runtime environment contract to `ExecutionContext`.
- Build it in `RuntimeContextBuilder` from `ExecutionPolicy.for_workspace()` and
  the loaded execpolicy rule set passed from `AgentRuntime`.
- Render bounded, model-visible lines from `TurnContextAssembler`.
- Do not render raw command args, rule pattern tokens, env var values, secrets,
  or provider payloads.
- Keep the section dynamic and provider-visible through the existing
  environment context path.
