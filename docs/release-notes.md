# Release Candidate Notes

These notes describe the current source candidate. The release operator replaces this heading with
the selected version when running the coordinated version and tag workflow. This document does not
assign or publish a version.

## Configuration And Onboarding

- Added deterministic configuration precedence, source provenance, project trust gating, launch
  profiles, strict validation, generated references, and explicit migration preview/apply/rollback.
- Unified first-run provider, credential, model, trust, and permission setup while preserving
  cancellation and offline configuration.
- Added provider-free login status/logout, setup, config, doctor, session, update, sandbox, hook,
  plugin, and MCP management commands for automation.
- Added first-class OpenRouter, Groq, Together, Moonshot AI, NVIDIA, and Cerebras profiles backed by
  pinned pi-ai transports, conservative unknown-model handling, and model-compatible setup defaults.

## Runtime And Terminal

- Kept session-scoped model and reasoning choices across resume without rewriting user defaults.
- Added explicit permission switching, platform sandbox readiness and recovery, actionable bounded
  errors, and redacted support bundles.
- Added configurable terminal keymaps, semantic color modes, reduced motion, ASCII fallback,
  bash/zsh/fish/PowerShell completions, CJK/IME-safe layout, and clear non-TTY behavior.

## Packaging And Compatibility

- The public package is `@cosmos2023/mycli`; `@cosmos2023/app` is the deprecated published
  predecessor used by the upgrade/downgrade gate.
- Six `@cosmos2023/ripgrep-*` packages supply target-specific ripgrep binaries while nine private
  workspaces remain vendored inside the application tarball.
- Session schema 12 is fresh-only. Sessions created by the schema 9 predecessor are not converted
  in place and must remain with their complete database sidecars and a compatible old binary.
- Packed artifact tests now cover completions, no-color output, management commands, migration and
  rollback, session resume, non-blocking update work, native PTY startup, and platform selection.
- A separately visible macOS, Ubuntu, and Windows workflow records sanitized compatibility
  evidence. Product failures remain failures; external registry outages are labeled explicitly.

## Operator Notes

- `@cosmos2023/mycli@0.1.0` already exists in npm. Run
  `npm run release:version -- <new-semver>` before publishing this candidate.
- Review [compatibility.md](compatibility.md), [upgrading.md](upgrading.md), and
  [releasing.md](releasing.md) before tagging.
- No telemetry, automatic package-manager execution, silent update, or automatic config/session
  migration was added.
