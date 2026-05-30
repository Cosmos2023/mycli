# Runtime Smoke and Diagnostics Verification

## Goal

Run a real `mycli` smoke pass on the current mainline and verify that runtime
state, SQLite sessions, logs, model event diagnostics, raw model payloads, trace
files, FileHistory, and `mycli doctor` agree with the architecture we have been
hardening.

## What I Already Know

- `mycli doctor` exists and is intended to be read-only by default.
- Session state is expected under `~/.mycli/sessions.db`.
- Preferred runtime traces are expected under `~/.mycli/traces/`.
- Operational logs and model diagnostics are expected under `~/.mycli/logs/`.
- Compatibility/test callers may still write workspace-local `log/`, but normal
  CLI runtime should use the user-level log root.
- README documents that legacy JSON session files are no longer the runtime main
  chain.
- Existing open editor tabs include `log/app.log` and `log/error.log`; this task
  should determine whether those are stale local artifacts or still active write
  targets.

## Assumptions

- Use the existing project `.mycli/config.toml` and current shell environment.
- The real smoke can make a minimal provider call unless configuration is missing
  or unsafe.
- If real provider access is unavailable, record that as a blocker with exact
  diagnostics rather than faking a pass.
- Do not change runtime architecture unless the smoke reveals a concrete defect.

## Requirements

- Run baseline static checks before real smoke:
  - `uv run mycli doctor`
  - targeted tests for session/log/doctor paths if needed
- Run one minimal real `mycli` turn with a unique session id.
- Verify the session id appears in `~/.mycli/sessions.db`.
- Verify conversation messages or turn rollouts were persisted for that session.
- Verify `~/.mycli/logs/agent.log` records the session-tagged activity.
- Verify `~/.mycli/logs/model-events.jsonl` receives redacted model event rows
  when a provider call is made.
- Verify `~/.mycli/logs/model-raw/<session>/` receives redacted raw payloads
  when raw provider payload logging is expected.
- Verify `~/.mycli/traces/<session>-trace.jsonl` exists or document why no trace
  was generated.
- Check whether workspace-local `log/app.log` or `log/error.log` are written
  during the smoke.
- Re-run `uv run mycli doctor` after the smoke and explain any warning/failure.
- Produce a short verification artifact under this task summarizing commands,
  observed paths, DB rows, and any gaps.

## Acceptance Criteria

- [x] A real smoke session id is recorded in the task notes or research output.
- [x] The session DB check includes concrete table/row evidence.
- [x] The log check distinguishes user-level `~/.mycli/logs/` from workspace
      compatibility `log/`.
- [x] Doctor output after smoke is captured and interpreted.
- [x] Any discovered defect is either fixed with tests or explicitly converted
      into a follow-up task recommendation.
- [x] No API keys, bearer tokens, or raw secrets are copied into Trellis files or
      final output.

## Result

Completed with a passing real runtime smoke. Evidence is recorded in
`research/runtime-smoke-report.md`.

Follow-up recommendation: decide whether `mycli doctor` should warn when
`~/.mycli/logs/errors.log` is absent after otherwise healthy no-error runtime
activity.

## Out of Scope

- Building new logging features such as rotation or dashboards.
- Adding new session lineage/resume behavior.
- Adding MCP real-server smoke unless the basic runtime smoke passes cleanly and
  time remains.
- Changing provider configuration beyond what is needed to run the current
  smoke.

## Technical Notes

- Relevant specs:
  - `.trellis/spec/backend/quality-guidelines.md`
  - `.trellis/spec/backend/logging-guidelines.md`
  - `.trellis/spec/backend/database-guidelines.md`
- Relevant code paths:
  - `src/mycli/cli/main.py`
  - `src/mycli/cli/bootstrap.py`
  - `src/mycli/application/runtime/agent_runtime.py`
  - `src/mycli/services/diagnostics/doctor.py`
  - `src/mycli/utils/workspace_logger.py`
  - `src/mycli/infrastructure/sqlite_session_store.py`
  - `src/mycli/services/tracing/trace_service.py`
