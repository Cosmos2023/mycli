# M7 Integrations And Remaining Parity

## Goal

Port every remaining supported production capability from the Python runtime to the Node runtime,
so M8 can retire the Python sidecar without redesigning providers, extensions, background agents,
or management workflows.

## What I Already Know

- M1-M6 are complete. The Node backend owns TTY/TUI lifecycle, provider turns, file tools,
  approvals, durable state/recovery, memory, and persistent shell processes.
- The approved rewrite roadmap defines M7 as Anthropic provider support, MCP, Plugin API v2,
  configured hooks, skills, subagents, setup, management commands, doctor, migration diagnostics,
  and documentation.
- The final Node runtime must preserve production behavior or record an explicitly approved
  removal; silent Python fallback after Node accepts a turn is forbidden.
- Python plugin source compatibility is not a target. The approved direction is a process-isolated
  TypeScript Plugin API v2.
- Configured command hooks are language-neutral external commands and must preserve sandbox,
  approval, timeout, output-bound, environment, and redaction behavior.
- Existing Node packages do not yet contain a dedicated integrations package; current extension
  behavior remains primarily under `src/mycli/`.
- The user requested full M7 progression and previously requested that no subagents be dispatched.

## Assumptions

- M7 remains one product milestone but is implemented as ordered, independently testable batches.
- Existing Python behavior and canonical gateway/tool contracts are the parity reference unless
  the approved Node rewrite design explicitly replaces them.
- Skills need Node discovery/invocation parity because they are a supported production capability,
  even though the milestone bullet groups them under remaining parity rather than naming them
  separately.
- Management commands remain non-TTY-capable and machine-readable where the Python CLI already
  provides JSON output.

## Requirements

- Add Anthropic Messages behind the existing provider-neutral request/stream boundary.
- Port local stdio and supported remote MCP discovery, tool projection, execution, cleanup, and
  diagnostics without mutating the stable built-in tool schema.
- Implement process-isolated TypeScript Plugin API v2 with manifest validation, bounded protocol,
  tools/hooks/commands, lifecycle control, and migration diagnostics for Python plugins.
- Port configured command hooks with allowlisting, digest verification, safe environment policy,
  sandboxing, timeout, output bounds, and hook-point ordering.
- Port skill discovery, precedence, validation, model catalog projection, invocation, and durable
  instruction injection.
- Port foreground/background subagents, child-session ownership, task progress, interruption,
  result collection, recovery, and TUI events.
- Port setup and the supported management/diagnostic command surface, including doctor.
- Keep provider SDK work in `@mycli/providers`, create one capability-structured
  `@mycli/integrations` package, and compose integrations in `@mycli/app` without a runtime cycle.
- Preserve explicit capability discovery, bounded redacted diagnostics, cross-platform cleanup,
  and rollback to `python-sidecar` until M8.

## Acceptance Criteria

- [ ] Anthropic text/reasoning/tool turns complete and persist entirely in Node.
- [ ] MCP tools discover, project, execute, interrupt, and clean up with parity fixtures.
- [ ] Plugin API v2 loads valid TypeScript plugins in an isolated worker process and rejects or
      diagnoses incompatible Python plugins without importing them.
- [ ] Configured hooks enforce allowlist, digest, sandbox, timeout, output, and redaction rules.
- [ ] Skills preserve discovery precedence and inject bounded persistent instructions without
      destabilizing the default provider tool schema.
- [ ] Subagents preserve child-session/task lifecycle, background progress, interruption, and
      terminal result semantics.
- [ ] Setup, management commands, and doctor work through the compiled Node CLI without Python.
- [ ] Every retained production capability is Node-native or documented as an approved removal.
- [ ] Contracts, typecheck, lint, Node tests, cross-backend parity, package smoke, and an M7 live
      smoke pass without starting Python.

## Definition Of Done

- Unit tests cover each pure parser, policy, protocol, and lifecycle state machine.
- Integration tests cover real child processes, local MCP/plugin/hook workers, SQLite state, CLI
  routing, interruption, timeout, and cleanup.
- Cross-platform lanes cover process-sensitive behavior on Node 22.19 and Node 24.
- No credential, environment value, raw hook/plugin output, provider payload, prompt, or private
  path leaks through diagnostics or smoke output.
- Rollout, migration, rollback, extension-author, setup, and troubleshooting documentation is
  updated.

## Out Of Scope (Explicit)

- Removing Python production code or making Node the only backend; that is M8.
- Source-compatible execution of existing Python plugins inside the Node runtime.
- Hosted plugin marketplace, OAuth productization, or unrelated new integrations not already
  supported by mycli.
- Redesigning the TUI; M7 consumes the existing extension, task, selector, and diagnostic surfaces.
- Running raw TypeScript plugin source in production; Plugin API v2 loads compiled ESM workers.
- Adding hard-coded provider-step or tool-call limits to the main runtime or to subagent profiles
  that do not explicitly configure budgets.

## Research References

- `research/m7-capability-inventory.md` inventories Python parity behavior, current Node ownership,
  SDK constraints, management surfaces, and required test layers.
- `research/m7-package-protocol-decisions.md` defines package boundaries, dependency direction,
  extension protocols, alternatives, and the recommended implementation order.

## Feasible Delivery Approaches

### A. Ordered vertical slices in one M7 milestone (recommended)

Implement provider, integration foundation, skills, MCP, hooks, plugins, subagents, and management
in dependency order. Every slice has its own focused quality gate and can be reviewed independently,
while M7 closes only after the full parity gate passes.

This keeps the approved roadmap intact, catches dependency mistakes early, and allows rollback to
the Python sidecar throughout M7. It takes more disciplined intermediate gates but has the lowest
integration risk.

### B. Separate capability milestones

Treat Anthropic, MCP, plugins/hooks, subagents, and management as separate milestones. This gives
smaller planning documents and release units, but changes the approved M7/M8 roadmap and leaves the
meaning of “M7 complete” fragmented.

### C. Compatibility-first bulk port

Port Python module families in parallel under one large implementation pass, then integrate near
the end. This can make early file creation appear faster, but delays feedback on package cycles,
process isolation, provider schema stability, and CLI composition. It has the highest rework risk.

## Recommended Technical Approach

- Extend the existing provider-neutral stream for Anthropic; do not create a second agent loop.
- Add one `@mycli/integrations` package with capability-specific modules.
- Keep `@mycli/runtime` independent of integrations by injecting hook and child-runtime contracts;
  `@mycli/app` is the composition root.
- Use the official Anthropic and MCP SDKs behind narrow injectable facades.
- Keep one stable `Skill` tool, a schema-validated child-process Plugin API v2, and external-command
  hooks using the existing sandbox/process policy.
- Port doctor as small bounded collectors, not as a line-by-line translation of the Python service.
- Complete the eight delivery batches recorded in the package/protocol research document.

## Decision (ADR-lite)

**Context:** M7 contains several dependent provider, extension, process-lifecycle, and management
capabilities. A bulk port would delay feedback on package cycles and security boundaries, while
separate milestones would fragment the approved M7/M8 roadmap.

**Decision:** Deliver one M7 milestone as eight ordered vertical slices. Each slice receives focused
tests and a quality gate, but M7 closes only after the complete parity and no-Python smoke gate.

**Consequences:** The work remains rollbackable to `python-sidecar` throughout M7 and dependency
mistakes surface early. Intermediate slices are reviewable but are not represented as separate
product milestones.

## Technical Notes

- Rewrite design: `docs/superpowers/specs/2026-08-03-mycli-node-runtime-rewrite-design.md`.
- Current Node composition: `apps/mycli/src/node-runtime/`, `packages/providers/`,
  `packages/runtime/`, `packages/tools/`, and `packages/storage/`.
- Python reference areas to inventory: `src/mycli/services/mcp/`, plugin/hook/skill/subagent
  services and tools, setup/doctor services, CLI routing, schemas, and extension manifests.
- Relevant code-specs: `.trellis/spec/backend/runtime-tui-gateway-contract.md`,
  `.trellis/spec/backend/tool-manifest-contract.md`,
  `.trellis/spec/backend/plugin-runtime-contract.md`, and
  `.trellis/spec/backend/logging-guidelines.md`.
