# Phase 5 Unified Settings Center And Command Discovery

## Goal

Turn mycli's existing selectors, canonical slash registry, and lossless settings persistence into
one discoverable control surface. Users should be able to find a setting or command, understand its
effective value and source, and enter the existing safe domain workflow without losing their draft
or accidentally writing permanent configuration.

## What I Already Know

- The approved configuration and UX roadmap defines this as Phase 5 after permission/sandbox
  productization.
- Unified lossless settings persistence, session-scoped model selection, credential readiness, and
  effective permission projection are already implemented and archived.
- `/settings` currently exposes only nine visual settings; the slash registry hides a large
  supported subset from discovery and does not project aliases or capability reasons.
- The user requested continued inline implementation without subagents.
- Seven unrelated Windows/CI files are dirty and must not be modified, staged, committed, or
  reverted by this task.

## Requirements

- Expand `/settings` into the roadmap categories: model/reasoning, providers/credentials,
  permissions/sandbox, appearance/accessibility, sessions/context, integrations, and
  updates/diagnostics.
- Add a versioned, bounded gateway settings catalog. Rows include stable id/category, label,
  description, kind, current value, source/scope, allowed values or action, lock reason, restart
  requirement, command path, and fuzzy-search terms.
- Source visual-setting labels, allowed values, defaults, client keys, and CLI keys from one config
  package descriptor catalog used by validation and persistence.
- Keep model, login, permissions, trust, sessions, resources, and diagnostics owned by their
  existing domain selectors/commands. Settings action rows open those same components.
- Add a selector stack so nested settings actions return one level on Esc. Preserve the composer
  draft and focus while opening, nesting, failing, and closing overlays.
- Visual setting changes show `old -> new` before application and offer session-only or user-default
  scope. Session scope applies immediately without a file write; user scope uses the existing
  atomic persistence path. Failed writes restore the previous value, keep settings open, and show a
  bounded focused error.
- Make every visual setting available through the allowlisted provider-free `mycli config
  get|set|unset` path without exposing arbitrary TOML paths.
- Extend slash discovery metadata with category, aliases, search-only state, and bounded
  availability reason. The default palette/help show common available commands; explicit fuzzy
  search includes aliases, descriptions, settings terminology, and unavailable/search-only rows.
- Keep canonical parsing/routing unchanged and keep integration commands additive.
- Never expose credentials, auth refs, raw policy/helper errors, arbitrary local paths, or
  unbounded provider/plugin text.

## Acceptance Criteria

- [x] `/settings` renders all seven categories and reaches every editable user-facing setting or
  its dedicated domain workflow.
- [x] Visual rows display effective value and source; managed or unavailable rows are locked with a
  bounded explanation, and restart requirements are visible.
- [x] A permanent visual change requires a preview and explicit user-default selection; a session
  change performs no persistent write.
- [x] Failed persistence rolls back the optimistic value, retains the draft and selector, and
  displays one sanitized error.
- [x] `/model`, `/permissions`, `/login`, `/trust`, and settings action rows open the same underlying
  components; Esc returns one selector level before returning to the composer.
- [x] Command palette fuzzy search covers canonical names, aliases, descriptions, setting terms,
  and current values. Unavailable/search-only commands appear only for an explicit matching query
  and cannot execute.
- [x] `mycli config get|set|unset` supports every visual descriptor through a stable allowlisted key,
  validates enums/booleans, preserves unrelated TOML, and reports source without exposing paths.
- [x] Settings catalog, slash manifest, palette, help, aliases, and `docs/commands.md` have drift
  coverage.
- [x] Widths 60/80/100/140 plus CJK and Windows-style values render without overlap or clipped
  actionable text.
- [x] Focused config, gateway, registry, TUI, and integration tests plus lint, typecheck, contracts,
  and the full workspace suite pass.

## Definition Of Done

- The gateway descriptor payload and config mutation allowlist are provider-free and testable.
- Existing model, authentication, permission, trust, session, and integration behavior remains
  backward compatible.
- User-facing commands and executable Trellis contracts are documented.
- Work is committed, archived, and journaled without unrelated Windows/CI changes.

## Technical Approach

1. Introduce config-owned shell setting descriptors and reuse them for parsing, snapshots, and
   allowlisted `config` mutation keys.
2. Add a pure Node settings-catalog projector combining shell descriptors with current model,
   credential, permission, trust, context, integration, and diagnostic state.
3. Extend `settings.load/save` and TUI runtime-state parsing with the versioned catalog.
4. Refactor the settings selector into categorized action/choice rows with fuzzy search, preview,
   scope selection, rollback, and focused errors; add nested selector restoration to shell runtime.
5. Enrich slash discovery from the canonical registry and update palette/help behavior and drift
   fixtures.

## Decision (ADR-lite)

**Context**: A TUI-only settings list would drift, while a generic TOML editor would bypass typed
domain validation and widen the secret/policy mutation surface.

**Decision**: Use a gateway-projected catalog and keep mutations inside existing typed domain
owners. Treat settings as a discoverable index plus safe visual-choice editor, following Codex's
central command metadata and focused-selector pattern.

**Consequences**: Other clients can reuse the catalog and users gain one searchable surface without
creating a second policy engine. The catalog must remain versioned and bounded, and adding a new
user-facing setting now requires descriptor and drift-test updates.

## Expansion Sweep

- Future: the catalog can feed a graphical client or Phase 6 session-repair flow without changing
  domain mutation ownership.
- Related: dedicated slash shortcuts, Ctrl+P, help, autocomplete, config CLI, and docs must stay in
  sync with the same descriptors.
- Failure cases: managed locks, missing capabilities, stale catalog values, failed writes, narrow
  terminals, CJK, Windows paths, nested Esc, and asynchronous selector completion are included.
- Deferred: arbitrary project-scope writes, secret editing through generic config, automatic
  updater/setup mutations, keymap redesign, and Phase 6 session repair.

## Out Of Scope

- Arbitrary TOML editing or model-facing configuration mutation.
- Credential values in catalog, config CLI, logs, or TUI state.
- Project/managed configuration writes or bypassing managed policy.
- Implementing an updater, elevated sandbox setup/reset, or session recovery commands.
- Replacing existing model, permission, login, trust, session, or resource selectors.

## Research References

- [`research/settings-command-discovery.md`](research/settings-command-discovery.md) - current
  gaps, local Codex comparison, alternatives, and selected ownership boundary.

## Technical Notes

- Plan source: `.omx/plans/mycli-configuration-and-ux-optimization-plan.md`, Phase 5.
- Applicable specs: `.trellis/spec/backend/configuration-trust-contract.md` and
  `.trellis/spec/backend/runtime-tui-gateway-contract.md`.
- Implementation mode is inline; no implementation, research, or check subagent may be started.
