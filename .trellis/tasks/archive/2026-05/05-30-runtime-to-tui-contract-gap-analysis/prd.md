# Runtime-to-TUI Event/Status Contract Gap Analysis

## Goal

Compare mycli's current runtime-to-TUI event/status contract against Hermes Agent's TUI gateway pattern and define the gap to a Hermes-like target contract for robust live status, tool activity, approval, and terminal state rendering in the Node TUI.

## What I Already Know

- User asked to read Trellis and start a `runtime-to-tui event/status contract gap analysis`, using the main workspace `hermes-agent` as reference.
- Current worktree: `/Users/cosmos/Desktop/mycli/.worktrees/mycli-runtime-capabilities`.
- Main workspace Hermes reference: `/Users/cosmos/Desktop/mycli/hermes-agent`.
- Trellis developer identity is not initialized in this worktree; the task was created with `--assignee codex`.
- Current mycli Node TUI gateway uses JSON-RPC notifications whose `method` is the event name (`turn.started`, `turn.event`, `turn.completed`, `status.changed`).
- Hermes TUI gateway uses a canonical event envelope: JSON-RPC `method: "event"` with `params.type`, `params.session_id`, and `params.payload`.
- Previous main-workspace Hermes gap task already decided: benchmark Hermes capabilities, not Hermes' large legacy/global module shape.
- The target contract should be Hermes-like in event semantics: separate message streaming, reasoning/status, tool lifecycle, human approval/input gates, session snapshots, and terminal turn outcomes.

## Requirements

- Map current mycli runtime stream events, turn completion payloads, status payloads, and Node reducer handling.
- Map Hermes reference event/status patterns only as far as needed for TUI contract design.
- Identify concrete contract gaps, with code references and likely user-facing impact.
- Prioritize gaps into implementation slices that move mycli toward Hermes-like contract parity while preserving mycli's cleaner layered architecture.
- Define the runtime branch boundary as a shared runtime event contract that future TUI, subagent, MCP, ACP, session/log, and extension surfaces can consume.
- Treat P1 approval/status as the first validation slice of that shared contract, not as one-off fields bolted onto the existing protocol.
- Preserve Hermes-like event naming and extensible payload structure in P1 so later message, thinking/reasoning, tool lifecycle, clarify, turn lifecycle, replay, and typed envelope work can attach cleanly.
- Do not implement code in this analysis task unless a later user request explicitly switches to implementation.

## Acceptance Criteria

- [x] Trellis context and relevant specs are read.
- [x] Current task directory exists for this analysis.
- [x] Current mycli runtime/gateway/TUI contract surfaces are inspected.
- [x] Hermes reference gateway/TUI surfaces are inspected.
- [x] Research artifact records contract gaps and prioritization.
- [ ] User confirms whether to proceed into implementation planning.

## Definition of Done

- Analysis is persisted in `research/runtime-to-tui-contract-gaps.md`.
- Final response summarizes the top gaps and recommended next implementation slice.
- No runtime or TUI source code is changed during this analysis-only pass.

## Out of Scope

- Copying Hermes' gateway server wholesale.
- Avoiding Hermes parity by only patching isolated bugs.
- Replacing mycli's JSON-RPC transport unless contract parity requires a protocol-versioned migration.
- Implementing Hermes platform surfaces such as web, messaging gateways, cron, or dashboard.
- Changing model/provider runtime behavior.

## Research References

- [`research/runtime-to-tui-contract-gaps.md`](research/runtime-to-tui-contract-gaps.md) - current findings and recommended implementation sequence.

## Technical Notes

- Current mycli files inspected:
  - `src/mycli/domain/runtime/__init__.py`
  - `src/mycli/domain/runtime/protocol.py`
  - `src/mycli/application/runtime/model/model_turn_requester.py`
  - `src/mycli/cli/node_tui/protocol.py`
  - `src/mycli/cli/node_tui/gateway.py`
  - `src/mycli/cli/tui/app.py`
  - `src/mycli/cli/tui/transcript.py`
  - `tui/node/src/protocol/types.ts`
  - `tui/node/src/protocol/client.ts`
  - `tui/node/src/state/types.ts`
  - `tui/node/src/state/reducer.ts`
  - `tui/node/src/state/transcript.ts`
  - `tui/node/src/app/ApprovalPrompt.tsx`
  - `tui/node/src/app/RunningActivity.tsx`
  - `tui/node/src/app/StatusLine.tsx`
  - `tests/unit/cli/node_tui/test_gateway.py`
- Hermes reference files inspected:
  - `/Users/cosmos/Desktop/mycli/hermes-agent/AGENTS.md`
  - `/Users/cosmos/Desktop/mycli/hermes-agent/tui_gateway/server.py`
  - `/Users/cosmos/Desktop/mycli/hermes-agent/ui-tui/src/gatewayTypes.ts`
  - `/Users/cosmos/Desktop/mycli/hermes-agent/ui-tui/src/gatewayClient.ts`
  - `/Users/cosmos/Desktop/mycli/hermes-agent/ui-tui/src/app/createGatewayEventHandler.ts`
  - `/Users/cosmos/Desktop/mycli/hermes-agent/ui-tui/src/app/turnController.ts`
  - `/Users/cosmos/Desktop/mycli/hermes-agent/ui-tui/src/app/turnStore.ts`

## Decision (ADR-lite): Hermes Contract Parity Target

**Context**: The user clarified that the purpose of this work is to benchmark against Hermes Agent, not merely patch local TUI bugs.

**Decision**: Treat Hermes Agent's TUI gateway/event model as the target reference for mycli's runtime-to-TUI contract. mycli should converge on the same semantic channels: message deltas/completion, reasoning/status updates, tool lifecycle events, approval/clarify gates, session snapshots, and terminal turn status.

**Consequences**: The implementation can still be phased, but every phase should be justified as a step toward Hermes-like parity. Small fixes are acceptable only when they align with that target contract.

## Decision (ADR-lite): Runtime Branch Boundary

**Context**: The mainline direction is that the runtime branch should not merely add a few TUI fields. It should establish a Hermes-like TUI gateway contract that later TUI, subagent, MCP, ACP, extension, and session/log work can share.

**Decision**: The runtime branch owns the shared event semantics and forward-compatible contract shape. P1 implements approval/status first because those are low-coupling, immediately visible, and good proof points for the contract direction.

**Consequences**: P1 must not introduce temporary names or ad hoc booleans that block later parity. Event names and payloads should reserve clean extension space for message/thinking/tool/clarify/turn lifecycle events and eventual typed envelopes with replay/dedupe metadata.

## Phased Contract Plan

1. **P1 approval + status**
   - `approval.request`
   - `approval.respond`
   - `status.update`
   - turn state: `running / waiting_approval / completed / failed / interrupted`
   - TUI gateway receives live state directly instead of inferring from transcript text.

2. **P2 tool lifecycle**
   - `tool.start`
   - `tool.progress`
   - `tool.complete`
   - `tool.failed`
   - Include tool call id, name, args preview, result summary, duration, and risk/approval metadata.

3. **P3 assistant/reasoning stream**
   - `message.delta`
   - `message.complete`
   - `thinking.delta`
   - `reasoning.delta`
   - Normalize provider-specific reasoning so TUI does not understand OpenAI/Anthropic/Codex wire formats.

4. **P4 typed envelope**
   - Add `event_id`, `session_id`, `turn_id`, `timestamp`, `type`, `payload`, and `seq`.
   - Support replay, dedupe, resume, and debug dumps.

5. **P5 terminal/runtime status**
   - `turn.started`
   - `turn.completed`
   - `turn.failed`
   - `turn.interrupted`
   - `turn.waiting_approval`
   - `clarify.request`
   - `clarify.respond`
