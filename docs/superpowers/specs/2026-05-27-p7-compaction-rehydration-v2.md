# P7 Compaction Rehydration V2

## 1. Background

P4/P5 brought the runtime close to a usable agent loop, and the current L4 path can already summarize old conversation history and restore a small set of recent file snapshots. That implementation is intentionally narrow, but it has started to show architectural pressure:

- L4 file snapshots are carried through `runtime_reminders`, even though they are not ordinary reminders.
- Successful `Skill` tool calls enter conversation history as tool results, so L4 compaction can summarize away the detailed skill body that should continue to guide the current task.
- File rehydration is based on `last_cost_metrics["recent_files"]` only. It does not use a first-class read/write recency model, tail-message deduplication, or per-channel token budgets.
- Plan state should remain independent runtime state after compaction, but that guarantee is not explicit enough in tests.

Claude Code's public behavior and documentation point to a better shape: stable skill metadata, invoked skill bodies restored after compaction, file snapshots restored through a dedicated compaction channel, and separate budgets per restoration type. P7 adopts that shape without copying Claude Code's full hook system or UI.

## 2. Goals

### 2.1 Dedicated compaction rehydration context

Introduce a first-class context channel:

```text
compaction_rehydration
```

This channel replaces the current practice of carrying L4 file snapshots inside `runtime_reminders`.

The first implementation slice supports:

```text
compaction_rehydration.files
compaction_rehydration.invoked_skills
```

It also adds tests that prove plan state remains independently injected after compaction.

### 2.2 File rehydration v2

File rehydration should restore recent relevant file snapshots with deterministic filtering, ordering, and budgeting.

Candidate sources:

- `LLMSummarization.last_cost_metrics["recent_files"]`
- file/tool history from recent `Read`, `read_file`, `read_file_range`, `Edit`, `Write`, `edit_file`, and `write_file` results
- edited files before read-only files when recency is otherwise comparable

Filtering:

- Reject absolute or relative paths outside the workspace.
- Skip missing, non-file, or unreadable paths.
- Skip files owned by dedicated state channels, such as plan or memory files.
- Skip files whose complete content is already present in the post-compaction tail replay.
- Deduplicate by resolved workspace-relative path.

Ordering:

- Prefer most recently accessed files.
- Prefer edited/written files over read-only files when both are recent.
- Keep output order stable for equal priority candidates.

Budgeting:

- Use a dedicated file rehydration budget.
- Apply a per-file token cap.
- Apply a total file-token cap.
- Head-truncate oversized file content and mark it with `[truncated]`.
- Stop adding more files when the total budget is exhausted.

Rendered form:

````text
[Compaction file rehydration]
Recent file snapshots are current disk content. Re-read files if exact content matters.

### src/example.py
```text
...
```
````

### 2.3 Invoked skill rehydration

Track skills successfully loaded through the `Skill` tool and restore their bodies after L4 compaction when they remain relevant to the current session.

Tracked fields:

```text
skill_name
description
source_path
body
invoked_at
last_turn_id
```

Rules:

- Only restore skill bodies that were actually invoked in the current session.
- Do not restore every available skill.
- Sort by most recent invocation.
- Apply a per-skill token cap.
- Apply a total invoked-skill token cap independent from file rehydration.
- Head-truncate oversized skill bodies and mark them with `[truncated]`.
- Do not store or restore missing skill bodies silently; skip invalid records and log a bounded diagnostic.

Rendered form:

````text
[Invoked skills after compaction]
Continue to follow these skill instructions.

## superpowers:executing-plans
...
````

### 2.4 Skill catalog remains stable metadata

The skill catalog is not part of L4 rehydration.

The catalog contains only available skill names and descriptions. It tells the model which skills can be loaded through the `Skill` tool. It must not contain full skill bodies, and it must not be mixed into file rehydration.

Target shape:

```text
stable skill catalog       -> name + description
invoked skill rehydration  -> bodies for skills already invoked in this session
file rehydration           -> current disk snapshots for recent files
```

### 2.5 Plan state remains independent

Plan state must not rely on conversation history surviving L4.

P7 should verify that after L4 compaction:

- current plan items still appear through the plan context section
- plan context does not consume file rehydration budget
- plan context does not consume invoked-skill budget
- plan content is not duplicated inside file or skill rehydration sections

If the current plan path already satisfies this, P7 should add focused regression tests rather than redesigning planning.

### 2.6 Provider request ordering

Compaction rehydration is contextual material, not the user's latest request.

For Chat Completions / transcript-only messages, request ordering should keep rehydration before the current user request:

```text
system
stable contextual sections
compaction_rehydration
replay / compacted replay
current user request
```

For Responses API, rehydration may continue to use provider-supported contextual or delta input, but it must preserve its own fragment kind and not be flattened into generic reminders.

## 3. Non-goals

P7 does not:

- implement Claude Code's full hook system
- add `SessionStart[compact]` hooks
- add or redesign `/compact` UI
- rewrite the L4 summarizer prompt
- change provider protocol selection
- restore all historical tool results
- restore inactive or never-invoked skill bodies
- place skill catalog inside L4 file rehydration
- change the TUI transcript model

## 4. Architecture

### 4.1 New rehydration service

Add a dedicated service module:

```text
src/mycli/services/context/compaction/rehydration.py
```

Responsibilities:

- collect file rehydration candidates
- filter and sort candidates
- apply token budgets
- render file rehydration blocks
- render invoked skill rehydration blocks
- return typed rehydration context data, not pre-flattened reminder strings

Suggested data types:

```python
@dataclass(frozen=True)
class RehydrationBudget:
    max_total_tokens: int
    max_item_tokens: int
```

```python
@dataclass(frozen=True)
class RehydratedFile:
    path: str
    content: str
    token_count: int
    truncated: bool
```

```python
@dataclass(frozen=True)
class RehydratedSkill:
    name: str
    description: str
    source_path: str | None
    body: str
    token_count: int
    truncated: bool
```

```python
@dataclass(frozen=True)
class CompactionRehydrationContext:
    files: tuple[RehydratedFile, ...] = ()
    invoked_skills: tuple[RehydratedSkill, ...] = ()
```

### 4.2 Invoked skill tracking

When `SkillTool` succeeds, runtime should record an invoked skill snapshot.

Suggested shape:

```python
@dataclass(frozen=True)
class InvokedSkillSnapshot:
    name: str
    description: str
    source_path: str | None
    body: str
    invoked_at: datetime
    last_turn_id: str
```

The first implementation should prefer the smallest persistence surface that survives session resume. A session runtime snapshot field is acceptable if it fits the existing session model.

### 4.3 Runtime integration

The turn flow should become:

```text
TurnExecutor
  -> L4 compaction applies
  -> AgentRuntime builds CompactionRehydrationContext
  -> RuntimeContextBuilder receives compaction_rehydration
  -> TurnContextAssembler emits a dedicated section
  -> InstructionContractAssembler emits a dedicated fragment kind
  -> RequestShapeBuilder places the fragment before current user request
```

`runtime_reminders` remains available for genuinely transient runtime warnings if needed, but it must no longer be the carrier for L4 file snapshots or invoked skill restoration.

### 4.4 Request fragments

Add a dedicated instruction/request kind rather than overloading existing ones:

```text
compaction_rehydration
```

The rendered content should be model-visible for both supported protocols.

It must not be included in durable memory.

## 5. Configuration

Add conservative defaults to `AgentConfig`:

```text
compaction_rehydration_file_max_total_tokens
compaction_rehydration_file_max_item_tokens
compaction_rehydration_skill_max_total_tokens
compaction_rehydration_skill_max_item_tokens
compaction_rehydration_max_files
compaction_rehydration_max_skills
```

Initial defaults should be smaller than Claude Code's published budgets unless existing benchmarks justify larger values. DeepSeek 1M windows can use larger values later through config.

## 6. Acceptance Criteria

- L4 file snapshots are no longer rendered through `runtime_reminders`.
- A dedicated `compaction_rehydration` section/fragment exists.
- Chat Completions request ordering keeps compaction rehydration before the current user request.
- Responses request shape keeps compaction rehydration model-visible with its own fragment kind.
- Successful `Skill` tool calls are recorded as invoked skill snapshots.
- After L4 compaction, invoked skill bodies are restored from the invoked skill channel.
- Never-invoked skills are not restored.
- Skill catalog remains metadata-only and does not contain invoked skill bodies.
- File rehydration rejects workspace-escaping paths.
- File rehydration skips tail replay duplicates.
- File rehydration orders by recent access with edited files favored.
- File and skill rehydration use independent token budgets.
- Plan context remains available after L4 and does not consume file or skill rehydration budgets.

## 7. Testing

Unit coverage:

- `CompactionRehydrationService` builds file blocks from recent candidates.
- File candidates outside workspace are rejected.
- Missing/unreadable files are skipped.
- Duplicate resolved paths collapse to one item.
- Tail replay duplicate files are skipped.
- Edited files sort before read-only files when equally recent.
- Per-file and total file budgets truncate or stop output deterministically.
- Invoked skill snapshots render after L4.
- Never-invoked skills do not render.
- Per-skill and total skill budgets truncate deterministically.

Application/runtime coverage:

- `Skill` tool success records an invoked skill snapshot.
- L4 compaction triggers `compaction_rehydration` construction.
- Plan state remains present after L4 compaction.
- `runtime_reminders` no longer contains `[Compaction rehydration]` file snapshots.

Request-shape coverage:

- Chat Completions ordering is `system -> contextual/rehydration -> replay -> current user`.
- Responses payload includes `compaction_rehydration`.
- `compaction_rehydration` is not included in memory fragments.

Regression smoke:

- Start a session, read/edit a file, invoke a skill, force L4, then ask a follow-up.
- Verify the model-visible request contains the invoked skill body and file snapshot once.
- Verify the final answer does not respond to the rehydration block as if it were the user request.

## 8. Migration Notes

The existing `[Compaction rehydration]` string can remain temporarily as an internal marker during migration, but it should not be exposed through `runtime_reminders` after P7 is complete.

Tests that currently assert file snapshots appear under `runtime_reminders` should be updated to assert the new `compaction_rehydration` fragment.

Existing sessions without invoked skill snapshots should still resume normally. They simply will not receive invoked skill body restoration until a skill is invoked again.

## 9. Risks

- Storing full invoked skill bodies in session state increases persistence size. P7 should cap body size or store only enough to restore bounded context.
- Restoring too much skill body can reduce cache effectiveness. Independent budgets and stable ordering are required.
- Rehydrated file snapshots can become stale if files change after candidate collection. The service must read current disk content at rehydration time and tell the model to re-read if exact content matters.
- Provider ordering differs between Chat Completions and Responses. Tests must cover both paths.
