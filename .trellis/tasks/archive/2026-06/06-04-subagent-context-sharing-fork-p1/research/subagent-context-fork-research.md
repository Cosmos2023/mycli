# Subagent Context Sharing / Fork P1 Research

## Roadmap Source

`docs/hermes-parity-roadmap.md` slice 3 requires local subagents to inherit
useful parent context without copying the whole parent transcript or polluting
the parent history.

## Current Implementation

- `SubAgentService.run_task()` builds a `SubAgentInvocation`, resolves a child
  tool scope, creates a child session id, and delegates to `SubAgentChildLoop`.
- `SubAgentChildLoop.run()` currently starts the child message list with only:
  - profile system prompt
  - user task description
- `SubAgentTranscriptRecorder` writes child system/user/assistant/tool/final
  rows to the child session id only, with parent session/turn metadata.
- `RuntimeEventLedger.context_baseline_from_contract()` already extracts a
  stable context baseline from provider instruction contracts and excludes
  high-churn kinds: conversation, memory, plan, user request.
- `RuntimeContextBuilder` loads the persisted `ContextBaseline` from the
  runtime snapshot and uses it for turn context assembly.
- `resolve_child_tool_scope()` already ensures a child tool set is bounded by
  parent tools, profile allowed tools, and policy denylist.
- `evaluation/subagent_smoke.py` verifies P0 profile discovery, task execution,
  manifest exposure, doctor, and basic tool-scope narrowing.

## Gap

The child agent does not receive a parent-context reference bundle. It therefore
behaves like an isolated profile runner rather than a fork of the parent agent's
stable workspace/session context.

The implementation must not pass the raw parent transcript to the child. The
child should inherit bounded reference context and produce its own transcript,
while the parent receives only the normal `Task` tool result summary/evidence.

## Proposed Design

Add a domain-level `SubAgentContextSnapshot` and lightweight diagnostics:

- `baseline_fragments`: selected `ContextBaseline` fragments, bounded by count
  and chars.
- `memory_fence`: optional bounded background memory/session summary text.
- `session_summary`: optional bounded parent session summary.
- `tool_names`: selected child tool scope after parent/profile/policy narrowing.
- `diagnostics`: bounded counts, hashes, lengths, and truncation flags only.

Pass the snapshot from `SubAgentService` into `SubAgentChildLoop.run()`.

Render the snapshot as a separate child system/reference message after the
profile system prompt and before the child task description. The rendered text
must clearly say it is inherited reference context, not new user input.

Record a child transcript item for the inherited context as system/reference
metadata. Do not write this item to the parent session. Do not add full child
transcript rows to the parent result.

Expose snapshot diagnostics in:

- `SubAgentResult.context_diagnostics`
- `SubAgentRunSummary.context_diagnostics`
- `Task` tool raw payload/artifacts
- provider-free `evaluation/subagent_smoke.py`

## Test Strategy

- Unit test child loop message order includes inherited fork context between
  profile system prompt and child user task.
- Unit test service builds bounded context snapshot from parent baseline and
  records only child transcript rows.
- Unit test diagnostics include counts/hashes/truncation but not raw parent
  content.
- Existing tool-scope tests continue to prove child tool scope is not broader
  than parent.
- Provider-free smoke asserts fork context diagnostics and bounded tool scope.

## Non-Goals

- No remote agent, ACP, swarm/team productization, or forked provider cache
  controls.
- No raw parent transcript cloning.
- No Hermes-agent code copying.
