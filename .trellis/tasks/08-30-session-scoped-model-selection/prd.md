# Session-Scoped Model Selection

## Goal

Make model and reasoning selection scope explicit so ordinary `/model` use changes only the active
session, while updating the user default requires an intentional `Make user default` choice.

## Requirements

- Add a closed model-selection scope contract with `session` and `user` values.
- Treat a missing scope as `session` for backward compatibility and least-surprise safety.
- Extend `model.select` and the TUI gateway client to carry the selected scope.
- Add a final scope stage to the model selector after model/reasoning selection.
- Present `Use for this session` first and selected by default; present `Make user default` second
  with concise persistence wording.
- Always validate model, provider, credential, and reasoning compatibility before changing state.
- For `session`, persist only the active session preferences and activate them immediately. Do not
  write user configuration or update defaults used by new sessions.
- For `user`, atomically update user provider/model/reasoning configuration, then persist and
  activate the same preferences for the active session.
- Keep the selector open on any backend/config failure and display the existing bounded inline
  error.
- Return the applied scope in the gateway response and keep credentials, config paths, and raw
  submitted values out of errors and transcript state.
- Preserve setup behavior: the setup wizard still establishes user defaults because it is an
  explicit configuration flow, not an ordinary session model switch.

## Acceptance Criteria

- [x] TUI tests cover the scope stage, session-first default, Esc back-navigation, narrow width,
      and both scope callbacks.
- [x] Gateway tests prove missing scope defaults to `session`, invalid scope is rejected, and the
      selected scope reaches the control command.
- [x] Backend integration tests prove a session selection changes current/resumed session
      preferences without changing `~/.mycli/config.toml` or a newly created session's defaults.
- [x] Backend integration tests prove a user selection updates both user configuration and active
      session preferences.
- [x] A failed user-config write leaves active session preferences and user config unchanged.
- [x] Existing model/reasoning selection, setup, resume, and visual-setting persistence tests pass.
- [x] Gateway contracts, docs, lint, typecheck, full tests, and release checks pass.

## Definition Of Done

- Model selection has one typed scope vocabulary from TUI through runtime persistence.
- Session-only choices survive resume and never mutate global defaults.
- Permanent choices are explicit, atomic at the user-config boundary, and reflected in the current
  session only after persistence succeeds.
- Runtime/TUI configuration specs and user-facing model command documentation describe the scope
  behavior.
- Changes are committed, task metadata is archived, and unrelated Windows sandbox edits remain
  untouched.

## Technical Approach

Add `ModelSelectionScope` at the gateway/control boundary. Change the model selector callback to
return the model plus scope after a third `scope` stage. The backend builds `SessionPreferences`
directly from the validated catalog entry. It writes user configuration and refreshes
`defaultPreferences` only for `user`; both paths save the active session's preferences after all
fallible validation and optional user-config persistence have completed.

Keep setup on `writeUserProviderConfig`. Do not route model selection through the generic config
management CLI because session scope is runtime state, not a user TOML mutation.

## Decision (ADR-lite)

**Context:** The current model selector silently writes both the user default and active session,
violating the UX plan's scope semantics and making an ordinary runtime choice permanent.

**Decision:** Use an explicit `session | user` request field and a visible final scope selector,
defaulting omitted requests and UI focus to `session`.

**Consequences:** Model selection gains one extra confirmation step, but runtime and persistence
ownership become deterministic. Future unified settings can reuse the same scope vocabulary.

## Expansion Sweep

- Future evolution: project/profile scopes can be added to a settings/config editor without
  widening this runtime contract today.
- Related scenarios: setup remains user-default; direct CLI `--model` remains a startup override;
  resume consumes stored session preferences.
- Failure cases: missing credentials, invalid effort, config write failure, no-op selection, resume,
  and selector cancellation are covered.

## Out Of Scope

- Project or profile default writes.
- Provider credential creation/removal or setup-wizard redesign.
- Full `/settings` information architecture.
- Config migration, profiles, shell completions, or update checks.
- Unrelated Windows sandbox and CI changes already present in the worktree.

## Research References

- [`research/model-selection-scope.md`](research/model-selection-scope.md) - current mycli flow,
  local Codex event boundaries, alternatives, and selected contract.

## Technical Notes

- Plan source: `.omx/plans/mycli-configuration-and-ux-optimization-plan.md`, Phase 3.
- Main implementation areas: Node gateway/backend, session preferences, TUI gateway/model selector,
  contracts, focused app/TUI tests, and command documentation.
- Existing Windows sandbox files are unrelated and must not be staged or modified.
