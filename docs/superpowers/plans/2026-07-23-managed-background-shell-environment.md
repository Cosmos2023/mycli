# Managed Background Shell Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex-compatible long-running skill servers remain attached to mycli's Shell runtime so yield registers them in `/ps` and `/stop` can terminate them.

**Architecture:** `create_shell_environment()` adds the mycli-owned `MYCLI_CI=1` marker after user filtering and overrides. The Visual Companion startup wrapper treats this marker as an automatic foreground request, while explicit `--background` remains authoritative. Existing Shell yield, registry, process-group termination, and TUI projection remain unchanged.

**Tech Stack:** Python 3.13, pytest, Bash, Node.js Visual Companion server

---

### Task 1: Add The Managed Shell Environment Marker

**Files:**
- Modify: `tests/unit/tools/test_shell_environment.py`
- Modify: `src/mycli/tools/shell_environment.py`

- [ ] **Step 1: Write the failing marker test**

Add a test that supplies `MYCLI_CI=0` through the user policy and excludes it with
`include_only`, then asserts that runtime construction restores the authoritative marker:

```python
def test_create_shell_environment_sets_mycli_ci_after_policy_filters(monkeypatch) -> None:
    monkeypatch.setattr(
        shell_environment,
        "prepend_ripgrep_to_path",
        lambda path: (path or "", None),
    )

    env = create_shell_environment(
        ShellEnvironmentPolicy(
            inherit="none",
            set={"MYCLI_CI": "0"},
            include_only=("PATH",),
        ),
        source_env={},
    )

    assert env["MYCLI_CI"] == "1"
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
./.venv/bin/pytest tests/unit/tools/test_shell_environment.py::test_create_shell_environment_sets_mycli_ci_after_policy_filters -q
```

Expected: FAIL with `KeyError: 'MYCLI_CI'`.

- [ ] **Step 3: Add the runtime-owned marker**

In `src/mycli/tools/shell_environment.py`, define and inject the marker after policy filtering:

```python
MYCLI_CI_ENV_VAR = "MYCLI_CI"
MYCLI_THREAD_ID_ENV_VAR = "MYCLI_THREAD_ID"

# After include_only and thread-id handling:
env[MYCLI_CI_ENV_VAR] = "1"
```

Update exact dictionary assertions in `test_shell_environment.py` to include
`"MYCLI_CI": "1"`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
./.venv/bin/pytest tests/unit/tools/test_shell_environment.py tests/unit/tools/test_run_shell.py -q
```

Expected: all tests pass.

- [ ] **Step 5: Commit the mycli runtime change**

```bash
git add src/mycli/tools/shell_environment.py tests/unit/tools/test_shell_environment.py
git commit -m "feat: mark mycli-managed shell environments"
```

### Task 2: Teach Visual Companion To Cooperate With mycli

**Files:**
- Modify: `/Users/cosmos/Downloads/superpowers-main/tests/brainstorm-server/start-server.test.sh`
- Modify: `/Users/cosmos/Downloads/superpowers-main/skills/brainstorming/scripts/start-server.sh`
- Modify: `/Users/cosmos/Downloads/superpowers-main/skills/brainstorming/visual-companion.md`
- Sync: `/Users/cosmos/.mycli/skills/brainstorming/scripts/start-server.sh`
- Sync: `/Users/cosmos/.mycli/skills/brainstorming/visual-companion.md`

- [ ] **Step 1: Write the failing mycli foreground-selection test**

Extend `start-server.test.sh` with a fake `node` executable and invoke the wrapper with
`MYCLI_CI=1`. Assert that the fake node's stdout remains attached:

```bash
captured=$(
  PATH="$TEST_DIR/fake-bin:$PATH" \
    MYCLI_CI=1 \
    MSYSTEM="" \
    bash "$START_SCRIPT" --project-dir "$TEST_DIR/project" 2>/dev/null || true
)

if echo "$captured" | grep -q "FOREGROUND_MODE=true"; then
  pass "auto-foregrounds in a mycli-managed shell"
else
  fail "auto-foregrounds in a mycli-managed shell" \
       "expected foreground node path, got: $captured"
fi
```

- [ ] **Step 2: Run the shell test and verify RED**

Run:

```bash
bash tests/brainstorm-server/start-server.test.sh
```

Expected: the new `auto-foregrounds in a mycli-managed shell` assertion fails.

- [ ] **Step 3: Add `MYCLI_CI` startup detection**

Change the automatic foreground condition in `start-server.sh` to:

```bash
if [[ ( -n "${CODEX_CI:-}" || -n "${MYCLI_CI:-}" ) \
      && "$FOREGROUND" != "true" \
      && "$FORCE_BACKGROUND" != "true" ]]; then
  FOREGROUND="true"
fi
```

Add a mycli section to `visual-companion.md` stating that normal invocation is sufficient
because `MYCLI_CI` selects foreground mode and Shell yield creates the managed background
session. Remove references that tell mycli to use legacy `run_in_background` or async modes.

- [ ] **Step 4: Verify the source skill tests**

Run from `/Users/cosmos/Downloads/superpowers-main`:

```bash
bash tests/brainstorm-server/start-server.test.sh
bash tests/shell-lint/test-lint-shell.sh
```

Expected: both scripts exit 0.

- [ ] **Step 5: Sync the verified source files into mycli's user skill directory**

```bash
cp skills/brainstorming/scripts/start-server.sh \
  /Users/cosmos/.mycli/skills/brainstorming/scripts/start-server.sh
cp skills/brainstorming/visual-companion.md \
  /Users/cosmos/.mycli/skills/brainstorming/visual-companion.md
```

Verify both pairs are identical with `cmp -s`.

### Task 3: Verify The End-To-End Managed Lifecycle

**Files:**
- Verify only: `src/mycli/tools/bash.py`
- Verify only: `src/mycli/application/turn_service.py`

- [ ] **Step 1: Run existing Shell lifecycle coverage**

```bash
./.venv/bin/pytest \
  tests/unit/tools/test_shell_session_manager.py \
  tests/unit/tools/test_shell_command_runtime.py \
  tests/integration/test_turn_service.py -q
```

Expected: all tests pass, including yielded `running_background` and owner-scoped `/ps`
coverage.

- [ ] **Step 2: Start Visual Companion through mycli's actual Shell tool**

Use `ShellTool` with the verified installed script, a temporary project directory, and
`yield_time_ms=250`. Assert its result includes:

```text
background=true
status=running
process_state=running_background
yielded=true
```

Read `server-info`, verify its port accepts a local TCP connection, and retain the returned
`shell_id`.

- [ ] **Step 3: Verify `/ps` ownership and cleanup**

Use the same owner session ID to inspect `SHELL_REGISTRY.list()`, assert the returned
`shell_id` is present, then terminate it through `KillShellTool`. Verify the port stops
accepting connections and no active registry row remains.

- [ ] **Step 4: Run static checks**

```bash
./.venv/bin/ruff check src/mycli/tools/shell_environment.py tests/unit/tools/test_shell_environment.py
./.venv/bin/mypy src/mycli/tools/shell_environment.py
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit the implementation plan status if changed**

Only if checkbox tracking changed in this plan, commit that file separately:

```bash
git add docs/superpowers/plans/2026-07-23-managed-background-shell-environment.md
git commit -m "docs: add managed shell environment implementation plan"
```
