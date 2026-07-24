# Responses Role Classification And Append-Only Context Design

## Goal

Make the canonical model-visible timeline preserve message authority and remain append-only, so protocol projectors can reliably produce Chat Completions, Anthropic Messages, and OpenAI Responses payloads without reconstructing or silently replacing prior context.

## Principles

1. Role expresses authority; cache class and scope express lifetime.
2. Every model-visible item is either persisted in canonical history or explicitly resets continuation.
3. Protocol projectors may translate representation, but must not change semantic role or remove prior model-visible items.
4. UI-only and runtime-only records remain outside model context.
5. OpenAI Responses always builds a complete logical input before any WebSocket delta optimization.

## Role Classification

### Top-Level Instructions

The stable mycli identity, personality, and invariant operating rules use the Responses top-level `instructions` field. These instructions remain stable within a model context window. A model-specific instruction change is represented by an appended developer update instead of rewriting established input history.

### Developer Items

- Collaboration mode and mode transitions.
- Permission, sandbox, approval, and execution-policy constraints.
- Skill catalog and the rules for discovering or invoking skills.
- Tool-use policy and model-visible tool-exposure updates.
- Runtime policy reminders that direct agent behavior.
- Trusted policy-hook output.
- Model, personality, and multi-agent mode updates.
- Internal interruption markers such as `<turn_aborted>`.

Developer updates are persistent model-visible timeline items. A changed value appends a superseding update; it does not replace an earlier item.

### User Context Items

- Actual user and steering-queue messages.
- Workspace instructions such as `AGENTS.md` content.
- Environment facts such as cwd, shell, time, repository state, and selected environment.
- Conversation summaries and retrieved memory.
- Current plan state.
- Loaded skill bodies.
- Compaction rehydration and file snapshots.
- Runtime factual reminders.
- Untrusted or ordinary `user_prompt_submit` hook context.

These items are distinguished from actual user requests through structured metadata and wrapper tags, while retaining the `user` role.

### Native Provider Items

- Assistant text uses `assistant` messages.
- Reasoning uses native Responses reasoning items and provider replay state.
- Tool requests use native `function_call` items.
- Tool results use native `function_call_output` items.

### Non-Model Records

Approval UI state, warnings, capability lifecycle, contributed-tool lifecycle, slash-command results, file-change display records, plan-update display records, compaction status, request IDs, logs, and cache diagnostics remain API-only or UI-only. They are not projected into model input unless a separate explicitly model-visible item is created.

## Canonical Timeline Changes

The canonical conversation role type must support `developer`. Persisted context-update records must carry their role instead of being restored unconditionally as `user`.

Runtime reminders are split by semantic authority:

- `runtime_policy_reminder`: developer role.
- `runtime_context_reminder`: user role.

Existing reminder producers choose a category explicitly. Unknown reminders default to user context so an untrusted source cannot elevate itself to developer authority.

Hook context follows the same rule: user by default, developer only for a trusted policy contributor identified by runtime-owned metadata.

## Append-Only Behavior

Initial context appends one developer bundle followed by contextual user items. Later turns compare the current runtime snapshot with the last durable snapshot and append only changed sections as role-preserving updates.

The logical sequence is:

```text
instructions
developer initial context
user initial context
user request
assistant output
tool calls and results
developer/user context updates
next user request
```

No previously sent dynamic or ephemeral item is silently removed. A genuinely non-replayable sensitive item invalidates continuation and starts a new full-input boundary.

## Protocol Projection

- Chat Completions maps canonical roles to `messages[]` and tool records to assistant/tool messages.
- Anthropic maps developer/system policy to its supported system representation and maps the remaining timeline to content blocks.
- Responses maps stable base instructions to `instructions`, canonical messages to input message items, and provider-native records to native Response items.

Transport optimization happens after projection. WebSocket continuation may send `previous_response_id` plus a strict delta only when non-input request properties match and the new logical input extends the prior input. HTTP fallback sends the complete projected history.

## Compatibility

Existing sessions without persisted role metadata infer roles conservatively:

- Context baseline updates default to `user`.
- Skill instructions remain `user`.
- Legacy `<turn_aborted>` markers are upgraded to `developer` during projection.
- Existing assistant and tool records retain their current behavior.

The TUI projection continues hiding internal interruption markers and provider-only context updates. Role migration must not make hidden runtime records visible in the transcript.

## Verification

Focused tests cover:

1. Every current context section maps to the intended role.
2. Developer updates survive persistence and resume with their role intact.
3. Runtime reminders and hooks cannot accidentally elevate untrusted content.
4. Interrupted turns replay a developer marker while remaining hidden in the TUI.
5. Two consecutive Responses requests form a strict logical extension when context is unchanged.
6. Changed environment and policy context appends user and developer updates respectively.
7. Chat Completions and Anthropic projections retain existing tool and history behavior.
8. API-only history items never enter model payloads.
