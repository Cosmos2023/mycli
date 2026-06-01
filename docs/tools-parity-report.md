# mycli Built-in Local Tools Parity Report

## Scope

Branch: `feature/mycli-tool-foundation-hardening`

This report covers built-in local tools only. It intentionally excludes MCP,
ACP, skills productization, subagent/multi-agent productization, browser, and
computer-use.

Hermes-agent was used as a maturity reference only; no Hermes code was copied.

## Completed Capabilities

### Registry / Manifest

- Stable built-in tool manifest with `builtin:<tool>` ids.
- Tool metadata includes schema, description, toolset, risk level, approval
  policy, capability tags, effects, and availability.
- Extension manifest exposes the tool manifest.
- Doctor validates the manifest shape.

Commit: `acea17c Make built-in tools discoverable as a stable catalog`

### Read / List / Search

- `Read` exposes text and CSV/TSV model-visible content, numeric summaries, file
  snapshot metadata, and duplicate-read hints.
- `LS`, `Glob`, and `Grep` return structured, bounded, continuation-friendly
  output.
- Formatter renders read/search/list results in a model-visible form.

Commit: `b37e0a2 Make read-only discovery tools easier to continue from`

### Write / Edit / Patch

- `Patch` is a first-class built-in local tool.
- `Write`, `Edit`, and `Patch` produce bounded diffs and stable error kinds.
- Mutation tools enforce stale-read/snapshot checks where appropriate.
- Secret-like content, binary-looking files, directory targets, oversized
  content, and workspace escapes are guarded.
- Mutation targets are exposed for file history and diagnostics.

Commit: `7134df2 Harden local file mutation tools`

### Shell / Terminal

- `Bash` supports workspace-bounded `cwd`.
- Shell results include exit code, stdout, stderr, combined output, timeout
  status, duration, truncation metadata, cwd, and command pattern.
- Timeout and non-zero exits expose stable `error_kind` values.
- `BashOutput` and `KillShell` expose stable missing/not-found error kinds.
- Formatter renders shell cwd, exit code, error kind, truncation, and bounded
  output tail.

Commit: `9441f4b Make shell tools diagnosable under failure`

### Git / Dev Workflow

- Added read-only `GitStatus`, `GitDiff`, `GitLog`, and `GitShow`.
- Git tools run without shell interpolation and stay scoped to the workspace.
- Git payloads are structured and bounded.
- Git tools are in the manifest as low-risk `dev` tools.
- Runtime bootstrap and prompt guidance expose the Git tools.

Commit: `2aa4e72 Expose git inspection as stable local tools`

### Lifecycle / Approval / Diagnostics

- Expanded read-only Git tools are parallel-safe.
- `Patch` participates in mutation/file-history fallback classification.
- Failed lifecycle events include stable `error_kind`.
- `tool_execution` traces include `tool_id`, bounded argument previews, result
  summaries, error summaries, argument keys, raw payload keys, and effect
  metadata.
- Existing doctor tool-execution diagnostics continue to summarize failures
  without raw payload leakage.

Commit: `4dc4384 Align tool lifecycle diagnostics with expanded local tools`

### Smoke / Eval

- Added deterministic provider-free smoke harness:
  `uv run python evaluation/tool_smoke.py`
- Covers:
  - CSV data summary with `Read`
  - duplicate-read hint
  - document lookup and missing-answer search with `Grep`
  - code copy/write/patch with `Write` and `Patch`
  - shell verification with `Bash`
  - failed-tool diagnostics with `GitStatus`
- Latest local smoke report:
  `evaluation/runs/tool-smoke-20260601T154358Z.json`

Commit: `18832f8 Add deterministic smoke coverage for local tools`

## Verification

Latest verified commands:

- `uv run ruff check src tests evaluation/tool_smoke.py`
- `uv run mypy src/mycli`
- `uv run pytest tests/unit tests/integration -q`
  - Result: `1242 passed`
- `uv run python evaluation/tool_smoke.py`
  - Result: exit code `0`
  - Report: `evaluation/runs/tool-smoke-20260601T154358Z.json`

## Remaining Gaps Versus Hermes-agent

- No plugin/MCP/ACP productized external tool ecosystem in this goal.
- No browser/computer-use/vision/image-generation tools.
- No sandbox backends beyond local shell; Hermes supports richer terminal
  environments.
- No per-path lock or cross-agent file state registry.
- Patch is exact replacement only; it does not yet have Hermes-level fuzzy patch
  recovery.
- Git tools are read-only; destructive or write-oriented git operations remain
  intentionally unsupported.
- Availability checks are basic; Hermes has deeper per-tool dependency and
  runtime availability surfaces.

## Next Recommended Phase

The local tools foundation is now coherent enough to use as a base for the next
stage. Recommended order:

1. MCP productization on top of the manifest and lifecycle contracts.
2. Skills productization after MCP/tool discovery is stable.
3. Subagent/multi-agent orchestration once tool state and file history are
   stable across concurrent actors.
4. ACP only after runtime contract, TUI gateway, and external tool manifests
   are stable enough to publish.
