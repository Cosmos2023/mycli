# Runtime v3 Dual Ledger Mainline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split model-visible provider replay from runtime/UI events so DeepSeek multi-turn requests stop inheriting volatile runtime text.

**Architecture:** `HistoryItem` becomes the provider transcript ledger written from model-visible turn items only. `TurnRecord`, `TurnRollout`, trace, and workspace logs remain the runtime event ledger for UI, diagnostics, tool exposure, approval, warnings, policy, and lifecycle events. Tool schema remains the only model-visible tool surface; no direct/deferred/dynamic wording is sent as conversation text.

**Tech Stack:** Python 3.13, pytest, mycli runtime/session services.

---

### Task 1: Lock Provider Transcript Boundary

**Files:**
- Modify: `tests/unit/application/test_agent_runtime.py`
- Modify: `tests/unit/services/test_context_manager_v2.py`

- [x] **Step 1: Write failing runtime boundary tests**

Add tests proving runtime-only turn items never become `HistoryItem` provider replay, and visible DeepSeek thinking text is not replayed as assistant content.

- [x] **Step 2: Run focused tests and verify they fail**

Run: `uv run pytest tests/unit/application/test_agent_runtime.py -k "provider_transcript or reasoning" -q`

Expected: FAIL before the ledger split because runtime events are still mapped into history.

### Task 2: Make HistoryItem the Provider Transcript Ledger

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/services/context/context_manager.py`

- [x] **Step 1: Replace all-turn-item history mapping**

Change `_history_items_from_turn()` into provider-transcript-only mapping:

- keep `USER_MESSAGE`
- keep `ASSISTANT_MESSAGE`
- keep `TOOL_CALL`
- keep `TOOL_RESULT`
- drop `REASONING`, `CAPABILITY`, `TOOL_EXPOSURE`, `WARNING`, approval items, lifecycle items, baseline items, and file-change pseudo-items

- [x] **Step 2: Keep legacy session reads safe**

Ensure `ContextManager.messages_from_history()` ignores non-provider legacy history items and does not replay visible `Thinking:` / `Planning:` text as assistant transcript.

- [x] **Step 3: Run focused tests and verify they pass**

Run: `uv run pytest tests/unit/application/test_agent_runtime.py tests/unit/services/test_context_manager_v2.py -k "provider_transcript or reasoning or history" -q`

Expected: PASS.

### Task 3: Preserve Runtime Event Ledger

**Files:**
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `tests/unit/application/test_agent_runtime.py`
- Modify: `tests/unit/services/test_session_service.py`

- [x] **Step 1: Verify UI/runtime events still persist in turn record and rollout**

Runtime events must still be visible through `response.turn.items`, trace, and rollout events.

- [x] **Step 2: Remove context baseline and file-change writes from provider history**

Context baseline remains in dedicated session state. File changes remain on `TurnItem` metadata / rollout, not model replay history.

### Task 4: Full Verification

**Files:**
- All touched files.

- [x] **Step 1: Run full tests**

Run: `uv run pytest -q`

- [x] **Step 2: Run typecheck and lint**

Run: `uv run mypy`

Run: `uv run ruff check`

- [x] **Step 3: Report cache-impact evidence honestly**

Report the boundary guarantees and any remaining live DeepSeek cache-hit measurement gaps.
