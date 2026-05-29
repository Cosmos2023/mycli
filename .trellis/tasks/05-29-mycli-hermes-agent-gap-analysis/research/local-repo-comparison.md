# Local Repo Comparison: mycli vs hermes-agent

## Scope

Compare `/Users/cosmos/Desktop/mycli` with `/Users/cosmos/Desktop/开源agent/hermes-agent` from an agent engineering perspective.

## Repository Scale

- `mycli`: roughly 1,074 files under `src/mycli`, `tests`, `docs`, `scripts`, and `tui`; 238 Python source files under `src/mycli`; 119 Python test files.
- `hermes-agent`: roughly 2,767 files under primary product directories; 1,697 Python files across runtime/CLI/tools/gateway/tests; 1,306 Python test files.
- Hermes has a large product surface: `agent`, `hermes_cli`, `tools`, `skills`, `providers`, `gateway`, `acp_adapter`, `tui_gateway`, `web`, `website`.
- mycli has a cleaner layered `src/` layout, but a smaller operational and ecosystem surface.

## Strong Areas in mycli

- Clear internal runtime boundary: provider wire formats are converted into internal `ModelEvent` / `RuntimeItem` / `RuntimeBlock` concepts.
- Strict Python 3.13 project setup with `ruff`, `mypy strict`, and 966 passing tests after the latest merge.
- Good beginnings of runtime engineering: suspended turns, pending decisions, trace service, request-shape builder, compaction, tool result reinjection, and sub-agent service.
- Safer core architecture than Hermes in some areas: smaller modules, stronger typing, less global state, clearer separation between domain/application/infrastructure.

## Hermes Engineering Capabilities mycli Lacks or Only Partially Has

### Product Surfaces

- Hermes supports CLI, gateway messaging platforms, web/dashboard, ACP adapter, MCP serving, cron, and migration flows.
- mycli currently has CLI and Node TUI gateway, with no mature messaging gateway, dashboard, cron, ACP compatibility, or packaged migration story.

### Setup, Operations, and Distribution

- Hermes includes installer scripts, setup wizard, doctor commands, update flow, platform-specific installation guidance, Docker/Nix/Termux/Windows support, and extensive release notes.
- mycli has `uv run mycli` and config docs, but lacks a production-grade installer, doctor, update, packaging matrix, and platform support policy.

### Tool Ecosystem

- Hermes has broad tool/plugin surfaces, toolsets, lazy dependencies, MCP/ACP integration, terminal backends, browser/media/search/TTS/image providers, and tool gateway concepts.
- mycli has solid local coding tools and an early MCP contribution path, but not yet a mature toolset marketplace, install/config UX, lazy dependency manager, or multi-backend execution environments.

### Agent Safety and Resilience

- Hermes has tool loop guardrails, checkpointing before mutating actions, plugin pre-tool blocks, destructive command checks, deterministic test isolation, and supply-chain scanners.
- mycli has risk decisions and shell safety, but lacks mature checkpoint/rollback integration, loop guardrail taxonomy, plugin guardrails, and repo-level supply-chain CI.

### Memory and Skills

- Hermes has a larger learning loop: memory provider abstraction, context fencing/scrubbing, skill slash-command system, skill config injection, platform-aware skill discovery, and self-improvement claims.
- mycli has preferences/project memory/short-term memory and basic skill registry, but lacks full skill lifecycle management, skill creation/improvement, skill marketplace compatibility, platform-aware skills, and strong prompt-injection fencing around recalled memory.

### Subagents and Delegation

- Hermes emphasizes isolated subagents and RPC/scripted tool pipelines.
- mycli has a real sub-agent service and Task tool, including background runs, but lacks the surrounding UX/ecosystem: richer agent profiles, durable orchestration views, team/task state, worker isolation backends, and script/RPC interfaces.

### Provider and Model Management

- Hermes has broad provider routing, model selection UX, model catalogs, usage/pricing, rate-limit guards, failover/error classification, and provider-specific extras.
- mycli supports OpenAI/Qwen/DeepSeek/Anthropic with good protocol abstraction, but lacks model catalog UX, provider credential setup, rate-limit/account usage UX, and broad provider matrix.

### CI and Supply Chain

- Hermes has GitHub workflows for tests, lint, docs site checks, Docker, Nix, lockfile freshness, OSV scanning, supply-chain audits, dependency rules, pinned GitHub Actions, and exact-pinned core dependencies.
- mycli has local `pytest`, `ruff`, and `mypy`, but no visible `.github` CI in the active repo and uses version ranges for runtime dependencies.

## Recommended Priority Order

1. Stabilize foundations: remove stale/untracked migration shards, finish module moves, keep `pytest`, `ruff`, and strict `mypy` green.
2. Add product operations: `mycli doctor`, `mycli setup`, config validation, provider/model picker, structured diagnostics.
3. Harden runtime safety: checkpoint/rollback for mutating tools, loop guardrails, permission policy profiles, supply-chain CI.
4. Build real extensibility: toolset manager, MCP lifecycle UX, skill lifecycle management, lazy dependency strategy.
5. Expand deployment surfaces: Node TUI maturity, gateway/messaging surface, web dashboard only after runtime/ops are solid.
6. Add learning loop: memory provider abstraction, session search, skill creation/refinement, profile/context fencing.

## Key Constraint

Do not copy Hermes architecture wholesale. Hermes is powerful but contains large legacy/global modules (`run_agent.py`, `cli.py`, extracted compatibility wrappers). mycli's advantage is a cleaner layered architecture; the right path is to import product/engineering capabilities, not the shape of the codebase.
