# M8 Node Runtime Parity Closure And Python Retention

## Goal

Finish the Node.js rewrite without changing the established terminal product. Close every retained
user-visible Python/Node parity gap, make Node the only runtime started by the npm CLI, and retain
the Python implementation as an independently launched, tested reference runtime.

## What I Already Know

- M1-M7 are committed and M7 is archived.
- The original rewrite design defined M8 as the Python-retirement boundary; the user subsequently
  required that Python source, packaging, tests, and independent launch remain available.
- The existing TUI is intentionally preserved; a runtime-language migration is not a TUI redesign.
- The Node gateway persists submitted user messages, but does not emit the user-message lifecycle
  events required for immediate transcript projection. Resume can reconstruct those messages, so
  this is a live event-parity defect rather than data loss.
- The Python slash-command registry defines the supported TUI command manifest and ownership
  policy. The Node gateway currently lists only its shell command plus contributed integration
  commands, leaving retained built-in commands absent from the Node TUI command palette.
- The npm CLI still imports the Python sidecar and accepts `--runtime-backend`; package scripts and
  CI still install Python and run Python parity suites.
- The user requires retained slash commands and other observable capabilities to be reconciled
  before Python is removed.
- The user explicitly requested that no subagents be used.

## Requirements

1. Restore live committed user-message projection in the Node TUI using canonical lifecycle
   events, stable `client_user_message_id` identity, and mirror/replay deduplication.
2. Port the retained built-in slash-command manifest, parsing, aliases, availability rules,
   client-action routing, backend execution, presentation shape, and error behavior to Node.
3. Run a documented black-box parity audit across the Python and Node backends while Python is
   still present. Classify every difference as fixed, explicitly retired, or test-only.
4. Treat observable TUI behavior, session operations, approvals, tools, providers, memory,
   compaction, shell, integrations, management commands, and diagnostics as retirement blockers.
5. Make Node the only backend started by the npm CLI. Remove sidecar startup, compatibility
   routing, backend selection flags, Python probing, and Python-owned process lifecycle from npm
   startup.
6. Preserve Python production source, packaging metadata, dependencies, tests, cross-backend
   fixtures, and Python 3.13 CI as an independently launched reference implementation.
7. Preserve language-neutral assets and native helpers that the Node runtime still needs.
8. Update installation, command reference, migration, troubleshooting, rollout, and extension
   documentation for the Node-only product.
9. Keep secrets, prompts, provider payloads, private paths, and raw tool output out of diagnostics
   and smoke output.

## Delivery Tasks

### Task 1: User Message Lifecycle Parity

- Emit canonical `item.started` and `item.completed` events only after durable user-message commit.
- Keep direct and `runtime.event` mirror delivery deduplicated.
- Prove live transcript and resumed transcript identity, ordering, and content match.

### Task 2: Slash Command And TUI Control Parity

- Establish a Node-owned canonical built-in command registry.
- Preserve visible commands, hidden aliases, TUI client actions, backend actions, argument policy,
  running-turn availability, and bounded structured results.
- Add a generated or executable parity matrix so future command drift fails tests.

### Task 3: Final Retained-Capability Audit

- Compare black-box bootstrap, status, command, session, turn, approval, queue, shell, resource,
  extension, management, and shutdown behavior.
- Fix retained behavior gaps and record intentional retirements explicitly.
- Freeze the last cross-backend fixtures before deleting Python.

### Task 4: Node-Only Composition Root

- Remove the Python sidecar and runtime backend router from production startup.
- Remove `--runtime-backend` and related environment switches from supported CLI behavior.
- Ensure signals, shutdown, error codes, and TTY ownership remain Node-owned.

### Task 5: Python Reference Runtime Retention

- Preserve the Python production package, packaging metadata, scripts, pytest, ruff, mypy, wheel,
  and Python 3.13 CI coverage.
- Keep the Python runtime independently launchable through `uv run mycli`; do not reconnect it as
  an npm sidecar or automatic fallback.
- Retain required native sandbox assets and the final Node-owned parity fixtures.

### Task 6: Node-Only Release Gate

- Verify build, contract drift, lint, typecheck, Node tests, cross-platform-sensitive tests, packed
  npm install, clean-home startup, and provider-free smoke.
- Run one credential-gated Responses smoke only after offline gates pass.
- Prove the packed CLI does not start, import, invoke, or probe for Python.
- Update all user and maintainer documentation.

## Acceptance Criteria

- [x] Submitted user messages appear immediately in the live TUI exactly once and survive resume.
- [x] Every retained built-in slash command is discoverable and behaves consistently in Node.
- [x] Unknown, unavailable, and malformed slash commands fail locally with stable bounded errors
      and are never sent to the model as ordinary user messages.
- [x] The parity inventory has no unresolved retained-capability rows.
- [x] The production CLI has no Python backend selection or sidecar startup path.
- [x] A clean packed npm installation starts and runs without Python installed or probed.
- [x] Python source, package metadata, dependencies, tests, and Python 3.13 CI remain green and
      independently launchable.
- [x] Node 22.19 and Node 24 gates pass on supported platforms for platform-sensitive behavior.
- [x] Build, contract drift, lint, typecheck, Node unit/integration tests, package smoke, and the
      sanitized M8 smoke pass.
- [x] Installation, command, troubleshooting, migration, extension, and rollback docs describe the
      Node-only release accurately.

## Definition Of Done

- Tests are added before each behavior fix and demonstrate the previous failure.
- Each delivery task passes focused build, lint, typecheck, and tests before the next begins.
- Python source and packaging are preserved after Tasks 1-3 close the parity inventory.
- The packed npm artifact contains no accidental Python runtime dependency, while the repository
  retains the independent Python implementation.
- Security, cancellation, durability, idempotency, and secret-redaction invariants remain covered.
- Work is committed in coherent batches; unrelated user files remain untouched.

## Technical Approach

Use parity-first Node promotion. Reuse the existing gateway schema, TUI reducer, session store,
command-result adapters, and Node package boundaries. Add missing behavior at the owning Node
boundary instead of teaching the TUI backend-specific exceptions. Preserve the last Python/Node
comparison fixtures as sanitized Node regression fixtures, then remove only npm sidecar and
backend-selection compatibility code after all retained rows are green.

## Decision (ADR-lite)

**Context:** Deleting Python immediately would make existing parity gaps harder to detect and would
turn the old implementation from an executable reference into archaeology.

**Decision:** Complete three parity tasks before Node promotion/release work. User-visible
differences block Node default promotion unless they are explicitly approved retirements. Preserve
the Python implementation as a separately invoked reference rather than an npm fallback.

**Consequences:** The npm release keeps the established product contract and gains durable drift
tests without discarding the Python reference. Rollback after M8 means installing the previous npm
package or launching the Python reference between turns, not selecting a Python backend in the same
Node process.

## Out Of Scope

- New unrelated agent features or a visual redesign of the TUI.
- Source compatibility for Python plugins.
- Retaining Python as a hidden fallback, diagnostic probe, or optional production backend.
- Removing the retained Python runtime or language-neutral external hooks merely because a
  configured hook may invoke Python.
- Bundling Node into a standalone executable.

## Technical Notes

- Approved roadmap: `docs/superpowers/specs/2026-08-03-mycli-node-runtime-rewrite-design.md`.
- Rollout boundary: `docs/node-runtime-rollout.md`.
- User-message contract: `docs/superpowers/specs/2026-07-21-codex-user-message-lifecycle-design.md`.
- Gateway/TUI contract: `.trellis/spec/backend/runtime-tui-gateway-contract.md`.
- Research baseline: `research/m8-retirement-inventory.md`.
- Unrelated untracked cache-demo files predate M8 and must remain untouched.
