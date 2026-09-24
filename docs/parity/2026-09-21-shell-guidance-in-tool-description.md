# Shell Command Rules In The Tool Description

Reference: `codex-rs/core/src/tools/handlers/shell_spec.rs` (`windows_shell_guidance`),
`codex-rs/core/src/tools/spec_plan.rs` (`should_include_windows_shell_guidance`),
`codex-rs/core/src/context/environment_context.rs` (environment facts), and
`codex-rs/core/src/context/world_state/environment.rs` (rendered `<environment_context>`),
inspected on 2026-09-21.

## Problem

mycli carried platform command rules in two places Codex does not use for that purpose: the
per-turn environment context (`shell_notes`) and the static base prompt (`# Shell And Platform`
described PowerShell 5.1 chaining, CMD variables, and POSIX-only pipelines for every session on
every platform). That duplicates rules, ships platform text the model does not need, and drifts
from the shell the session actually resolved.

## Codex behavior

- The environment context reports facts only: `<shell>bash</shell>`, cwd, date, timezone, network,
  and filesystem permissions. There is no dialect instruction text.
- Platform rules live in the `exec_command` tool description. Codex appends a
  `Windows safety rules:` block when the target environment is Windows
  (`executor_platform_os == "windows"` for a single environment, otherwise the host's
  `cfg!(windows)`), covering cross-shell destructive commands, resolved-path checks before
  recursive delete/move, and `Start-Process -WindowStyle Hidden`.
- macOS and Linux receive the same description with no extra platform text, and the base prompt
  keeps only platform-neutral shell guidance (prefer `rg`, no chunk-dumping scripts, parallelize
  reads).

## mycli implementation

- `shell-dialect-guidance.ts` splits the old single note into `shellDialectFact(dialect)` (one
  factual line for the environment context) and `shellToolGuidance(dialect, { platform })` (the
  rules for the tool description). The guidance carries the dialect syntax, the pinned UTF-8 rule
  for Windows dialects, the Windows safety rules, and the macOS BSD-userland caveats.
- `shell-manifest.ts` gains `shellToolDefinition(guidance)` and
  `shellManifestEntries({ shellGuidance })`; `builtinToolManifest({ shellGuidance })` rebuilds only
  the Shell entry while preserving tool order, toolsets, and the cached default singleton.
- `node-backend.ts` resolves the shell profile once per session and builds a session tool manifest
  from it, so the model sees the rules for the shell that will actually run the command. The
  environment context keeps `shell`, `shell_kind`, `shell_dialect`, and the factual `shell_notes`.
- The base prompt moves to `2026-09-codex-style-base-v23`: the three dialect-specific bullets are
  replaced by a pointer to the `Shell` tool description plus platform-neutral guidance.

## Verification

- `backend/packages/tools/test/shell/shell-dialect-guidance.test.ts` covers the fact line (single
  line, no rules) and the guidance (POSIX, macOS caveats, Windows dialect limits, encoding, and
  safety rules).
- `backend/packages/tools/test/registry/manifest.test.ts` asserts the guided manifest changes only
  the Shell description, keeps order and toolsets, stays frozen, and that the default call still
  returns the cached singleton.
- `backend/apps/mycli/test/node-backend.integration.test.ts` asserts the plan request's Shell
  description carries the dialect rules while the environment context keeps the factual
  `shell_notes` line.
- `backend/apps/mycli/test/system-prompt.test.ts` covers the new prompt pointers; lint, typecheck,
  and build pass.

## Notes

The base context (prompt, tool schemas, AGENTS.md) now measures about 9.4k tokens on Windows. In the
Plan-mode integration test the mock model's 22.6k window with 13k reserved output tokens triggered a
pre-turn compaction between the first and second turn, so that test selects the plan request by
content instead of by request index.

That base context also sat close to the ~9,600-token compaction ceiling derived for the synthetic
`gpt-test` model, so a session with a short conversation auto-compacted and scripted suites saw an
extra provider request. The temporary harness fix raised `MYCLI_MAX_PROMPT_TOKENS` /
`MYCLI_COMPACTION_TOKEN_LIMIT` in those suites; the trigger now scopes to post-prefix tokens
instead, the bumps are reverted, and the Plan-mode test keeps selecting its request by content
instead of by index. See
[2026-09-21-compaction-limit-scope.md](./2026-09-21-compaction-limit-scope.md).

The M5 recovery test still raises `MYCLI_MAX_PROMPT_TOKENS` to 32000 for an unrelated reason: the
summarizer needs its full output room.

## Deferred

mycli still resolves one local shell profile per session; Codex selects the guidance per target
environment, which matters once remote executors report their own platform.
