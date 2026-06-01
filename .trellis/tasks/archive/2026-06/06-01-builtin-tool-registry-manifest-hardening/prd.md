# Built-in Tool Registry Manifest Hardening

## Problem

`mycli` has useful built-in tools, but their stable metadata is still scattered
across individual `ToolSpec` objects, the approval safety policy, runtime
inspection output, and diagnostic checks. This makes it harder to treat the
local tools as a mature Hermes-like tool system: clients cannot reliably inspect
tool ids, toolsets, risk policy, capability tags, schemas, effects, or
availability from one contract.

## Scope

This slice covers the first P0 built-in tools closure:

- Define a stable built-in tool manifest from the existing registry.
- Expose tool id, route name, toolset, schema, risk level, approval policy,
  capability tags, effect profile, and availability.
- Keep model-visible tool rendering backward compatible.
- Make doctor validate the built-in tool manifest without mutating local state.
- Expose the tool manifest through the extension discovery manifest so the Node
  gateway and future extension clients have a single read-only surface.
- Add unit tests for registry manifest, extension manifest, safety-policy
  alignment, and doctor diagnostics.

## Non-goals

- No MCP, ACP, skills, subagent/multi-agent, browser, or computer-use
  productization.
- No copying Hermes-agent code.
- No large rewrite of existing tool execution.
- No merge to `main`.

## Requirements

1. Every built-in local tool has a stable manifest entry.
2. Manifest entries include:
   - `id`
   - `name`
   - `toolset`
   - `description`
   - `parameters`
   - `risk_level`
   - `approval_policy`
   - `capability_tags`
   - `effects`
   - `availability`
3. Built-in tool ids are stable and unique.
4. Toolset summaries are derived from manifest entries and include counts.
5. `ToolRegistry.render_for_model()` remains backward compatible.
6. Extension manifest includes the built-in tool manifest as a read-only
   discovery surface.
7. Doctor includes a `tool_manifest` check that reports bounded counts and fails
   if manifest shape is invalid or duplicate ids/names appear.
8. Safety policy behavior remains aligned with manifest metadata for core
   built-in tools.

## Acceptance

- Unit tests cover manifest shape, uniqueness, toolset counts, extension
  exposure, doctor diagnostics, and safety policy alignment.
- Existing tool tests continue to pass.
- No provider/model request is needed to validate this slice.
- The final report lists the branch, commit, modified areas, tests run, risks,
  and next recommended tools slice.
