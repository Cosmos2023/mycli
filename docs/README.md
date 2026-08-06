# mycli Documentation Index

This directory is split by document purpose.

## Current Architecture

- [architecture.md](./architecture.md): Node workspace and runtime ownership boundaries.
- [commands.md](./commands.md): canonical 36-command slash registry, aliases, and availability.
- [node-runtime-rollout.md](./node-runtime-rollout.md): M8 Node-only release gates and package rollback.
- [troubleshooting.md](./troubleshooting.md): provider-free diagnosis and common recovery paths.
- [node-extensions.md](./node-extensions.md): extension discovery, configuration, approvals, management, and doctor.
- [plugin-api-v2.md](./plugin-api-v2.md): process-isolated compiled ESM plugin author contract.
- [migration/python-plugins-to-v2.md](./migration/python-plugins-to-v2.md): legacy plugin migration to compiled ESM Plugin API v2.
- [parity/node-runtime-m8-capability-audit.md](./parity/node-runtime-m8-capability-audit.md): final retained-capability audit and frozen corpus.

## Context And Prefix Cache

Use these documents for the active context assembly and provider cache work:

- [context/mycli-context-assembly-reference.md](./context/mycli-context-assembly-reference.md): semantic contract for canonical timeline, persistence, compact, rehydration, and provider projection.
- [context/prefix-cache-request-shape-design.md](./context/prefix-cache-request-shape-design.md): provider-visible ordering, cache boundary, request shape hashing, and diagnostics contract.
- [context/context-assembly-after-p5-p8-reference.md](./context/context-assembly-after-p5-p8-reference.md): concrete examples of stored context and provider payloads after P5-P8.
- [context/prefix-cache-context-assembly-roadmap.md](./context/prefix-cache-context-assembly-roadmap.md): phase roadmap for prefix-cache context assembly.
- [context/prefix-cache-context-assembly-goals.md](./context/prefix-cache-context-assembly-goals.md): archived `/goal` texts for P5-P8 execution.

## Parity And Gap Reports

These documents are reference material for comparing mycli with Hermes/Codex-style agent maturity:

- [parity/codex-alignment-roadmap.md](./parity/codex-alignment-roadmap.md): roadmap for moving mycli's core runtime architecture toward Codex-style execution, timeline, tool runtime, and policy boundaries.
- [parity/codex-alignment-phases-p9-p13.md](./parity/codex-alignment-phases-p9-p13.md): executable P9-P13 phase plan for Codex-style runtime alignment, with compact rehydration explicitly out of scope.
- [parity/hermes-agent-gap-analysis.md](./parity/hermes-agent-gap-analysis.md): broader Hermes-agent gap analysis.
- [parity/hermes-parity-roadmap.md](./parity/hermes-parity-roadmap.md): completed Hermes-like foundation roadmap.
- [parity/hermes-foundation-final-report.md](./parity/hermes-foundation-final-report.md): final report for the Hermes-like foundation slice.
- [parity/tools-parity-report.md](./parity/tools-parity-report.md): local tool foundation and contributed tool parity report.
- [parity/pi-tui-mycli-upgrade-plan.md](./parity/pi-tui-mycli-upgrade-plan.md): Trellis-style plan for upgrading mycli's Node TUI by adapting pi-tui primitives and pi-agent interaction components.
- [parity/pi-agent-tui-lessons.md](./parity/pi-agent-tui-lessons.md): lessons from pi-agent's TUI architecture and component split.
- [parity/tui-development-roadmap.md](./parity/tui-development-roadmap.md): implementation batches for the current TUI roadmap.
- [parity/tui-experience-blueprint.md](./parity/tui-experience-blueprint.md): product blueprint for the local coding-agent TUI experience.

## Historical Superpowers Docs

- [superpowers/](./superpowers/): older plans, reports, and specs. Treat this as historical reference unless a task explicitly targets it.
