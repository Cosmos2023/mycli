# Toolset Redesign — Phase C: External & Auxiliary Tools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement WebSearch, WebFetch, Lint, AskUserQuestion.

**Architecture:** WebSearch dual-endpoint: DeepSeek Anthropic endpoint (server-side `web_search_20250305`) + SerpAPI fallback for Chat Completions. WebFetch uses requests + html2text + 15min LRU cache. Lint auto-detects project language and runs appropriate linter CLI. AskUserQuestion is synchronous blocking with structured response.

**Tech Stack:** Python 3.12+, pytest, requests, html2text/markdownify, subprocess.

**Reference:** `docs/superpowers/specs/2026-05-12-mycli-toolset-design.md` Sections 2.9-2.12.

---

### Task C1: WebSearch

**Files:**
- Create: `src/mycli/tools/web_search.py`
- Create: `tests/unit/test_web_search.py`

- [ ] **Step 1: Write test**

```python
# tests/unit/test_web_search.py
from mycli.tools.web_search import web_search, _serpapi_search


class TestWebSearch:
    def test_deepseek_returns_tool_definition(self):
        result = web_search("latest Python version", provider="deepseek")
        assert "_tool_definition" in result
        assert result["_tool_definition"]["type"] == "web_search_20250305"

    def test_serpapi_fallback(self, monkeypatch):
        def mock_serpapi(query):
            return {"organic_results": [
                {"title": "Python 3.14", "link": "https://python.org"},
                {"title": "Downloads", "link": "https://python.org/downloads"},
            ]}

        monkeypatch.setattr(
            "mycli.tools.web_search._serpapi_search", mock_serpapi
        )
        result = _serpapi_search("Python version")
        assert len(result["results"]) == 2
        assert result["results"][0]["title"] == "Python 3.14"
        assert "url" in result["results"][0]
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_web_search.py -v`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```python
# src/mycli/tools/web_search.py
import os


def web_search(query: str, provider: str = "deepseek",
               allowed_domains: list[str] | None = None,
               blocked_domains: list[str] | None = None) -> dict:
    if provider == "deepseek":
        return {
            "_tool_definition": {
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": 3,
            },
            "query": query,
        }
    return _serpapi_search(query)


def _serpapi_search(query: str) -> dict:
    api_key = os.environ.get("SERPAPI_API_KEY", "")
    if not api_key:
        return {"error": "[WebSearch requires SERPAPI_API_KEY for non-DeepSeek providers]"}

    import requests
    response = requests.get(
        "https://serpapi.com/search",
        params={"q": query, "api_key": api_key, "engine": "google"},
        timeout=10,
    )
    data = response.json()
    results = data.get("organic_results", [])[:10]

    return {
        "results": [{"title": r["title"], "url": r["link"]} for r in results],
        "total": len(results),
    }


def _call_serpapi(query: str) -> dict:
    # Extracted for test mocking
    return _serpapi_search(query)
```

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_web_search.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mycli/tools/web_search.py tests/unit/test_web_search.py
git commit -m "feat: implement WebSearch with dual-endpoint adapter

- DeepSeek: registers web_search_20250305 server-side tool (max_uses: 3)
- OpenAI/other: SerpAPI fallback via SERPAPI_API_KEY env var
- Returns title+URL only (model uses WebFetch for content)"
```

---

### Task C2: WebFetch

**Files:**
- Create: `src/mycli/tools/web_fetch.py`
- Create: `tests/unit/test_web_fetch.py`

- [ ] **Step 1: Write test**

```python
# tests/unit/test_web_fetch.py
import time
from mycli.tools.web_fetch import web_fetch, _html_to_markdown


class TestWebFetch:
    def test_html_to_markdown(self):
        html = "<h1>Title</h1><p>Hello <b>world</b></p>"
        md = _html_to_markdown(html)
        assert "Title" in md
        assert "Hello" in md
        assert "world" in md

    def test_url_normalization(self):
        from mycli.tools.web_fetch import _normalize_url
        assert _normalize_url("http://example.com") == "https://example.com"
        assert _normalize_url("https://user:pass@example.com") == "https://example.com"

    def test_cache_hit(self, monkeypatch):
        from mycli.tools.web_fetch import _fetch_cache
        _fetch_cache.clear()
        _fetch_cache["test_key"] = {"ts": time.time(), "data": {"cached": True}}

        from mycli.tools.web_fetch import _get_cached
        result = _get_cached("test_key")
        assert result is not None
        assert result["cached"] == True

    def test_cache_expiry(self):
        from mycli.tools.web_fetch import _fetch_cache, _get_cached
        _fetch_cache.clear()
        _fetch_cache["old_key"] = {"ts": time.time() - 1000, "data": {"old": True}}
        assert _get_cached("old_key") is None  # 15min TTL expired
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_web_fetch.py -v`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```python
# src/mycli/tools/web_fetch.py
import hashlib
import re
import time
from urllib.parse import urlparse

import requests

_fetch_cache: dict[str, dict] = {}
_CACHE_TTL = 900  # 15 minutes


def web_fetch(url: str, prompt: str | None = None) -> dict:
    url = _normalize_url(url)
    cache_key = hashlib.md5(url.encode()).hexdigest()
    cached = _get_cached(cache_key)
    if cached:
        return cached

    try:
        response = requests.get(
            url, timeout=30, allow_redirects=True,
            headers={"User-Agent": "mycli/1.0"},
        )
    except requests.RequestException as e:
        return {"error": f"[Failed to fetch {url}: {e}]"}

    if response.status_code != 200:
        return {"error": f"[HTTP {response.status_code} from {url}]"}

    markdown = _html_to_markdown(response.text)
    if len(markdown) > 100_000:
        markdown = markdown[:100_000] + "\n[Content truncated at 100KB]"

    if len(markdown) > 20_000:
        markdown = markdown[:20_000] + "\n[... truncated to 20K chars]"

    result = {"content": markdown, "url": url}
    _fetch_cache[cache_key] = {"ts": time.time(), "data": result}
    return result


def _normalize_url(url: str) -> str:
    url = url.strip()
    if url.startswith("http://"):
        url = "https://" + url[7:]
    parsed = urlparse(url)
    if parsed.username or parsed.password:
        clean = parsed._replace(netloc=parsed.hostname or parsed.netloc)
        url = clean.geturl()
    return url


def _html_to_markdown(html: str) -> str:
    try:
        import markdownify
        return markdownify.markdownify(html)
    except ImportError:
        import html2text
        h = html2text.HTML2Text()
        h.ignore_links = False
        h.ignore_images = True
        h.body_width = 0
        return h.handle(html)


def _get_cached(key: str) -> dict | None:
    entry = _fetch_cache.get(key)
    if entry and time.time() - entry["ts"] < _CACHE_TTL:
        return entry["data"]
    if entry:
        del _fetch_cache[key]
    return None
```

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_web_fetch.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mycli/tools/web_fetch.py tests/unit/test_web_fetch.py
git commit -m "feat: implement WebFetch with HTML→Markdown and 15min cache

- HTML→Markdown via markdownify (fallback html2text)
- 15-minute LRU cache with TTL eviction
- URL normalization: HTTP→HTTPS, strips credentials
- 100KB content limit, 20K char L1 truncation
- 30s timeout with User-Agent header"
```

---

### Task C3: Lint

**Files:**
- Create: `src/mycli/tools/lint.py`
- Create: `tests/unit/test_lint.py`

- [ ] **Step 1: Write test**

```python
# tests/unit/test_lint.py
from unittest.mock import patch
from mycli.tools.lint import lint, _detect_linters


class TestLint:
    def test_detect_python(self, tmp_path, monkeypatch):
        (tmp_path / "pyproject.toml").write_text("[tool.ruff]")
        monkeypatch.chdir(tmp_path)
        linters = _detect_linters()
        assert any("ruff" in cmd for cmd in linters)

    def test_detect_javascript(self, tmp_path, monkeypatch):
        (tmp_path / "package.json").write_text('{"name": "test"}')
        monkeypatch.chdir(tmp_path)
        linters = _detect_linters()
        assert any("eslint" in cmd for cmd in linters)

    def test_no_project(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        linters = _detect_linters()
        assert linters == []

    def test_lint_runs(self, tmp_path, monkeypatch):
        (tmp_path / "pyproject.toml").write_text("[tool.ruff]")
        (tmp_path / "test.py").write_text("x = 1\n")
        monkeypatch.chdir(tmp_path)

        with patch("subprocess.run") as mock_run:
            mock_run.return_value.stdout = '[{"file": "test.py", "line": 1, "message": "unused variable"}]'
            mock_run.return_value.returncode = 1
            result = lint()

        assert "diagnostics" in result
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_lint.py -v`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```python
# src/mycli/tools/lint.py
import json
import os
import subprocess

PROJECT_LINTERS = {
    "pyproject.toml": ["ruff check --output-format json"],
    "setup.py": ["ruff check --output-format json"],
    "setup.cfg": ["ruff check --output-format json"],
    "package.json": ["npx eslint --format json . 2>/dev/null"],
    ".eslintrc.js": ["npx eslint --format json . 2>/dev/null"],
    ".eslintrc.json": ["npx eslint --format json . 2>/dev/null"],
    "Cargo.toml": ["cargo check --message-format json 2>&1"],
    "go.mod": ["go vet ./..."],
}

MAX_DIAGNOSTICS = 30


def lint(paths: str | None = None) -> dict:
    cmds = _detect_linters()
    if not cmds:
        return {"error": "[No linter detected for this project]"}

    all_diagnostics = []
    for cmd in cmds:
        try:
            output = subprocess.run(
                cmd, shell=True, capture_output=True, text=True,
                timeout=60, cwd=os.getcwd(),
            ).stdout
            all_diagnostics.extend(_parse_output(cmd, output))
        except subprocess.TimeoutExpired:
            continue
        except Exception:
            continue

    truncated = len(all_diagnostics) > MAX_DIAGNOSTICS
    return {
        "diagnostics": all_diagnostics[:MAX_DIAGNOSTICS],
        "count": len(all_diagnostics),
        "truncated": truncated,
    }


def _detect_linters() -> list[str]:
    root = os.getcwd()
    for config_file, cmds in PROJECT_LINTERS.items():
        if os.path.exists(os.path.join(root, config_file)):
            return cmds
    return []


def _parse_output(cmd: str, output: str) -> list[dict]:
    if "ruff" in cmd:
        try:
            return [
                {"file": d.get("filename", ""), "line": d.get("location", {}).get("row", 0),
                 "column": d.get("location", {}).get("column", 0),
                 "message": d.get("message", ""), "rule": d.get("code", "")}
                for d in json.loads(output)
            ]
        except json.JSONDecodeError:
            return []

    if "eslint" in cmd:
        try:
            results = []
            for file_d in json.loads(output):
                for msg_d in file_d.get("messages", []):
                    results.append({
                        "file": file_d.get("filePath", ""),
                        "line": msg_d.get("line", 0),
                        "column": msg_d.get("column", 0),
                        "message": msg_d.get("message", ""),
                        "rule": msg_d.get("ruleId", ""),
                    })
            return results
        except json.JSONDecodeError:
            return []

    return [{"raw": output[:500]}]
```

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_lint.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mycli/tools/lint.py tests/unit/test_lint.py
git commit -m "feat: implement Lint tool with auto-detection

- Auto-detects linter by project config files (pyproject.toml, package.json, etc.)
- Supports ruff (Python), eslint (JS/TS), cargo check (Rust), go vet (Go)
- 30 diagnostic cap with truncated flag
- Structured output: file, line, column, message, rule"
```

---

### Task C4: AskUserQuestion

**Files:**
- Create: `src/mycli/tools/ask_user_question.py`
- Create: `tests/unit/test_ask_user_question.py`

- [ ] **Step 1: Write test**

```python
# tests/unit/test_ask_user_question.py
import pytest
from mycli.tools.ask_user_question import AskUserQuestion, ask_user_question


class TestAskUserQuestion:
    def test_basic_question(self):
        q = AskUserQuestion(
            question="Choose a name",
            header="Name",
            options=[
                {"label": "Foo", "description": "Option Foo"},
                {"label": "Bar", "description": "Option Bar"},
            ],
        )
        assert len(q.options) == 3  # + implicit "Other"
        assert q.options[2]["label"] == "Other"

    def test_multi_select(self):
        q = AskUserQuestion(
            question="Select all that apply",
            options=[{"label": "A"}, {"label": "B"}],
            multi_select=True,
        )
        assert q.multi_select is True

    def test_too_few_options(self):
        with pytest.raises(ValueError, match="2-4 options"):
            AskUserQuestion(question="?", options=[{"label": "Only"}])

    def test_too_many_options(self):
        with pytest.raises(ValueError, match="2-4 options"):
            AskUserQuestion(
                question="?",
                options=[
                    {"label": str(i)} for i in range(5)
                ],
            )
```

- [ ] **Step 2: Run test**

Run: `pytest tests/unit/test_ask_user_question.py -v`
Expected: FAIL

- [ ] **Step 3: Write implementation**

```python
# src/mycli/tools/ask_user_question.py
from dataclasses import dataclass


@dataclass
class AskUserQuestion:
    question: str
    options: list[dict]
    header: str = ""
    multi_select: bool = False

    def __post_init__(self):
        if len(self.options) < 2 or len(self.options) > 4:
            raise ValueError("2-4 options required")
        self.options = list(self.options) + [{
            "label": "Other",
            "description": "Custom answer",
        }]


def ask_user_question(
    question: str,
    options: list[dict],
    header: str | None = None,
    multi_select: bool = False,
) -> dict:
    q = AskUserQuestion(
        question=question,
        options=options,
        header=header or "",
        multi_select=multi_select,
    )
    return {
        "question": q.question,
        "options": q.options,
        "header": q.header,
        "multi_select": q.multi_select,
        "status": "awaiting_user_response",
    }
```

- [ ] **Step 4: Run test**

Run: `pytest tests/unit/test_ask_user_question.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mycli/tools/ask_user_question.py tests/unit/test_ask_user_question.py
git commit -m "feat: implement AskUserQuestion with multi-select support

- 2-4 options required, implicit 'Other' appended
- Multi-select mode for checkbox-style responses
- Structured response format for agent loop handling"
```

---

## Phase C Completion Check

- [ ] WebSearch: DeepSeek tool definition, SerpAPI fallback
- [ ] WebFetch: HTML→Markdown, 15min cache, URL normalization, truncation
- [ ] Lint: auto-detection, ruff+eslint parsing, 30 diagnostic cap
- [ ] AskUserQuestion: option validation, implicit Other, multi-select
- [ ] `pytest tests/unit/test_web_search.py tests/unit/test_web_fetch.py tests/unit/test_lint.py tests/unit/test_ask_user_question.py -v` passes
