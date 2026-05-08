# Phase 4: Differentiation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** 3-tier memory, injection prevention, conversation forking, cost-aware compaction, observability.

**Prerequisite:** Phase 1 + hooks system (Phase 2 task 1) + session resume (Phase 3 task 4)

**Tasks (5):**

### Task 4.1: Memory System Upgrade
- Modify: `src/mycli/services/memory/service.py`
- Replace substring search with 3-tier: Transient/SQLite/long-term project/session memory
- SQLite-compatible lexical retrieval + dedup against conversation/memory records
- Async encoding via threading; see plan Section 4.1

Status: implemented with standard-library/SQLite-compatible retrieval. ChromaDB and sentence-transformers are intentionally not retained.

### Task 4.2: Injection Prevention
- Create: `src/mycli/services/security/injection_guard.py`
- Wrap low-trust content in `<tool_output><![CDATA[...]]></tool_output>`
- PrivacyFilter: redact API keys, tokens, emails
- Integrate as PostToolUse hook

Status: implemented with guarded tool transcript content, privacy filtering, and PostToolUse integration.

### Task 4.3: Conversation Forking
- Create: `src/mycli/services/conversation_tree.py`
- Conversation from flat list → tree with `parent_id`
- SQLite: `conversation_trees` table
- Fork/rewind operations

Status: implemented with conversation tree metadata persisted in a dedicated `conversation_trees` SQLite table.

### Task 4.4: Cost-Aware Compaction
- Modify: `src/mycli/services/context/compaction/pipeline.py`
- Calculate summary cost vs carry cost before L4 trigger
- Make trigger_ratio configurable per model in AgentConfig

Status: implemented with cost profile and model-specific trigger support.

### Task 4.5: Observability
- Extend metrics: cache_hit_rate, compaction_ratio, budget_curve
- Add `structlog` structured logging
- Alert rules: cache hit drop, consecutive L4, PTL rate
- `/stats` CLI command

Status: implemented with `structlog` structured logging and JSON log formatting support.
