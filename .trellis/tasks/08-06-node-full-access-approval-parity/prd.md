# Node Full-Access Approval Parity

## Goal

Make the Node runtime honor Codex full-access semantics: a trusted workspace using the
`full-access` profile runs without approval prompts or filesystem sandbox boundaries while
explicit deny rules and fail-closed validation remain authoritative.

## Requirements

1. Pass the frozen turn execution policy through approval and tool execution.
2. Preserve this decision order:
   - malformed or unsupported call -> deny;
   - explicit exec-policy `deny` -> deny;
   - explicit exec-policy `ask` under `full-access` -> deny because prompts are disabled;
   - explicit exec-policy `allow` -> allow;
   - `full-access` routine Shell or extension request -> allow;
   - otherwise use the existing workspace/read-only approval behavior.
3. Let `Read`, `Write`, `Edit`, `Patch`, and Shell `cwd` access canonical paths outside the
   workspace only when the frozen filesystem policy is unrestricted.
4. Preserve snapshot guards, atomic mutation, content validation, explicit deny rules, and bounded
   path-safe receipts for outside mutations.
5. Do not let `full-access` bypass workspace trust, provider authentication, clarification, or
   protocol validation.
6. Apply permission changes only through the existing gateway configuration flow; do not add a
   second selector or environment switch.
7. Update the M6 integration expectation that currently treats approval under `full-access` as
   correct behavior.
8. Keep the four unrelated Responses cache-demo files untouched.

## Acceptance Criteria

- [x] A routine unknown Shell command evaluates to `allow` under `full-access`.
- [x] The same command remains `request` under `workspace`.
- [x] Explicit `ask` and `deny` rules become denials under `full-access`; neither emits a prompt.
- [x] Routine extension tools configured as `request` are allowed under `full-access`.
- [x] Malformed and unknown tool calls remain denied.
- [x] Full access permits outside Read/Write/Edit/Patch paths and Shell working directories.
- [x] Workspace access continues to reject traversal, outside absolute paths, and symlink escape.
- [x] Outside Edit/Patch retains the shared Read snapshot and stale-content checks.
- [x] Outside mutation receipts and diffs do not expose an absolute local path.
- [x] Selecting `full-access` through `permissions.update` makes the next eligible Node turn run
      without `approval.request`.
- [x] Workspace trust continues to gate tool execution independently of the permission profile.
- [x] Focused tests, Node lint, typecheck, and the relevant M6/M8 regression suites pass.

## Out Of Scope

- Removing approval UI or durable approval continuation.
- Changing explicit exec-policy rule syntax or persistence.
- Making `full-access` bypass workspace trust.
- Suppressing `AskUserQuestion` clarification or provider authentication prompts.
- Refactoring the complete execution-policy architecture.

## Decision

Pass the immutable per-turn `ExecutionPolicy` to `ApprovalPolicy` and every adapter. Restricted
path resolution retains the existing real-workspace and symlink checks; unrestricted resolution
canonicalizes the requested target without applying the workspace boundary. Snapshot keys retain
the canonical outside path internally, while model-visible receipts and diffs use a basename.
The mutable permission-profile input remains only as a compatibility fallback for direct policy
callers; active runtime turns use the frozen policy.
