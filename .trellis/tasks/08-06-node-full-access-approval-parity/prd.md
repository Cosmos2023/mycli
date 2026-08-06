# Node Full-Access Approval Parity

## Goal

Make the Node runtime honor the established Python permission semantics: a trusted workspace using
the `full-access` profile skips routine tool approval while explicit execution-policy rules and
fail-closed validation remain authoritative.

## Requirements

1. Propagate permission-profile changes from the gateway/runtime boundary into `ApprovalPolicy`.
2. Preserve this decision order:
   - malformed or unsupported call -> deny;
   - explicit exec-policy `deny` -> deny;
   - explicit exec-policy `ask` -> request approval;
   - explicit exec-policy `allow` -> allow;
   - `full-access` routine Shell or extension request -> allow;
   - otherwise use the existing workspace/read-only approval behavior.
3. Do not let `full-access` bypass workspace trust, provider authentication, clarification, or
   protocol validation.
4. Apply permission changes only through the existing gateway configuration flow; do not add a
   second selector or environment switch.
5. Update the M6 integration expectation that currently treats approval under `full-access` as
   correct behavior.
6. Add unit and integration regression coverage before changing production behavior.
7. Keep the four unrelated Responses cache-demo files untouched.

## Acceptance Criteria

- [ ] A routine unknown Shell command evaluates to `allow` under `full-access`.
- [ ] The same command remains `request` under `workspace`.
- [ ] Explicit `ask` and `deny` rules still win under `full-access`.
- [ ] Routine extension tools configured as `request` are allowed under `full-access`.
- [ ] Malformed and unknown tool calls remain denied.
- [ ] Selecting `full-access` through `permissions.update` makes the next eligible Node turn run
      without `approval.request`.
- [ ] Workspace trust continues to gate tool execution independently of the permission profile.
- [ ] Focused tests, Node lint, typecheck, and the relevant M6/M8 regression suites pass.

## Out Of Scope

- Removing approval UI or durable approval continuation.
- Changing explicit exec-policy rule syntax or persistence.
- Making `full-access` bypass workspace trust.
- Suppressing `AskUserQuestion` clarification or provider authentication prompts.
- Refactoring the complete execution-policy architecture.

## Decision

Add a mutable permission-profile input to `ApprovalPolicy`, update it through the existing
`NodeTurnRuntime.configureExecutionPolicy` path, and evaluate explicit rules before the
`full-access` routine-allow branch. This matches Python behavior without duplicating policy logic
in the gateway or weakening explicit safety rules.
