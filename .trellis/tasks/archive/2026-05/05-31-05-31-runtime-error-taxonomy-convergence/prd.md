# Runtime Error Taxonomy Convergence

## Goal

Make gateway/runtime error codes a stable, cross-layer contract for Python,
extension manifest, and Node TUI clients.

## Requirements

- Keep Python as the source of truth for gateway error code enums.
- Expose an equivalent TypeScript `GatewayErrorCode` / code list in the Node
  protocol layer.
- Add tests proving the TypeScript code list matches the Python manifest schema.
- Ensure reducer request-failure and gateway-error metadata preserves stable
  code/method/message fields without string drift.
- Update runtime gateway contract docs.

## Non-Goals

- Do not introduce a new dependency.
- Do not productize MCP, skills, subagents, or ACP.
- Do not change provider/model failure internals unless needed to preserve the
  gateway contract.
- Do not merge into `main`.

## Acceptance Criteria

- A Node protocol test fails before implementation if the TypeScript taxonomy is
  missing or drifts from the Python manifest.
- Python gateway contract/extension manifest tests still pass.
- Node reducer/client tests still pass.
- Node `typecheck` passes.
- Trellis task is archived and committed on the feature branch.
