# Hermes-like Core Tools Foundation Hardening

## Goal

Strengthen mycli local tools toward Hermes-like practical reliability. The slice focuses on the core local tool loop that determines whether real tasks complete reliably: read/search/shell/edit/write result quality, model-visible evidence, safety guidance, and diagnostics.

## Problem

The `Read` tool can successfully read CSV/TSV files but fail to provide model-visible data because CSV handlers return structured raw payload fields instead of `content` or `file_excerpt` evidence. This causes real tasks to repeat reads, fall back to rejected `cat/head/tail` shell commands, and sometimes hit `loop_detected`.

## Scope

1. `Read` exposes model-visible evidence for text and structured local data.
2. CSV/TSV `Read` output includes row-numbered tabular content and honors `offset`/`limit`.
3. Repeated unchanged `Read` calls for the same path/range return a clear duplicate-read hint instead of re-sending or hiding content ambiguously.
4. Shell reroute failures for `cat`, `head`, `tail`, `ls`, `grep`, `rg`, and `find` include actionable dedicated-tool arguments.
5. Tool result formatting keeps four surfaces distinct:
   - model-visible transcript content
   - compact TUI summary
   - raw payload for diagnostics
   - trace payload with bounded metadata
6. Existing `Edit`/`Write` snapshot and diagnostics behavior must not regress.

## Non-Goals

- Do not copy Hermes code.
- Do not add external dependencies.
- Do not implement new broad tool categories such as browser, computer-use, vision, MCP productization, skills, subagents, or ACP in this slice.
- Do not replace the whole runtime tool execution service unless tests prove the current boundary cannot support the needed behavior.
- Do not merge to main.

## Acceptance Criteria

- Unit tests prove CSV/TSV data is model-visible through `ToolResultFormatter`.
- Unit tests prove CSV/TSV `offset`/`limit` works and reports accurate row metadata.
- Unit tests prove unchanged duplicate reads do not re-send full content and include a model-actionable hint.
- Unit tests prove shell reroute guidance tells the model which dedicated tool and arguments to use.
- Existing local read/search/edit/shell tests continue to pass.
- Real `--eval-scenario 03` no longer fails because turn 1 or turn 2 hit `loop_detected` from repeated file exploration.

## Verification

- `uv run pytest tests/unit/tools/test_read_only_tools.py tests/unit/tools/test_run_shell.py -q`
- `uv run pytest tests/integration/test_turn_service.py -q`
- `env HOME=/tmp/mycli-real-smoke-home uv run mycli --eval-scenario 03`
