# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

This directory contains guidelines for backend development. Fill in each file with your project's specific conventions.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | Active |
| [Database Guidelines](./database-guidelines.md) | SQLite query, migration, and session-storage contracts | Active |
| [Error Handling](./error-handling.md) | Error taxonomy, boundary mapping, retry, terminalization, and UI projection | Active |
| [Diagnostics And Cached Updates](./diagnostics-update-contract.md) | Provider-free doctor, update cache, lifecycle, gateway, and TUI notice contract | Active |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, test gates, and cross-surface drift contracts | Active |
| [Logging Guidelines](./logging-guidelines.md) | Structured logging, log levels | Active |
| [Runtime TUI Gateway Contract](./runtime-tui-gateway-contract.md) | Runtime-to-Node-TUI event payloads and reducer contract | Active |
| [Shared Gateway API Contract](./gateway-api-contract.md) | Typed RPC, shared client, stdio app-server, and backend dependency boundaries | Active |
| [Runtime Composition Contract](./runtime-composition-contract.md) | Turn orchestration, tool batches, runtime registries, projections, and shutdown ownership | Active |
| [Run Execution Snapshot Contract](./run-execution-snapshot-contract.md) | Per-run policy, mode, tool-catalog, continuation, compaction, and child-inheritance boundaries | Active |
| [Context Management Contract](./context-management-contract.md) | Project context files, cache classes, fencing, and context diagnostics | Active |
| [System Prompt Contract](./system-prompt-contract.md) | Prompt lifecycle, communication, skills, permission context, and behavior evaluation | Active |
| [Headless Workflow Contract](./headless-workflow-contract.md) | Noninteractive exec, Git review, local output validation, and fixed coding evaluations | Active |
| [Configuration Trust Contract](./configuration-trust-contract.md) | Config precedence, provenance, project trust gating, and resume workspace ownership | Active |
| [Tool Manifest Contract](./tool-manifest-contract.md) | Built-in local tool registry and manifest metadata | Active |
| [Shell Execution Policy Contract](./shell-execution-policy-contract.md) | Sandbox-first Shell classification, approval, escalation, and recovery | Active |
| [Permission Grant Contract](./permission-grant-contract.md) | Runtime-owned permission grants, managed upper bounds, and domain enforcement | Active |
| [Network Proxy Contract](./network-proxy-contract.md) | Process-owned HTTP/CONNECT proxy, pinned destinations, platform enforcement, and cleanup | Active |
| [Plugin Runtime Contract](./plugin-runtime-contract.md) | Minimal local plugin manifest, loading, hook/tool registration, and diagnostics | Active |
| [MCP Runtime Contract](./mcp-runtime-contract.md) | MCP connection/discovery lifecycle, shared extension catalogs, and cross-turn exposure | Active |
| [MCP Interaction Contract](./mcp-interaction-contract.md) | OAuth ownership, live elicitation, typed TUI forms and native discovery replay | Active |
| [Read-only Tool Output Contract](./read-only-tool-output-contract.md) | Model-visible LS/Glob/Grep/Read discovery output | Active |
| [File Mutation Tool Contract](./file-mutation-tool-contract.md) | Write/Edit/Patch safety, diffs, and diagnostics | Active |
| [Provider Tool Replay Contract](./provider-tool-replay-contract.md) | Bounded tool persistence, terminal call closure, replay repair, and safe provider diagnostics | Active |
| [Provider Transport Contract](./provider-transport-contract.md) | Pi-ai routing, authority, retry ownership, errors, replay, and hosted-search compatibility | Active |
| [Multimodal Input Contract](./multimodal-input-contract.md) | Bounded local-image loading, persistence, capability checks, and provider projection | Active |
| [Coordinated npm Release Contract](./release-contract.md) | Coordinated versions, package order, artifact gates, publishing, and recovery | Active |

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

**Language**: All documentation should be written in **English**.
