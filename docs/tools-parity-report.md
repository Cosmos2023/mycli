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
- Toolset registry foundation exposes toolset grouping, enablement, aliases,
  source composition, availability, and conflict diagnostics through
  `toolset_manifest`.
- Built-in and contributed tool registrations can be rendered into one combined
  manifest shape, including source, toolset, schema, risk, effects,
  availability, and bounded contribution metadata.
- Extension manifest exposes `toolsets.manifest` so future MCP/plugin/skills
  and subagent clients can inspect the same grouping surface without scraping
  human output.

Commit: `acea17c Make built-in tools discoverable as a stable catalog`
Follow-up: ToolsetRegistry extension foundation slice

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
- Doctor now checks local tool environment availability for shell and git
  without executing commands.
- Doctor now includes toolset registry health in the `tool_manifest` check,
  including bounded enabled/disabled/conflict counts.

Commit: `4dc4384 Align tool lifecycle diagnostics with expanded local tools`
Commit: follow-up doctor tool environment check slice

### MCP Tool Lifecycle Foundation

- Local stdio MCP servers can be configured through `.mycli/mcp_servers.toml`.
- MCP discovery now reports bounded per-server diagnostics: configured/enabled
  counts, disabled servers, discovered tool counts, failure kind, and safe
  server summaries.
- Doctor reports MCP discovery health without printing command args, env
  values, raw tool arguments, headers, or secret-like values.
- MCP tools are converted into `ToolContributionRegistration` through the
  existing contribution path and rendered into the combined manifest as
  `source=mcp`, `toolset=external`.
- Extension manifest and toolset manifest can expose MCP-origin contributed
  tools without scraping human output.
- Deterministic provider-free MCP smoke verifies config loading, stdio
  discovery, tool call, extension manifest entry, toolset manifest entry, and
  doctor diagnostics:
  `uv run python evaluation/mcp_smoke.py`

Commit: pending MCP lifecycle foundation slice

### Skills Tool Lifecycle Foundation

- Skill discovery now supports built-in, user/local, and repo skill
  directories.
- Skill metadata includes source kind, dependencies, guardrails, trigger hints,
  availability, and path provenance.
- Skill diagnostics report loaded counts, source counts, duplicate names, and
  malformed skill files without printing skill bodies.
- Doctor reports skill catalog health with bounded diagnostics.
- Local skills can be exposed as skill-origin contributed tools through
  `SkillToolContributionProvider`.
- Combined manifest and extension manifest render skill-origin tools as
  `source=skill`, `toolset=external`.
- Runtime lifecycle coverage proves skill tools pass through
  `ToolOrchestrator`, `ToolContributionRegistry`, and `ToolRouter`.
- Deterministic provider-free skill smoke verifies discovery, invocation,
  extension manifest, toolset manifest, lifecycle, and doctor diagnostics:
  `uv run python evaluation/skill_smoke.py`

Commit: pending skills lifecycle foundation slice

### Subagent / Task Tool Lifecycle Foundation

- Existing `Task` runtime delegation remains available as the generic built-in
  workflow tool.
- Sub-agent profiles are now exposed as profile-specific contributed tools via
  `SubAgentToolContributionProvider`, with routes such as `subagent_explore`.
- Combined manifest and extension manifest render subagent-origin tools as
  `source=subagent`, `toolset=external`.
- Doctor reports subagent profile diagnostics with bounded safe detail: profile
  names, default tool names, denied-tool counts, and budget shape. It does not
  print delegated task descriptions or full profile prompts.
- Runtime lifecycle coverage proves subagent tools pass through
  `ToolOrchestrator`, `ToolContributionRegistry`, and `ToolRouter`.
- Deterministic provider-free subagent smoke verifies profile discovery,
  invocation, extension manifest, toolset manifest, lifecycle, and doctor
  diagnostics:
  `uv run python evaluation/subagent_smoke.py`

Commit: pending subagent lifecycle foundation slice

### Extension / Tool Management Surface Foundation

- `/tools` now renders from the same extension manifest used by gateway clients
  instead of hand-formatting local tool specs only.
- Tool rows include route name, source, toolset, risk, availability, and
  approval policy for built-in and contributed tools.
- `/toolsets` reports toolset enablement, sources, tool names, and conflict
  counts from the toolset manifest.
- `AgentRuntime.extension_manifest()` returns a live read-only manifest that
  includes visible contributed tools such as skill and subagent routes.
- Doctor includes `tool_manifest_runtime`, a read-only consistency check that
  validates extension manifest tool and toolset surfaces against runtime-visible
  local tools.
- Deterministic provider-free management smoke verifies machine manifest data
  and human slash-command output:
  `uv run python evaluation/tool_management_smoke.py`

Commit: pending tool management surface foundation slice

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
  `evaluation/runs/tool-smoke-20260601T154741Z.json`

Commit: `18832f8 Add deterministic smoke coverage for local tools`

## Verification

Latest verified commands:

- `uv run ruff check src tests evaluation/tool_smoke.py`
- `uv run mypy src/mycli`
- `uv run pytest tests/unit tests/integration -q`
  - Result: `1243 passed`
- `uv run python evaluation/tool_smoke.py`
  - Result: exit code `0`
  - Report: `evaluation/runs/tool-smoke-20260601T154741Z.json`

## Remaining Gaps Versus Hermes-agent

- No plugin/MCP/ACP productized external tool ecosystem in this goal.
- MCP has a local stdio lifecycle foundation, but not a full productized
  ecosystem.
- Skills have a local discovery/invocation/diagnostics foundation, but not a
  full productized marketplace/sync/management surface.
- Toolset enable/disable is visible in the foundation manifest, but runtime
  enforcement and user-facing configuration are not yet productized.
- Contributed tools are unified at the manifest/discovery layer. MCP local
  stdio tools, skills, and subagent profiles have deterministic lifecycle
  smoke coverage, while hosted MCP and plugin lifecycle remain later phases;
  skills still need marketplace/sync/management productization.
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

1. MCP productization beyond local stdio: auth, SSE, user-facing management,
   refresh, and remote server failure UX.
2. Skills productization beyond local discovery: install/sync/list/view/manage
   UX, richer activation policy, and bundled skill library expansion.
3. Subagent/multi-agent orchestration beyond the local profile lifecycle:
   concurrent actor state, file locks, richer child profiles, and TUI UX.
4. ACP only after runtime contract, TUI gateway, and external tool manifests
   are stable enough to publish.
