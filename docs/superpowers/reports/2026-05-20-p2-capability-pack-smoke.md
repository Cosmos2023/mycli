# P2 Capability Pack Smoke Report

## Commands

- `uv run ruff check src tests`
- `uv run mypy src/mycli`
- `uv run pytest -q`
- `printf 'Reply with exactly this short sentence: p2 streaming ok\n/quit\n' | uv run mycli --session p2-capability-smoke`
- `printf '/bashes\n/changes\n/usage\n/quit\n' | uv run mycli --session p2-capability-smoke`
- Bash background Python smoke from the implementation plan

## Results

- Ruff: passed.
- Mypy: passed after tightening streaming type annotations.
- Pytest: `799 passed in 6.56s`.
- Real CLI streaming smoke: passed. Output included `[stream] p`, `[stream] 2`, `[stream]  streaming`, `[stream]  ok`, and final answer `p2 streaming ok`.
- `/bashes`: passed, returned `[bash] no background shells`.
- `/changes`: passed, returned `[change] no file changes`.
- `/usage`: passed, returned one turn with `input_tokens=3415`, `output_tokens=19`, `total_tokens=3434`, `cache_read_tokens=0`, `cache_write_tokens=0`.
- Bash background smoke: passed. `Bash` returned a `shell_id`, `BashOutput` returned `ready\n`, and `KillShell` returned `status=killed`.

## Notes

- Chat-completions provider streaming is verified against the configured DeepSeek chat-completions provider.
- Anthropic streaming is covered by unit tests with SDK-style stream events.
- P2 does not add async runtime backpressure, PTY stdin, cross-process shell recovery, or rich interactive diff UI.
