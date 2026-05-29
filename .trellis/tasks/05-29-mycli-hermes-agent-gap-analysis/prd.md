# brainstorm: mycli hermes-agent engineering gap analysis

## Goal

Compare local `mycli` against the cloned `hermes-agent` repository and identify what mycli is missing if the goal is to evolve it into a Hermes-like agent, with emphasis on agent engineering, operational maturity, safety, extensibility, and productization.

## What I Already Know

- User wants mycli to become more like Hermes Agent.
- Hermes repo path: `/Users/cosmos/Desktop/开源agent/hermes-agent`.
- mycli is a Python 3.13 local-first coding agent with CLI/TUI, internal runtime protocol, provider adapters, tool registry, sub-agent service, memory, skills, MCP client path, traces, and tests.
- Hermes is a larger productized agent platform with CLI, messaging gateway, web/dashboard surfaces, ACP/MCP integrations, cron, provider ecosystem, skills, memory, setup/doctor/update flows, and extensive CI.
- Local verification from previous work: mycli tracked code passes `pytest`, `ruff`, and strict `mypy` when excluding unrelated untracked migration shards.

## Assumptions (Temporary)

- The target is not to clone Hermes line-for-line, but to use Hermes as a benchmark for agent engineering maturity.
- mycli should preserve its cleaner layered architecture instead of adopting Hermes' large legacy/global module shape.
- The near-term output should be a prioritized gap analysis and roadmap, not immediate implementation.

## Open Questions

- None.

## Requirements (Evolving)

- Produce a concrete comparison of mycli and Hermes across agent engineering dimensions.
- Identify mycli strengths as well as gaps.
- Prioritize gaps by leverage and sequencing.
- Avoid recommending wholesale rewrites or copying Hermes internals where mycli's architecture is cleaner.
- Prioritize the first roadmap phase around coding-agent engineering rather than personal-assistant platform surfaces or broad plugin/ecosystem work.
- Treat messaging gateways, cron, dashboard, and broad personal-assistant features as later phases unless needed to support coding-agent reliability.
- Make runtime safety and recovery the first coding-agent engineering MVP theme.
- Focus the first phase on preventing bad autonomous coding outcomes: unrecoverable file mutations, repeated no-progress tool loops, opaque failures, and weak post-failure diagnosis.
- Preserve mycli's append-only / prefix-cache invariant as a hard design constraint for runtime safety work.
- Runtime safety/recovery features must not rewrite already appended provider transcript messages.
- Safety state should not change stable system instructions, stable tool schema, or deterministic tool ordering.
- Checkpoint, rollback, guardrail, and diagnostics metadata should live in execution-layer state, trace/observability events, session metadata, or post-intent volatile context only when model-visible guidance is required.
- Use checkpoint/rollback as the first concrete runtime safety/recovery MVP.
- Treat existing `FileHistoryService`, `_snapshot_before_file_mutation()`, `/undo`, and file-history tests as the starting point to harden, not replace wholesale.
- Use mycli's FileHistory backend for the MVP rollback mechanism.
- Do not use Git-native checkpoints in the MVP; Git-aware checkpoint metadata can be considered later after file-history rollback is reliable.
- First FileHistory hardening slice is coverage expansion.
- Cover all currently registered local file mutation tools: `Edit` and `Write`.
- Treat removed/not-current default tools such as Move/Delete/Mkdir as future compatibility targets, not MVP implementation targets.
- Add a generic mutation metadata contract so file-changing tools can declare affected paths without hardcoding every tool name in `ToolExecutionService`.
- Apply the mutation metadata contract to `Edit` and `Write` in this MVP.
- If rollback detects that a target file changed after the checkpointed mutation, refuse to overwrite by default and report a conflict.
- Do not add force rollback in the MVP unless needed by tests or user workflow; `/undo --force` can be a later UX extension.
- Include cache-shape regression tests in the same MVP so checkpoint/rollback metadata cannot accidentally drift into stable request prefix surfaces.

## Acceptance Criteria (Evolving)

- [ ] Comparison covers runtime loop, tools, skills, memory, subagents, provider management, safety, CI, packaging, deployment, and UX surfaces.
- [ ] Output distinguishes "missing capability" from "capability exists but immature".
- [ ] Output proposes a staged roadmap for mycli.
- [x] User chooses a strategic priority before implementation planning.
- [x] First-phase MVP has a clear engineering theme and excludes lower-priority Hermes parity surfaces.
- [x] Runtime safety/recovery MVP scope is narrowed to a small set of concrete deliverables.
- [ ] Design explicitly identifies cache-stable vs cache-volatile surfaces.
- [ ] Cache diagnostics remain able to prove stable system hash and tool schema hash do not drift unless actual instructions/tools change.
- [ ] Mutating file tools create a recoverable checkpoint before applying changes.
- [ ] `/undo` or equivalent rollback can restore the latest mutation without changing model-visible stable prefix.
- [x] Rollback backend choice is decided.
- [x] First FileHistory hardening slice is decided.
- [ ] `Edit` and `Write` coverage includes existing file edits, whole-file overwrites, newly created files, no-op writes, failed validations, and failed tool execution.
- [ ] Mutating tools expose affected paths through a generic contract or metadata surface.
- [ ] `ToolExecutionService` snapshots through that contract rather than relying only on hardcoded `Edit`/`Write` path extraction.
- [ ] Rollback refuses to overwrite later file changes by default and reports the conflicting path.
- [ ] Cache-shape regression tests prove FileHistory/mutation metadata does not change stable system hash, tool schema hash, or tool order hash.

## Definition of Done (Team Quality Bar)

- Tests added/updated if implementation follows.
- Lint/typecheck/CI green for implementation changes.
- Docs/notes updated if behavior changes.
- Rollout/rollback considered for risky runtime or tool execution changes.

## Research References

- [`research/local-repo-comparison.md`](research/local-repo-comparison.md) - local repository comparison and prioritized capability gaps.

## Technical Notes

- Inspected mycli: `README.md`, `pyproject.toml`, `src/mycli/application/runtime`, `src/mycli/application/runtime/tools`, `src/mycli/services/approval`, `src/mycli/memory`, `src/mycli/services/skills`, `src/mycli/application/runtime/subagents`, `src/mycli/services/mcp`, `src/mycli/cli/bootstrap.py`, tests/docs inventory.
- Inspected Hermes: `README.md`, `pyproject.toml`, `agent/conversation_loop.py`, `agent/tool_executor.py`, `agent/tool_guardrails.py`, `agent/memory_manager.py`, `agent/skill_commands.py`, `agent/skill_utils.py`, `scripts/run_tests.sh`, `.github/workflows/tests.yml`, `.github/workflows/supply-chain-audit.yml`, top-level product directories.
- Hermes has stronger product/platform engineering; mycli has cleaner internal layering and stricter typing.
- Decision from user: prioritize coding-agent engineering first.
- Decision from user: first coding-agent engineering MVP should prioritize runtime safety and recovery.
- User explicitly flagged append-only prefix-cache hit rate as important; safety/recovery design must preserve it.
- Existing code evidence: `RequestShapeBuilder` separates stable system/tool schema, replay, current intent, and contextual/volatile fragments; `CacheShapeDiagnostics` records first changed fragments and provider message index; `CacheZones` fingerprints a frozen prefix based on message role/content/cache policy.
- Relevant existing specs: `docs/superpowers/specs/2026-04-29-runtime-v2-cache-first-architecture-design.md` and `docs/superpowers/specs/2026-05-16-append-only-context-window.md`.
- Existing checkpoint/rollback evidence: `src/mycli/services/file_history.py` implements snapshots and rewinds; `ToolExecutionService._snapshot_before_file_mutation()` snapshots `Edit`/`Write` before execution; `TurnService.undo_last_file_change()` exposes rollback; tests cover file-history rewind and an agent-runtime `/undo` style flow.
- Decision from user: MVP rollback backend should stay on mycli FileHistory rather than Git-native checkpointing.
- Decision from user: first FileHistory hardening slice is coverage expansion.
- Current default tool registry includes `Edit` and `Write` as local mutating file tools. `KillShell`, `Task`, and `Bash` are medium/high risk but not direct file mutation tools in the same structured sense; `Bash` file mutation detection is deferred unless a later MVP adds command-level filesystem effect tracking.
- Decision from user: coverage expansion should include `Edit`/`Write` plus a generic mutation metadata contract for future tools.
- Decision from user: rollback should refuse to overwrite later modifications by default.
- Decision from user: cache-shape regression tests belong in the same MVP.

## Decision (ADR-lite)

**Context**: Hermes has many product surfaces, but mycli's immediate goal is to become a stronger coding agent rather than a full personal assistant platform.

**Decision**: First roadmap phase prioritizes coding-agent engineering quality: runtime safety, recovery, tool reliability, subagent usefulness, CI, diagnostics, and developer operations.

**Consequences**: Messaging gateway, cron, dashboard, broad personal-assistant automations, and marketplace-scale plugin work remain later-phase items. The first phase should strengthen the core agent loop and operational confidence before widening product surface.

## Decision (ADR-lite): First MVP Theme

**Context**: The first phase needs a narrow engineering theme so it can become an implementation plan rather than a broad Hermes parity wishlist.

**Decision**: Runtime safety and recovery is the first MVP theme.

**Consequences**: Initial work should prioritize file mutation safety, checkpoint/rollback, loop guardrails, failure classification, and diagnostics. CI, setup/doctor, toolsets, MCP UX, and richer subagent profiles remain important but secondary unless they directly support safety/recovery.

## Decision (ADR-lite): Cache Preservation Constraint

**Context**: mycli intentionally optimizes request shape for prefix-cache reuse. Runtime safety/recovery features can accidentally destroy cache hit rate if they inject changing warnings into the stable prefix, mutate tool schema visibility, or rewrite historical transcript/tool-result messages.

**Decision**: Runtime safety/recovery must be cache-aware. It may persist execution metadata and trace events freely, but model-visible changes must be appended after the stable/replay prefix or represented as compact volatile context. Tool schemas and system instructions stay stable unless the actual toolset or instruction contract changes.

**Consequences**: Checkpoint/rollback should be implemented primarily as side-effect management around tool execution, not as new prompt text. Guardrail warnings should be deterministic, compact, and late-positioned. Every safety feature should include cache-shape tests or diagnostics assertions for stable hash preservation.

## Decision (ADR-lite): First Concrete MVP

**Context**: mycli already has file-history snapshots and `/undo`, so checkpoint/rollback can be hardened incrementally without destabilizing the runtime request shape.

**Decision**: First concrete MVP is cache-aware checkpoint/rollback hardening around file mutations.

**Consequences**: The implementation should improve reliability, coverage, and UX around existing file history rather than introduce a new prompt-visible safety layer. It should add cache-shape regression tests so safety metadata cannot drift into stable prefix surfaces.

## Decision (ADR-lite): Rollback Backend

**Context**: Git-native checkpoints are powerful in coding workflows, but they interact with dirty worktrees, untracked files, ignored files, and user-owned changes. mycli already has a workspace-local file-history service that is independent of Git and already integrated into mutating tool execution.

**Decision**: The MVP uses FileHistory as the rollback backend.

**Consequences**: The MVP stays smaller, works outside Git repositories, and avoids destructive Git operations. Git-aware checkpointing remains out of scope for this phase.

## Decision (ADR-lite): FileHistory Hardening Slice

**Context**: Runtime safety/recovery has multiple valid hardening directions. Coverage expansion is the least speculative because mycli already snapshots `Edit` and `Write`, and test gaps can be closed without changing model-visible prompts.

**Decision**: The first hardening slice is FileHistory coverage expansion for currently registered structured file mutation tools.

**Consequences**: The MVP will focus on `Edit` and `Write` behavior and tests while adding a small extension point for future mutating tools. Shell-command filesystem mutation tracking, Git-native rollback, and richer undo UX remain later phases.

## Decision (ADR-lite): Mutation Metadata Contract

**Context**: `ToolExecutionService` currently snapshots by checking a hardcoded set of mutation tool names and extracting `file_path`/`path`. That works for `Edit` and `Write`, but it does not scale cleanly to future structured mutation tools or MCP/local tools with multiple paths.

**Decision**: Add a generic mutation metadata contract for structured tools to declare affected paths. The MVP wires `Edit` and `Write` into this contract and keeps `Bash` out of scope.

**Consequences**: The checkpoint layer becomes extensible without changing model-visible tool schemas or stable prompts. Future Move/Delete/Mkdir/MCP write tools can opt into FileHistory snapshots without adding prompt-visible safety text.

## Decision (ADR-lite): Rollback Conflict Policy

**Context**: A rollback can become destructive if a user or later agent action edits the same file after the checkpointed mutation. Blindly restoring the snapshot would erase those later changes.

**Decision**: Rollback refuses to overwrite later modifications by default.

**Consequences**: `/undo` becomes safer but may require the user to resolve conflicts manually. A future `/undo --force` can be added if user workflows need explicit override.

## Decision (ADR-lite): Cache Regression Tests

**Context**: Prefix-cache preservation is a core constraint. Safety metadata can easily leak into stable prompt/tool surfaces if not tested.

**Decision**: Include cache-shape regression tests in the FileHistory hardening MVP.

**Consequences**: The implementation has a slightly larger test surface, but it directly protects the cache-hit-rate requirement and prevents future regressions.

## Technical Approach

Use the existing FileHistory integration as the base:

- Add a small structured contract for tools to expose mutation targets without changing model-visible tool schemas.
- Wire `Edit` and `Write` into that contract.
- Have `ToolExecutionService` snapshot through the contract before execution.
- Preserve existing `FileHistoryService` storage and `/undo` entrypoint.
- Add conflict detection in rollback using the existing manifest `change_detection` metadata.
- Add request-shape regression coverage that verifies checkpoint/rollback state does not alter stable system/tool-schema/tool-order hashes.

## Implementation Plan (Small PRs)

- PR1: Mutation metadata contract
  - Add contract on structured tools for affected file paths.
  - Adapt `Edit` and `Write`.
  - Update `ToolExecutionService` to use the contract while keeping current behavior.

- PR2: FileHistory rollback hardening
  - Expand tests for edit, overwrite, create, no-op, validation failure, and execution failure.
  - Add rollback conflict detection and conflict messaging.
  - Keep force rollback out of scope.

- PR3: Cache-shape regression guard
  - Add tests proving mutation/checkpoint metadata stays out of stable request fragments.
  - Assert stable system hash, tool schema hash, and tool order hash remain unchanged when only safety/checkpoint state changes.

## MVP Summary

**Goal**: Make mycli's existing file checkpoint/rollback mechanism reliable enough for coding-agent safety without harming append-only prefix-cache behavior.

**Requirements**:

- Runtime safety/recovery first phase focuses on FileHistory-backed checkpoint/rollback.
- Structured mutating tools expose affected paths through a generic contract.
- `Edit` and `Write` are covered in MVP.
- Rollback refuses to overwrite later modifications by default.
- Cache-shape regression tests are part of MVP.

**Out of Scope**:

- Git-native checkpointing.
- `/undo --force`.
- Bash filesystem-effect tracking.
- Messaging gateway, cron, dashboard, and broader Hermes platform parity.

## Implementation Slice

The first implementation slice has been split into child task:

- `05-29-cache-aware-filehistory-rollback-hardening` - narrow implementation task for FileHistory mutation metadata, rollback conflict handling, and cache-shape regression tests.

## Out of Scope (Explicit)

- No implementation in this brainstorm turn.
- No direct code import from Hermes.
- No attempt to fully audit every Hermes file.
- Git-native checkpoint/rollback.
