from __future__ import annotations

from mycli.domain.tooling.calls import ToolEvidence
from mycli.services.context.tool_result_formatter import ToolResultFormatter
from mycli.tools.base import ToolResultV2


def test_read_file_gets_higher_limit() -> None:
    formatter = ToolResultFormatter()
    assert formatter._limit_for("read_file") == 8000
    assert formatter._limit_for("read_file_range") == 6000
    assert formatter._limit_for("run_shell") == 500
    assert formatter._limit_for("unknown_tool") == 1600


def test_run_shell_shows_tail() -> None:
    formatter = ToolResultFormatter()
    lines = [f"line {index}" for index in range(100)]
    result = ToolResultV2(
        success=True,
        summary="Command exited with 0",
        raw_payload={"stdout": "\n".join(lines), "stderr": ""},
    )
    output = formatter.format("run_shell", result)
    assert "last 10 of 100 lines" in output
    assert "line 99" in output
    assert "命令执行完毕" in output


def test_search_text_includes_total_count_and_termination() -> None:
    formatter = ToolResultFormatter()
    result = ToolResultV2(
        success=True,
        summary="Found 48 matches",
        raw_payload={
            "matches": [
                {"path": "a.py", "line_number": 1, "line": "import os"},
                {"path": "b.py", "line_number": 5, "line": "from sys import argv"},
            ]
            * 24,
        },
    )
    output = formatter.format("search_text", result)
    assert "48 total" in output
    assert "搜索完毕" in output


def test_search_shows_max_10_matches() -> None:
    formatter = ToolResultFormatter(search_max_matches=10)
    matches = [
        {"path": f"f{index}.py", "line_number": index, "line": f"code {index}"}
        for index in range(20)
    ]
    result = ToolResultV2(
        success=True,
        summary="Found 20 matches",
        raw_payload={"matches": matches},
    )
    output = formatter.format("search_text", result)
    assert output.count(": code ") == 10


def test_list_directory_structured_summary() -> None:
    formatter = ToolResultFormatter()
    result = ToolResultV2(
        success=True,
        summary="README.md, docs, pyproject.toml, scripts, src, tests",
        raw_payload={
            "entries": [
                "README.md",
                "docs",
                "pyproject.toml",
                "scripts",
                "src",
                "tests",
                "vendor",
                "uv.lock",
                "AGENTS.md",
                ".gitignore",
                "tmp",
            ],
        },
    )
    output = formatter.format("list_directory", result)
    assert "Total entries: 11" in output
    assert "README.md, docs, pyproject.toml" in output
    assert "... and 1 more" in output


def test_read_file_adds_completion_notice_when_not_truncated() -> None:
    formatter = ToolResultFormatter()
    short_content = "def hello():\n    return 'world'\n"
    result = ToolResultV2(
        success=True,
        summary="Read file.py",
        raw_payload={"path": "file.py", "content": short_content},
    )
    output = formatter.format("read_file", result)
    assert "文件读取完毕" in output


def test_read_file_adds_truncation_notice_when_long() -> None:
    formatter = ToolResultFormatter()
    long_content = "x = 1\n" * 2000
    result = ToolResultV2(
        success=True,
        summary="Read large.py",
        raw_payload={"path": "large.py", "content": long_content},
    )
    output = formatter.format("read_file", result)
    assert "文件内容较长，已截断" in output


def test_read_file_evidence_keeps_medium_file_complete() -> None:
    formatter = ToolResultFormatter()
    content = "a = 1\n" * 200 + "UNIQUE_READ_FILE_END = True\n"
    result = ToolResultV2(
        success=True,
        summary="Read medium.py",
        raw_payload={"path": "medium.py", "content": content},
        evidence=(
            ToolEvidence(
                kind="file_excerpt",
                title="medium.py",
                path="medium.py",
                line_start=1,
                line_end=201,
                snippet=content,
            ),
        ),
    )
    output = formatter.format("read_file", result)
    assert "UNIQUE_READ_FILE_END" in output
    assert "文件读取完毕" in output
    assert "文件内容较长，已截断" not in output


def test_read_file_range_evidence_keeps_medium_range_complete() -> None:
    formatter = ToolResultFormatter()
    content = "value = 1\n" * 300 + "UNIQUE_RANGE_END = True\n"
    result = ToolResultV2(
        success=True,
        summary="Read lines 20-321 from medium.py",
        raw_payload={
            "path": "medium.py",
            "start_line": 20,
            "end_line": 321,
            "actual_start_line": 20,
            "actual_end_line": 321,
            "content": content,
        },
        evidence=(
            ToolEvidence(
                kind="file_excerpt",
                title="medium.py:20-321",
                path="medium.py",
                line_start=20,
                line_end=321,
                snippet=content,
            ),
        ),
    )
    output = formatter.format("read_file_range", result)
    assert "UNIQUE_RANGE_END" in output
    assert "文件读取完毕" in output
    assert "文件内容较长，已截断" not in output


def test_hard_truncation_at_max_chars() -> None:
    formatter = ToolResultFormatter(read_file_max_chars=500)
    long_content = "abcdefg" * 200
    result = ToolResultV2(
        success=True,
        summary="Read huge.py",
        raw_payload={"path": "huge.py", "content": long_content},
    )
    output = formatter.format("read_file", result)
    assert len(output) <= 500


def test_fallback_returns_summary_only() -> None:
    formatter = ToolResultFormatter()
    result = ToolResultV2(
        success=True,
        summary="Done something",
        raw_payload={},
    )
    output = formatter.format("unknown_tool", result)
    assert output == "Done something"
