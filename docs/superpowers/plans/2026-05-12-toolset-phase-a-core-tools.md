# Toolset Redesign — Phase A: Core Read/Write Tools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Read (multi-format file reader) and Edit (search-and-replace engine) — the two most complex tools.

**Architecture:** Read delegates to format-specific handlers (text, CSV, PDF, Excel, Word, Jupyter) via lazy import. Edit uses old_string uniqueness matching with 3-step preprocessing → find → replace pipeline.

**Tech Stack:** Python 3.12+, pytest, pathlib, subprocess. Optional deps: openpyxl, PyMuPDF, python-docx, nbformat.

**Reference:** `docs/superpowers/specs/2026-05-12-mycli-toolset-design.md` Sections 2.1, 2.2.

---

### Task A1: Read — text file handler

**Files:**
- Create: `src/mycli/tools/read/__init__.py`
- Create: `src/mycli/tools/read/text.py`
- Create: `tests/unit/test_read_text.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/unit/test_read_text.py
import pytest
from mycli.tools.read.text import read_text


class TestReadText:
    def test_full_read(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("line1\nline2\nline3\n")
        result = read_text(str(f))
        assert result["content"] == "     1\tline1\n     2\tline2\n     3\tline3\n"
        assert result["truncated"] == False

    def test_offset_and_limit(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("\n".join(f"line{i}" for i in range(1, 21)))  # 20 lines
        result = read_text(str(f), offset=5, limit=3)
        lines = result["content"].strip().split("\n")
        assert len(lines) == 3
        assert "line5" in lines[0]

    def test_truncated_flag(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("\n".join(f"line{i}" for i in range(1, 3001)))  # 3000 lines
        result = read_text(str(f))
        assert result["truncated"] == True
        assert "output truncated" in result["content"]

    def test_line_truncation(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("a" * 3000 + "\n")
        result = read_text(str(f))
        assert "[... truncated]" in result["content"]

    def test_file_not_found(self):
        result = read_text("/nonexistent/path.py")
        assert "File not found" in result["error"]

    def test_directory(self, tmp_path):
        result = read_text(str(tmp_path))
        assert "Path is a directory" in result["error"]

    def test_default_limit(self, tmp_path):
        f = tmp_path / "large.py"
        f.write_text("\n".join(f"line{i}" for i in range(1, 2500)))
        result = read_text(str(f))
        # Default limit is 2000
        assert result["total_lines"] == 2500
        assert result["shown_lines"] == 2000
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/unit/test_read_text.py -v`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```python
# src/mycli/tools/read/text.py
import os

MAX_LINE_CHARS = 2000
DEFAULT_LIMIT = 2000


def read_text(file_path: str, offset: int = 1, limit: int = DEFAULT_LIMIT) -> dict:
    if not os.path.exists(file_path):
        return {"error": f"[File not found: {file_path}]"}
    if os.path.isdir(file_path):
        return {"error": f"[Path is a directory: {file_path}. Use LS to browse.]"}

    with open(file_path, encoding="utf-8") as f:
        lines = f.readlines()

    total = len(lines)

    # 1-based offset → 0-based index
    start = max(0, offset - 1)
    end = min(start + limit, len(lines))

    shown = lines[start:end]
    truncated = end < total

    result_lines = []
    for i, line in enumerate(shown):
        line_num = start + i + 1
        content = line.rstrip("\n").rstrip("\r")
        if len(content) > MAX_LINE_CHARS:
            content = content[:MAX_LINE_CHARS] + " [... truncated]"
        result_lines.append(f"{line_num:6d}\t{content}")

    output = "\n".join(result_lines) + "\n"
    if truncated:
        output += f"... (output truncated, showing {len(shown)} of {total} lines)\n"

    return {
        "content": output,
        "total_lines": total,
        "shown_lines": len(shown),
        "truncated": truncated,
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/unit/test_read_text.py -v`
Expected: PASS (7 tests)

- [ ] **Step 5: Write L1 size-based test**

```python
# tests/unit/test_read_text.py (add to class)

def test_file_too_large(self, tmp_path):
    f = tmp_path / "huge.py"
    # >60K chars
    f.write_text("x" * 65_000)
    result = read_text(str(f))
    assert "error" in result
    assert "too large" in result["error"].lower()

def test_medium_file_head_tail(self, tmp_path):
    f = tmp_path / "medium.py"
    # 15K-60K chars: head(8K) + tail(4K)
    content = (("line1\n" * 4000) + "\n\n\n" + ("linez\n" * 2000))
    f.write_text(content)
    result = read_text(str(f))
    assert result["truncated"] == True
    assert "... [chars omitted] ..." in result["content"]
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pytest tests/unit/test_read_text.py::TestReadText::test_file_too_large -v`
Expected: FAIL — no size check yet

- [ ] **Step 7: Add L1 size gating to read_text**

```python
def read_text(file_path: str, offset: int = 1, limit: int = DEFAULT_LIMIT) -> dict:
    if not os.path.exists(file_path):
        return {"error": f"[File not found: {file_path}]"}
    if os.path.isdir(file_path):
        return {"error": f"[Path is a directory: {file_path}. Use LS to browse.]"}

    with open(file_path, encoding="utf-8") as f:
        content = f.read()

    total_chars = len(content)

    # 保存原始行数——head_tail 不影响行数报告
    raw_total_lines = content.count("\n") + (0 if content.endswith("\n") else 1)

    # L1: >60K chars → reject
    if total_chars > 60_000:
        return {
            "error": (
                f"[File too large ({total_chars} chars). "
                f"Use offset/limit to read specific sections.]"
            )
        }

    # L1: 15K-60K → head_tail
    if total_chars > 15_000:
        head = content[:8_000]
        tail = content[-4_000:]
        omitted = total_chars - 12_000
        content = f"{head}\n... [{omitted} chars omitted] ...\n{tail}"

    lines = content.split("\n")
    total = raw_total_lines
    start = max(0, offset - 1)
    end = min(start + limit, len(lines))
    shown = lines[start:end]
    truncated = end < total

    result_lines = []
    for i, line in enumerate(shown):
        line_num = start + i + 1
        text = line.rstrip("\n").rstrip("\r")
        if len(text) > MAX_LINE_CHARS:
            text = text[:MAX_LINE_CHARS] + " [... truncated]"
        result_lines.append(f"{line_num:6d}\t{text}")

    output = "\n".join(result_lines) + "\n"
    if truncated:
        output += f"... (output truncated, showing {len(shown)} of {total} lines)\n"

    return {
        "content": output,
        "total_chars": total_chars,
        "total_lines": total,
        "shown_lines": len(shown),
        "truncated": truncated,
    }
```

- [ ] **Step 8: Run all tests**

Run: `pytest tests/unit/test_read_text.py -v`
Expected: PASS (9 tests)

- [ ] **Step 9: Commit**

```bash
git add src/mycli/tools/read/__init__.py src/mycli/tools/read/text.py tests/unit/test_read_text.py
git commit -m "feat: implement Read text handler with L1 size gating

- cat -n style output with 6-digit line numbers
- Default 2000 lines, configurable offset/limit (1-based)
- L1: <15K chars full, 15-60K head_tail, >60K reject
- Lines >2000 chars truncated with marker
- File not found / directory errors with hints"
```

---

### Task A2: Read — CSV handler

**Files:**
- Create: `src/mycli/tools/read/csv_handler.py`
- Create: `tests/unit/test_read_csv.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/unit/test_read_csv.py
import pytest
from mycli.tools.read.csv_handler import read_file as read_csv_handler


class TestReadCSV:
    def test_small_csv(self, tmp_path):
        f = tmp_path / "data.csv"
        f.write_text("name,age,city\nAlice,30,NYC\nBob,25,SF\nCharlie,35,LA\n")
        result = read_csv_handler(str(f))
        assert result["rows"] == 3
        assert result["columns"] == 3
        assert result["headers"] == ["name", "age", "city"]
        assert len(result["preview"]) == 3

    def test_large_csv_head_tail(self, tmp_path):
        f = tmp_path / "large.csv"
        lines = ["id,value"] + [f"{i},{i*2}" for i in range(1, 101)]  # 100 rows
        f.write_text("\n".join(lines))
        result = read_csv_handler(str(f))
        assert result["rows"] == 100
        assert result["truncated"] == True
        assert len(result["preview"]) == 20  # first 20 data rows (header in separate field)
        assert len(result["headers"]) == 2
        assert "tail_preview" in result
        assert len(result["tail_preview"]) == 10  # last 10 rows

    def test_tsv(self, tmp_path):
        f = tmp_path / "data.tsv"
        f.write_text("a\tb\tc\n1\t2\t3\n")
        result = read_csv_handler(str(f))
        assert result["columns"] == 3
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_read_csv.py -v`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```python
# src/mycli/tools/read/csv_handler.py
import csv


def read_file(file_path: str, pages: str | None = None) -> dict:
    delimiter = "\t" if file_path.endswith(".tsv") else ","

    with open(file_path, encoding="utf-8") as f:
        reader = csv.reader(f, delimiter=delimiter)
        rows = list(reader)

    if not rows:
        return {"error": "[Empty file]", "rows": 0, "columns": 0}

    headers = rows[0]
    data = rows[1:]
    total_rows = len(data)
    columns = len(headers)

    if total_rows <= 50:
        return {
            "headers": headers,
            "preview": [dict(zip(headers, r)) for r in data],
            "rows": total_rows,
            "columns": columns,
            "truncated": False,
        }

    return {
        "headers": headers,
        "preview": [dict(zip(headers, r)) for r in data[:20]],
        "tail_preview": [dict(zip(headers, r)) for r in data[-10:]],
        "rows": total_rows,
        "columns": columns,
        "truncated": True,
        "summary": f"[Total: {total_rows} rows x {columns} columns. Showing first 20 + last 10 rows.]",
    }
```

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_read_csv.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mycli/tools/read/csv_handler.py tests/unit/test_read_csv.py
git commit -m "feat: add CSV/TSV handler for Read tool

- Parses CSV and TSV (auto-detect by extension)
- Small files (<50 rows): full preview
- Large files: first 20 + last 10 rows with summary"
```

---

### Task A3: Read — dispatcher

**Files:**
- Modify: `src/mycli/tools/read/__init__.py`
- Create: `tests/unit/test_read_dispatch.py`

- [ ] **Step 1: Write test**

```python
# tests/unit/test_read_dispatch.py
from mycli.tools.read import read_file


class TestReadDispatch:
    def test_dispatches_text(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("hello world\n")
        result = read_file(str(f))
        assert "error" not in result

    def test_dispatches_csv(self, tmp_path):
        f = tmp_path / "data.csv"
        f.write_text("a,b\n1,2\n")
        result = read_file(str(f))
        assert result["rows"] == 1

    def test_unknown_binary(self, tmp_path):
        f = tmp_path / "test.bin"
        f.write_bytes(b"\x00\x01\x02\xff\xfe\xfd")
        result = read_file(str(f))
        assert "error" in result
        assert "Cannot read binary file" in result["error"]

    def test_pdf_pages_param(self, tmp_path):
        result = read_file(str(tmp_path / "doc.pdf"), pages="1-5")
        # PDF handler not installed → graceful fallback
        assert result is not None
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_read_dispatch.py -v`
Expected: FAIL — module not found

- [ ] **Step 3: Write dispatcher**

```python
# src/mycli/tools/read/__init__.py
import os

TEXT_EXTENSIONS = {
    ".py", ".js", ".ts", ".go", ".rs", ".java", ".c", ".cpp", ".h",
    ".json", ".yaml", ".toml", ".xml", ".html", ".css",
    ".sh", ".bash", ".zsh", ".conf", ".ini", ".cfg", ".env",
    ".txt", ".log", ".md", ".mdx", ".markdown", ".rst", ".tex",
    ".sql", ".rb", ".php", ".swift", ".kt", ".scala", ".r", ".lua", ".zig",
}

HANDLER_MAP = {
    ".csv": "mycli.tools.read.csv_handler",
    ".tsv": "mycli.tools.read.csv_handler",
    ".xlsx": "mycli.tools.read.excel_handler",
    ".xls": "mycli.tools.read.excel_handler",
    ".pdf": "mycli.tools.read.pdf_handler",
    ".docx": "mycli.tools.read.docx_handler",
    ".ipynb": "mycli.tools.read.ipynb_handler",
}

LAZY_IMPORTS: dict[str, object] = {}


def _get_handler(ext: str):
    module_path = HANDLER_MAP.get(ext)
    if not module_path:
        return None
    if module_path not in LAZY_IMPORTS:
        import importlib
        mod = importlib.import_module(module_path)
        LAZY_IMPORTS[module_path] = mod
    return LAZY_IMPORTS[module_path]


def read_file(file_path: str, offset: int = 1, limit: int = 2000,
              pages: str | None = None) -> dict:
    if not os.path.exists(file_path):
        return {"error": f"[File not found: {file_path}]"}
    if os.path.isdir(file_path):
        return {"error": f"[Path is a directory: {file_path}. Use LS to browse.]"}

    ext = os.path.splitext(file_path)[1].lower()

    # Text files
    if ext in TEXT_EXTENSIONS or ext == "":
        from mycli.tools.read.text import read_text
        return read_text(file_path, offset=offset, limit=limit)

    # Structured handlers
    handler_mod = _get_handler(ext)
    if handler_mod:
        try:
            return handler_mod.read_file(file_path, pages=pages)
        except ImportError:
            return {
                "error": (
                    f"[{ext} support not installed. "
                    f"Install required dependency to read this file type.]"
                ),
            }

    # Unknown: try UTF-8, then latin-1, then give up
    try:
        with open(file_path, encoding="utf-8") as f:
            f.read(1)
        from mycli.tools.read.text import read_text
        return read_text(file_path, offset=offset, limit=limit)
    except UnicodeDecodeError:
        try:
            with open(file_path, encoding="latin-1") as f:
                f.read(1)
            from mycli.tools.read.text import read_text
            return read_text(file_path, offset=offset, limit=limit)
        except UnicodeDecodeError:
            return {
                "error": (
                    f"[Cannot read binary file: {file_path}. "
                    f"Detected as non-text format.]"
                ),
            }
```

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_read_dispatch.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mycli/tools/read/__init__.py tests/unit/test_read_dispatch.py
git commit -m "feat: add Read file dispatcher with format auto-detection

- Routes to text, CSV, PDF, Excel, Word, Jupyter handlers by extension
- Unknown files: tries UTF-8 then latin-1, falls back to error
- Lazy imports: structured format handlers loaded on first use
- Graceful fallback when optional dependencies missing"
```

---

### Task A4: Edit — search-and-replace engine

**Files:**
- Create: `src/mycli/tools/edit.py`
- Create: `tests/unit/test_edit.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/unit/test_edit.py
import pytest
from mycli.tools.edit import edit_file, EditError


class TestEdit:
    def test_basic_replace(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("hello = 'world'\n")
        edit_file(str(f), "hello = 'world'", "hello = 'universe'")
        assert f.read_text() == "hello = 'universe'\n"

    def test_unique_match_required(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("x = 1\nx = 1\n")
        with pytest.raises(EditError, match="Multiple matches"):
            edit_file(str(f), "x = 1", "x = 2")

    def test_zero_match(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("hello\n")
        with pytest.raises(EditError, match="String not found"):
            edit_file(str(f), "nonexistent", "replacement")

    def test_append_to_file_end(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("def foo():\n    pass\n}\n")
        edit_file(str(f), "}", "}\ndef bar():\n    pass\n")
        assert "def bar():" in f.read_text()

    def test_delete(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("line1\nline2\nline3\n")
        edit_file(str(f), "line2\n", "")
        assert f.read_text() == "line1\nline3\n"

    def test_replace_all(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("foo\nbar\nfoo\n")
        edit_file(str(f), "foo", "baz", replace_all=True)
        assert f.read_text() == "baz\nbar\nbaz\n"

    def test_file_not_found_with_nonempty_old(self, tmp_path):
        with pytest.raises(EditError, match="File does not exist"):
            edit_file(str(tmp_path / "nope.py"), "something", "else")

    def test_empty_old_creates_file(self, tmp_path):
        f = tmp_path / "new.py"
        edit_file(str(f), "", "#!/usr/bin/env python\n")
        assert f.exists()
        assert f.read_text() == "#!/usr/bin/env python\n"

    def test_empty_old_with_existing_content(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("existing\n")
        with pytest.raises(EditError, match="File has existing content"):
            edit_file(str(f), "", "new content")

    def test_line_number_stripping(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("def foo():\n    return 1\n")
        # Model copies from Read output with line numbers
        edit_file(str(f), "     1\tdef foo():\n     2\t    return 1",
                  "def foo():\n    return 42")
        assert "return 42" in f.read_text()
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_edit.py -v`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```python
# src/mycli/tools/edit.py
import os
import re


class EditError(Exception):
    pass


def edit_file(file_path: str, old_string: str, new_string: str,
              replace_all: bool = False) -> dict:
    old_string = _preprocess(old_string, file_path)

    if old_string == "":
        if not os.path.exists(file_path):
            os.makedirs(os.path.dirname(file_path) or ".", exist_ok=True)
            with open(file_path, "w") as f:
                f.write(new_string)
            return {"status": "created", "file": file_path}
        with open(file_path) as f:
            content = f.read()
        if content.strip():
            raise EditError(
                "File has existing content. Use Edit with old_string to modify, "
                "or Write to overwrite the entire file."
            )
        with open(file_path, "w") as f:
            f.write(new_string)
        return {"status": "written", "file": file_path}

    if not os.path.exists(file_path):
        raise EditError(f"File does not exist: {file_path}")

    with open(file_path) as f:
        content = f.read()

    count = content.count(old_string)
    if count == 0:
        raise EditError(
            f"String not found in file. The file may have changed since "
            f"you last read it. Re-read the file and try again."
        )
    if count > 1 and not replace_all:
        raise EditError(
            f"Multiple matches ({count}) found. Add more surrounding context "
            f"to make the old_string unique (include 3-5 lines before and after)."
        )

    new_content = content.replace(old_string, new_string) if replace_all \
        else content.replace(old_string, new_string, 1)

    if new_string == "":
        new_content = _remove_trailing_newline_after_deletion(content, old_string)

    _backup(file_path, content)
    with open(file_path, "w") as f:
        f.write(new_content)

    return {"status": "edited", "file": file_path, "matches": count if replace_all else 1}


LINE_NUMBER_PATTERN = re.compile(r"^\s*\d+\t", re.MULTILINE)


def _preprocess(text: str, file_path: str) -> str:
    # Strip line numbers that model copied from Read output
    text = LINE_NUMBER_PATTERN.sub("", text)
    # Strip trailing whitespace (except .md/.mdx)
    if not file_path.endswith((".md", ".mdx")):
        text = text.rstrip()
    return text


def _remove_trailing_newline_after_deletion(original: str, deleted: str) -> str:
    pos = original.find(deleted)
    if pos < 0:
        return original.replace(deleted, "")
    end = pos + len(deleted)
    result = original[:pos] + original[end:]
    if result.startswith("\n") and pos == 0:
        result = result[1:]
    return result


def _backup(file_path: str, content: str) -> None:
    # Placeholder — will be replaced by file_history service in Phase 3
    backup_dir = os.path.join(os.path.dirname(file_path), ".mycli_backups")
    os.makedirs(backup_dir, exist_ok=True)
    backup_path = os.path.join(backup_dir, os.path.basename(file_path) + ".bak")
    with open(backup_path, "w") as f:
        f.write(content)
```

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_edit.py -v`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mycli/tools/edit.py tests/unit/test_edit.py
git commit -m "feat: implement Edit tool with unique-match safety

- old_string must be unique (0 matches=error, 2+=ambiguous)
- Line number stripping from Read output copies
- Trailing whitespace normalization (except .md/.mdx)
- Delete mode: new_string='' removes old_string + trailing newline
- Replace all mode for batch changes
- Empty old_string creates new file or errors on existing content
- Pre-edit backup for undo support"
```

---

### Task A5: Write — file creator

**Files:**
- Create: `src/mycli/tools/write.py`
- Create: `tests/unit/test_write.py`

- [ ] **Step 1: Write test**

```python
# tests/unit/test_write.py
import pytest
from mycli.tools.write import write_file


class TestWrite:
    def test_create_new_file(self, tmp_path):
        f = tmp_path / "new.py"
        result = write_file(str(f), "print('hello')\n")
        assert f.exists()
        assert f.read_text() == "print('hello')\n"
        assert result["status"] == "created"

    def test_overwrite_existing(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("old\n")
        result = write_file(str(f), "new\n")
        assert f.read_text() == "new\n"
        assert result["status"] == "overwritten"

    def test_autocreate_parent_dir(self, tmp_path):
        f = tmp_path / "deep" / "nested" / "file.py"
        result = write_file(str(f), "content\n")
        assert f.exists()

    def test_unchanged_noop(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("same\n")
        result = write_file(str(f), "same\n")
        assert result["status"] == "unchanged"
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_write.py -v`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```python
# src/mycli/tools/write.py
import os


def write_file(file_path: str, content: str) -> dict:
    os.makedirs(os.path.dirname(file_path) or ".", exist_ok=True)
    file_existed = os.path.exists(file_path)

    if file_existed:
        with open(file_path) as f:
            existing = f.read()
        if existing == content:
            return {"status": "unchanged", "file": file_path}
        _backup(file_path, existing)

    with open(file_path, "w") as f:
        f.write(content)

    status = "overwritten" if file_existed else "created"
    return {"status": status, "file": file_path}


def _backup(file_path: str, content: str) -> None:
    backup_dir = os.path.join(os.path.dirname(file_path) or ".", ".mycli_backups")
    os.makedirs(backup_dir, exist_ok=True)
    backup_path = os.path.join(backup_dir, os.path.basename(file_path) + ".bak")
    with open(backup_path, "w") as f:
        f.write(content)
```

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_write.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mycli/tools/write.py tests/unit/test_write.py
git commit -m "feat: implement Write tool for file creation and overwrite

- Auto-creates parent directories
- Detects unchanged content (no-op)
- Backs up existing content before overwrite"
```

---

## Phase A Completion Check

- [ ] `pytest tests/unit/test_read_text.py tests/unit/test_read_csv.py tests/unit/test_read_dispatch.py tests/unit/test_edit.py tests/unit/test_write.py -v` passes
- [ ] Read handles: text (py/js/go+), CSV, TSV, unknown binary
- [ ] Read L1: <15K full, 15-60K head_tail, >60K reject
- [ ] Edit: unique matching, 0/2+ errors, delete mode, replace_all, line number stripping
- [ ] Write: create, overwrite, no-op detection, auto-mkdir
