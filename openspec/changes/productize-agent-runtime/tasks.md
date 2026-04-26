## 1. Runtime Protocol Foundation

- [x] 1.1 Define internal runtime protocol objects for thread, turn, turn item, approval lifecycle, and stop reason
- [x] 1.2 Update runtime trace and session persistence paths to record normalized turn items and explicit stop reasons
- [x] 1.3 Refactor CLI activity rendering to consume normalized runtime events instead of provider-specific assumptions

## 2. Runtime Discipline Policy

- [x] 2.1 Introduce a runtime policy module that evaluates grounded planning, exploration budget, loop signals, and evidence sufficiency
- [x] 2.2 Add minimum viable heuristics for overview-style tasks so the runtime prefers concise answers once enough evidence is gathered
- [x] 2.3 Add loop-handling behavior that steers the model toward summarization before terminating with `loop_detected`

## 3. Recoverable Tool Contract

- [x] 3.1 Update file and directory tools to return structured recoverable failures for expected domain errors
- [x] 3.2 Ensure recoverable tool failures flow through runtime, trace, and model reinjection without crashing the turn
- [x] 3.3 Preserve terminal classification for runtime/provider failures and add regression tests covering both recoverable and terminal error paths

## 4. Responses Alignment and Verification

- [x] 4.1 Map Responses provider events onto the new runtime protocol without leaking wire-level details into surfaces
- [x] 4.2 Add unit and integration tests for protocol mapping, stop reasons, runtime policy decisions, and recoverable tool failures
- [x] 4.3 Run smoke tests against `mycli` to verify overview tasks stop cleanly and failed path reads no longer crash the turn
