from __future__ import annotations

from mycli.domain.tooling.calls import ToolEvidence
from mycli.services.context.tool_result_formatter import ToolResultFormatter
from mycli.tools.base import ToolResult


def test_read_file_gets_higher_limit() -> None:
    formatter = ToolResultFormatter()
    assert formatter._limit_for("Read") == 8000
    assert formatter._limit_for("Bash") == 500
    assert formatter._limit_for("unknown_tool") == 1600


def test_run_shell_shows_tail() -> None:
    formatter = ToolResultFormatter()
    lines = [f"line {index}" for index in range(100)]
    result = ToolResult(
        success=True,
        summary="Command exited with 0",
        raw_payload={
            "exit_code": 0,
            "stdout": "\n".join(lines),
            "stderr": "",
            "cwd": "/tmp/workspace",
            "duration_ms": 12,
            "command_pattern": "python3 -c",
        },
    )
    output = formatter.format("Bash", result)
    assert "Exit code: 0" in output
    assert "Cwd: /tmp/workspace" in output
    assert "Command pattern: python3 -c" in output
    assert "Output:" in output
    assert "showing first 20 of 100 lines" in output
    assert "line 0" in output
    assert "line 99" not in output


def test_run_shell_failure_shows_diagnostics_and_tail() -> None:
    formatter = ToolResultFormatter(run_shell_max_chars=1200)
    result = ToolResult(
        success=False,
        summary="Command exited with 7",
        error="bad",
        raw_payload={
            "exit_code": 7,
            "stdout": "",
            "stderr": "bad\nmore detail",
            "output": "[stderr]\nbad\nmore detail\n[stdout]\n",
            "cwd": "/tmp/workspace",
            "duration_ms": 5,
            "error_kind": "nonzero_exit",
            "truncated": True,
            "truncated_chars": 42,
        },
    )

    output = formatter.format("Bash", result)

    assert "Exit code: 7" in output
    assert "Error kind: nonzero_exit" in output
    assert "Note: output truncated before formatting; 42 chars omitted." in output
    assert "bad" in output


def test_bash_output_renders_incremental_output_and_status() -> None:
    formatter = ToolResultFormatter(run_shell_max_chars=1200)
    result = ToolResult(
        success=True,
        summary="Read shell shell_123 output",
        raw_payload={
            "shell_id": "shell_123",
            "status": "running",
            "process_state": "running_background",
            "output": "ready\nprogress 50%\n",
            "new_output_chars": 19,
        },
    )

    output = formatter.format("BashOutput", result)

    assert "Shell ID: shell_123" in output
    assert "Status: running" in output
    assert "Process state: running_background" in output
    assert "ready" in output
    assert "progress 50%" in output


def test_search_text_includes_total_count_and_termination() -> None:
    formatter = ToolResultFormatter()
    result = ToolResult(
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
    output = formatter.format("Grep", result)
    assert "48 total" in output
    assert "搜索完毕" in output


def test_search_shows_max_10_matches() -> None:
    formatter = ToolResultFormatter(search_max_matches=10)
    matches = [
        {"path": f"f{index}.py", "line_number": index, "line": f"code {index}"}
        for index in range(20)
    ]
    result = ToolResult(
        success=True,
        summary="Found 20 matches",
        raw_payload={"matches": matches},
    )
    output = formatter.format("Grep", result)
    assert output.count(": code ") == 10


def test_list_directory_structured_summary() -> None:
    formatter = ToolResultFormatter()
    result = ToolResult(
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
    output = formatter.format("LS", result)
    assert "Total entries: 11" in output
    assert "README.md, docs, pyproject.toml" in output
    assert "... and 1 more" in output


def test_read_file_adds_completion_notice_when_not_truncated() -> None:
    formatter = ToolResultFormatter()
    short_content = "def hello():\n    return 'world'\n"
    result = ToolResult(
        success=True,
        summary="Read file.py",
        raw_payload={"path": "file.py", "content": short_content},
    )
    output = formatter.format("Read", result)
    assert "Note: file read complete." in output


def test_read_file_adds_truncation_notice_when_long() -> None:
    formatter = ToolResultFormatter()
    long_content = "x = 1\n" * 2000
    result = ToolResult(
        success=True,
        summary="Read large.py",
        raw_payload={"path": "large.py", "content": long_content},
    )
    output = formatter.format("Read", result)
    assert "Note: output truncated; use Read with offset/limit to continue." in output
    assert "Read with offset/limit" in output


def test_read_file_evidence_keeps_medium_file_complete() -> None:
    formatter = ToolResultFormatter()
    content = "a = 1\n" * 200 + "UNIQUE_READ_FILE_END = True\n"
    result = ToolResult(
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
    output = formatter.format("Read", result)
    assert "UNIQUE_READ_FILE_END" in output
    assert "Note: file read complete." in output
    assert "Note: output truncated" not in output


def test_read_file_offset_limit_evidence_keeps_medium_range_complete() -> None:
    formatter = ToolResultFormatter()
    content = "value = 1\n" * 300 + "UNIQUE_RANGE_END = True\n"
    result = ToolResult(
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
    output = formatter.format("Read", result)
    assert "UNIQUE_RANGE_END" in output
    assert "Note: file read complete." in output
    assert "Note: output truncated" not in output


def test_hard_truncation_at_max_chars() -> None:
    formatter = ToolResultFormatter(read_file_max_chars=500)
    long_content = "abcdefg" * 200
    result = ToolResult(
        success=True,
        summary="Read huge.py",
        raw_payload={"path": "huge.py", "content": long_content},
    )
    output = formatter.format("Read", result)
    assert len(output) <= 500


def test_fallback_returns_summary_only() -> None:
    formatter = ToolResultFormatter()
    result = ToolResult(
        success=True,
        summary="Done something",
        raw_payload={},
    )
    output = formatter.format("unknown_tool", result)
    assert output == "Done something"


def test_read_model_output_uses_stable_line_numbered_contract() -> None:
    formatter = ToolResultFormatter()
    result = ToolResult(
        success=True,
        summary="Read file.py",
        raw_payload={
            "path": "file.py",
            "content": "     3\tdef hello():\n     4\t    return 'world'\n",
            "actual_start_line": 3,
            "actual_end_line": 4,
            "total_lines": 10,
            "shown_lines": 2,
            "truncated": False,
        },
    )

    assert formatter.format("Read", result) == (
        "Read succeeded\n"
        "Path: file.py\n"
        "Range: lines 3-4 of 10\n"
        "Output:\n"
        "     3\tdef hello():\n"
        "     4\t    return 'world'\n"
        "Note: file read complete."
    )


def test_read_model_output_reports_next_offset_when_truncated() -> None:
    formatter = ToolResultFormatter(read_file_max_chars=1200)
    result = ToolResult(
        success=True,
        summary="Read large.py",
        raw_payload={
            "path": "large.py",
            "content": "     1\talpha\n     2\tbeta\n",
            "actual_start_line": 1,
            "actual_end_line": 2,
            "total_lines": 8,
            "shown_lines": 2,
            "truncated": True,
        },
    )

    output = formatter.format("Read", result)

    assert "Read succeeded" in output
    assert "Range: lines 1-2 of 8" in output
    assert "Note: output truncated; use Read with offset=3 and limit to continue." in output


def test_bash_model_output_uses_codex_style_stable_contract() -> None:
    formatter = ToolResultFormatter(run_shell_max_chars=1200)
    result = ToolResult(
        success=True,
        summary="Command exited with 0",
        raw_payload={
            "exit_code": 0,
            "stdout": "one\ntwo\n",
            "stderr": "",
            "output": "one\ntwo\n",
            "cwd": "/tmp/workspace",
            "duration_ms": 25,
            "truncated": False,
        },
    )

    assert formatter.format("Bash", result) == (
        "Command succeeded\n"
        "Exit code: 0\n"
        "Wall time: 0.025 seconds\n"
        "Cwd: /tmp/workspace\n"
        "Output:\n"
        "one\n"
        "two"
    )


def test_ls_model_output_is_bounded_and_sorted_by_kind() -> None:
    formatter = ToolResultFormatter()
    result = ToolResult(
        success=True,
        summary="Listed .",
        raw_payload={
            "path": ".",
            "dirs": ["src", "tests"],
            "files": ["README.md", "pyproject.toml"],
            "hidden": [".gitignore"],
            "total": 5,
        },
    )

    assert formatter.format("LS", result) == (
        "LS succeeded\n"
        "Path: .\n"
        "Total entries: 5\n"
        "Directories (2): src/, tests/\n"
        "Files (2): README.md, pyproject.toml\n"
        "Hidden (1): .gitignore"
    )


def test_git_diff_model_output_uses_head_preview_not_tail() -> None:
    formatter = ToolResultFormatter(default_max_chars=2000)
    diff = "\n".join(f"+line {index}" for index in range(60))
    result = ToolResult(
        success=True,
        summary="Git diff for workspace: changes found",
        raw_payload={
            "path": None,
            "staged": False,
            "shortstat": "1 file changed, 60 insertions(+)",
            "stat": " file.py | 60 +++++++++++++++++",
            "diff": diff,
            "truncated": True,
        },
    )

    output = formatter.format("GitDiff", result)

    assert output.startswith(
        "GitDiff succeeded\n"
        "Path: workspace\n"
        "Staged: false\n"
        "Shortstat: 1 file changed, 60 insertions(+)\n"
    )
    assert "Diff preview (first 40 of 60 lines):" in output
    assert "+line 0" in output
    assert "+line 59" not in output
    assert "Note: diff truncated; narrow path or staged scope if needed." in output


def test_failure_model_output_uses_stable_error_contract() -> None:
    formatter = ToolResultFormatter()
    result = ToolResult(
        success=False,
        summary="Failed to read file",
        error="File not found",
        raw_payload={"path": "missing.py", "error_kind": "not_found"},
    )

    assert formatter.format("Read", result) == (
        "Read failed\n"
        "Path: missing.py\n"
        "Error kind: not_found\n"
        "Error: File not found"
    )


def test_mutation_model_output_uses_compact_diff_preview() -> None:
    formatter = ToolResultFormatter(default_max_chars=2000)
    diff = "\n".join(f"+line {index}" for index in range(30))
    result = ToolResult(
        success=True,
        summary="Edited file.py",
        raw_payload={
            "path": "file.py",
            "status": "edited",
            "matches": 2,
            "diff": diff,
            "write_diagnostics": {"count": 1, "diagnostics": ["E: issue"], "truncated": False},
        },
    )

    output = formatter.format("Edit", result)

    assert output == (
        "Edit succeeded\n"
        "Path: file.py\n"
        "Status: edited\n"
        "Matches: 2\n"
        "Diagnostics: 1 issue(s)\n"
        "Diff preview (first 20 of 30 lines):\n"
        "+line 0\n"
        "+line 1\n"
        "+line 2\n"
        "+line 3\n"
        "+line 4\n"
        "+line 5\n"
        "+line 6\n"
        "+line 7\n"
        "+line 8\n"
        "+line 9\n"
        "+line 10\n"
        "+line 11\n"
        "+line 12\n"
        "+line 13\n"
        "+line 14\n"
        "+line 15\n"
        "+line 16\n"
        "+line 17\n"
        "+line 18\n"
        "+line 19\n"
        "Note: diff truncated for model context; inspect raw payload or run GitDiff if needed."
    )


def test_mutation_model_output_omits_empty_diff_for_unchanged_write() -> None:
    formatter = ToolResultFormatter()
    result = ToolResult(
        success=True,
        summary="Wrote file.py",
        raw_payload={"path": "file.py", "status": "unchanged", "diff": ""},
    )

    assert formatter.format("Write", result) == (
        "Write succeeded\n"
        "Path: file.py\n"
        "Status: unchanged"
    )
