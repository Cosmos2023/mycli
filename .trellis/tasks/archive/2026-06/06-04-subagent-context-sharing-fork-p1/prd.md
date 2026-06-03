# Subagent Context Sharing / Fork P1

## Objective

Implement roadmap slice 3 from `docs/hermes-parity-roadmap.md`: local subagents
must be able to inherit a bounded, stable parent context snapshot while keeping
child transcript/trace independent and returning only summary/evidence to the
parent.

## Background

The current Subagent P0 implementation provides configured profiles, manifest
exposure, tool scope narrowing, child transcripts, and provider-free smoke. It
does not yet make child runs context-aware. Child prompts currently include only
the profile system prompt and task description.

## Requirements

1. Fork Context Snapshot
   - Build a lightweight parent context snapshot for each subagent invocation.
   - Include stable `ContextBaseline` fragments when available.
   - Include bounded memory/session-summary style reference text when available.
   - Include selected child tool exposure after parent/profile/policy narrowing.
   - Bound counts, chars, and fragment totals deterministically.

2. Child Prompt Integration
   - Insert inherited fork context into child messages as reference/system data.
   - Place it after the profile system prompt and before the child task.
   - Mark it clearly as inherited reference context, not current user input.
   - Do not copy the entire parent transcript into child messages.

3. Transcript and Parent Isolation
   - Child transcript/trace remains under child session id.
   - Parent receives only the normal subagent report summary/evidence.
   - Parent-visible Task result must not include the full child transcript.
   - Transcript inspection may show bounded inherited-context diagnostics.

4. Tool Scope Safety
   - Child tool/permission scope must remain no broader than parent scope.
   - Existing parent/profile/policy denylist behavior must continue to apply.
   - Fork context diagnostics should report selected tool names/counts.

5. Diagnostics
   - Add bounded context fork diagnostics to subagent result payloads.
   - Diagnostics may include counts, hashes, lengths, selected tool names, and
     truncation flags.
   - Diagnostics must not include raw parent transcript, raw memory, raw user
     requests, headers, or secrets.

6. Roadmap and Trellis
   - Update `docs/hermes-parity-roadmap.md` after completion.
   - Archive this Trellis task when tests pass.
   - Commit to `feature/mycli-context-management-p1` only.

## Acceptance Criteria

- A subagent run with a parent context baseline receives inherited reference
  context in its child prompt.
- The inherited context is bounded and diagnostic metadata reports whether it
  was truncated.
- Child transcript is independent from parent session history.
- Parent Task result contains subagent summary/evidence and fork diagnostics,
  but not full child transcript rows.
- Child tool scope remains a subset of parent tools and configured profile
  tools.
- Unit tests cover prompt integration, diagnostics redaction, transcript
  isolation, and tool scope.
- `uv run python evaluation/subagent_smoke.py` verifies provider-free fork
  context diagnostics.

## Out of Scope

- Remote agents, ACP, browser/computer-use, cron, packaging, enterprise policy.
- Full multi-agent/swarm orchestration.
- Provider-specific prompt-cache controls for child agents.
- Copying Hermes-agent source code.
