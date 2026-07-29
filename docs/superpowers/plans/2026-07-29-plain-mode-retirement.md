# Plain Mode Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Remove the line-oriented conversational REPL so Node TUI is the only conversation surface while preserving scriptable utility commands and setup fallback.

**Architecture:** Dispatch utility subcommands before interactive validation, then require TTY stdin/stdout and launch the Node TUI unconditionally for conversation startup. Delete REPL-only rendering and readline wiring, while making evaluation smoke scripts call the existing slash command resolver and dispatcher directly.

**Tech Stack:** Python 3.13, argparse, pytest, Ruff, mypy, Node.js TUI tests.

---

### Task 1: Lock Node-only startup behavior

**Files:**
- Modify: `tests/unit/cli/test_main.py`
- Modify: `tests/unit/cli/node_tui/test_process.py`

- [x] **Step 1: Replace plain-mode tests with Node-only contract tests**

Add assertions equivalent to:

```python
def test_main_rejects_non_tty_conversation_before_building_runtime(monkeypatch, tmp_path):
    outputs: list[str] = []
    monkeypatch.setattr("mycli.cli.main.stdin", SimpleNamespace(isatty=lambda: False))
    monkeypatch.setattr("mycli.cli.main.stdout", SimpleNamespace(isatty=lambda: False))
    monkeypatch.setattr(
        "mycli.cli.main.build_turn_service",
        lambda *_args, **_kwargs: pytest.fail("runtime must not be built"),
    )
    assert main([], cwd=tmp_path, home=tmp_path / "home", env={}, output_func=outputs.append) == 2
    assert outputs == ["Interactive mycli requires a terminal."]
```

Keep a separate test proving `doctor --json` or another utility command still
runs when stdin/stdout are non-TTY. Change Node version error expectations so
they no longer recommend `--plain`.

- [x] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
uv run pytest -q tests/unit/cli/test_main.py tests/unit/cli/node_tui/test_process.py
```

Expected: the new non-TTY and Node error assertions fail against the old fallback behavior.

### Task 2: Make conversational startup Node-only

**Files:**
- Modify: `src/mycli/cli/main.py`
- Modify: `src/mycli/cli/node_tui/process.py`

- [x] **Step 1: Remove the plain parser and routing contract**

Delete the `--plain` argument, `should_use_node_tui()`, `_node_tui_fallback()`,
REPL/rendering/autocomplete imports, and their `__all__` entries.

- [x] **Step 2: Add non-TTY rejection after utility dispatch**

Use the following boundary before `build_turn_service()`:

```python
if not stdin.isatty() or not stdout.isatty():
    output_func("Interactive mycli requires a terminal.")
    return 2
```

After runtime construction, call `run_node_tui()` directly. Catch
`NodeTuiProcessError`, print its bounded message, and return 2. Keep the existing
runtime `close()` call in `finally`.

- [x] **Step 3: Remove obsolete Node error guidance**

Use `Node TUI requires Node.js >= 20. Install Node.js and retry.` for missing,
old, or invalid Node version errors.

- [x] **Step 4: Run focused CLI tests**

Run:

```bash
uv run pytest -q tests/unit/cli/test_main.py tests/unit/cli/node_tui/test_process.py
```

Expected: PASS.

### Task 3: Delete the REPL and exclusive rendering chain

**Files:**
- Delete: `src/mycli/cli/repl.py`
- Delete: `src/mycli/cli/rendering.py`
- Modify: `src/mycli/cli/autocomplete.py`
- Move/modify: `tests/integration/test_cli_repl.py` to `tests/integration/test_cli_provider_wiring.py`
- Modify: `tests/unit/cli/test_main.py`

- [x] **Step 1: Delete production-only plain components**

Delete `repl.py` and `rendering.py`. Remove `install_path_autocomplete()` and its
readline/contextlib imports, retaining `path_completion_candidates()` because
the Node gateway calls it.

- [x] **Step 2: Remove tests exclusive to deleted behavior**

Delete REPL loop, plain rendering, stream-to-stdout, fallback, and `--plain`
tests. Preserve path completion and provider adapter wiring tests under the new
integration filename.

- [x] **Step 3: Run CLI and gateway regression tests**

Run:

```bash
uv run pytest -q tests/unit/cli tests/integration/test_cli_provider_wiring.py tests/integration/test_node_tui_gateway.py
```

Expected: PASS.

### Task 4: Decouple focused smoke scripts from the retired REPL

**Files:**
- Modify: `evaluation/hook_smoke.py`
- Modify: `evaluation/tool_management_smoke.py`

- [x] **Step 1: Resolve and dispatch slash commands through active owners**

Replace `build_command_handler()` imports with direct use of:

```python
context = SlashCommandContext(surface=SlashCommandSurface.CLI)
invocation = resolve_slash_command(command, context)
lines = dispatch_backend_slash_command(service, invocation).lines
```

Use a local helper in each smoke script only if it removes repeated invocation
code within that script.

- [x] **Step 2: Run both smoke scripts**

Run:

```bash
uv run python evaluation/hook_smoke.py
uv run python evaluation/tool_management_smoke.py
```

Expected: each exits 0 and prints its result artifact path.

### Task 5: Update current documentation and verify retirement

**Files:**
- Modify: `README.md`
- Modify: `docs/code-redundancy-audit-2026-07-29.md`

- [x] **Step 1: Update supported startup documentation**

Remove the current README `uv run mycli --plain` example. Document that
conversation startup requires a TTY and Node.js 20+, while utility commands
remain scriptable. Mark plain mode retired in the redundancy audit and record
the measured Python file/line reduction. Do not rewrite historical specs and
reports.

- [x] **Step 2: Scan live code and current docs for stale references**

Run:

```bash
rg -n --glob '*.py' --glob 'README.md' --glob 'docs/code-redundancy-audit-2026-07-29.md' -- "--plain|run_repl|MYCLI_TUI_FALLBACK|cli\.repl|cli\.rendering" src tests evaluation README.md docs/code-redundancy-audit-2026-07-29.md
```

Expected: no live references.

- [x] **Step 3: Run full quality gates**

Run:

```bash
uv run ruff check src/mycli tests evaluation
uv run mypy src/mycli
uv run pytest -q
```

Then in `tui/mycli-shell` run:

```bash
npm test -- --runInBand
npm run typecheck
```

Expected: all commands pass.

- [x] **Step 4: Verify diff and production size**

Run:

```bash
git diff --check
find src/mycli -name '*.py' -type f -print0 | xargs -0 wc -l | tail -1
```

Expected: no whitespace errors and a lower production Python line count than 79,261.
