# Stable Approval Decision IDs

## Problem

All approval prompts currently share `decision_id="decision_current"`. That is
usable for a single in-process TUI but weak for a Hermes-like contract: clients
cannot bind a response to the specific tool call that requested approval, and
stale prompt handling stays implicit.

## Scope

In scope:

- Gateway approval request payload IDs.
- Gateway approval response validation for stable IDs and the legacy alias.
- Node scripted client and tests that consume the emitted ID.
- Runtime TUI gateway contract documentation.

Out of scope:

- New approval persistence tables.
- MCP/skills/subagent/ACP productization.
- Full approval policy redesign.

## Requirements

- Approval requests must emit a stable `decision_id` derived from
  `PendingDecision.tool_call.call_id` when present.
- If no call id exists, the gateway may fall back to `decision_current`.
- Approval responses must accept the active stable decision id and the
  compatibility alias `decision_current`.
- Approval responses with any other id must return `decision_not_pending` and
  must not resolve the pending decision.
- The response notification must echo the actual accepted decision id.

## Acceptance Criteria

- Gateway unit tests prove approval request emits a call-id-backed decision id.
- Gateway unit tests prove stable-id approval responses are accepted and stale
  ids are rejected.
- Existing `decision_current` compatibility tests still pass.
- Contract docs describe stable decision ids and compatibility alias behavior.
- Focused Python and Node tests pass.
