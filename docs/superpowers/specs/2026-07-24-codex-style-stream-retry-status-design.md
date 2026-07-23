# Codex-Style Stream Retry Status Design

## Goal

Align retryable model-stream failures with Codex: show a transient reconnect status with the retry count and underlying error, keep the turn active, remove the status after recovery, and emit a permanent error only after retries are exhausted.

## Behavior

- A retryable stream failure emits `stream.retrying` with `text`, `additional_details`, `attempt`, and `max_attempts`.
- The TUI renders a bounded status surface such as:

  ```text
  Reconnecting... 1/5
  Idle timeout waiting for model stream
  ```

- Retry notices never become transcript or session-history messages.
- Partial assistant output from a failed attempt is removed before the retry status appears.
- While reconnecting, the turn remains running: Esc interrupts it and new input follows the existing steer/follow-up rules.
- `stream.recovered` removes retry details and restores the status that was active before reconnecting, falling back to `Running`.
- Exhausting the retry budget uses the existing terminal model-error path.

## Data Flow

1. `TurnExecutor` classifies a retryable `ModelResponseError` and emits the existing retry lifecycle event with a sanitized `additional_details` value.
2. `NodeTuiGateway` forwards the structured retry payload unchanged.
3. `RuntimeShellState` stores the reconnecting kind, display text, detail, and the status to restore after recovery.
4. `projectRuntimeState` exposes structured live-status kind and detail to the shell footer model.
5. `MycliShellRuntime` uses the kind, rather than display-text matching, for running-state behavior and renders reconnect details in the transient turn-status component.

## Constraints

- Do not expose request bodies, API keys, headers, or raw provider payloads.
- Keep retry details width-safe and visually bounded on narrow terminals.
- Preserve the existing default of five stream retries and existing backoff behavior.
- Do not change non-retryable error handling.

## Verification

- Python tests cover retry detail emission and gateway forwarding.
- Runtime-state tests cover reconnect projection, status restoration, and no transcript insertion.
- Shell tests cover two-line rendering, width safety, and Esc/running behavior during reconnect.
- Run the full TypeScript test suite, typecheck, and focused Python retry/gateway tests.
