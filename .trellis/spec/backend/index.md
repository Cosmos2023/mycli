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
| [Database Guidelines](./database-guidelines.md) | ORM patterns, queries, migrations | To fill |
| [Error Handling](./error-handling.md) | Error types, handling strategies | To fill |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | To fill |
| [Logging Guidelines](./logging-guidelines.md) | Structured logging, log levels | Active |
| [Runtime TUI Gateway Contract](./runtime-tui-gateway-contract.md) | Runtime-to-Node-TUI event payloads and reducer contract | Active |
| [Context Management Contract](./context-management-contract.md) | Project context files, cache classes, fencing, and context diagnostics | Active |
| [Tool Manifest Contract](./tool-manifest-contract.md) | Built-in local tool registry and manifest metadata | Active |
| [Plugin Runtime Contract](./plugin-runtime-contract.md) | Minimal local plugin manifest, loading, hook/tool registration, and diagnostics | Active |
| [Read-only Tool Output Contract](./read-only-tool-output-contract.md) | Model-visible LS/Glob/Grep/Read discovery output | Active |
| [File Mutation Tool Contract](./file-mutation-tool-contract.md) | Write/Edit/Patch safety, diffs, and diagnostics | Active |
| [Provider Tool Replay Contract](./provider-tool-replay-contract.md) | Bounded tool persistence, terminal call closure, replay repair, and safe provider diagnostics | Active |
| [Multimodal Input Contract](./multimodal-input-contract.md) | Bounded local-image loading, persistence, capability checks, and provider projection | Active |

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
