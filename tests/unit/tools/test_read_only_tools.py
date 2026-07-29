from pathlib import Path

from mycli.domain.tooling.calls import ToolCall, ToolEvidence
from mycli.services.context.tool_result_formatter import ToolResultFormatter
from mycli.services.filesystem import FileSystemRuntime
from mycli.tools.base import ToolResult
from mycli.tools.ls import LSTool
from mycli.tools.read import ReadTool
from mycli.tools.registry import default_tools


def test_tool_result_v2_to_legacy_preserves_evidence() -> None:
    evidence = (
        ToolEvidence(
            kind="search_match",
            title='Match 1 for "hello"',
            path="README.md",
            line_start=1,
            line_end=1,
            snippet="hello world",
            metadata={"query": "hello"},
        ),
    )

    legacy = ToolResult(
        success=True,
        summary="Found 1 match for hello",
        evidence=evidence,
    )

    assert legacy.evidence == evidence


def test_read_only_tools_return_grounded_results(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("hello world\n", encoding="utf-8")

    list_tool = LSTool(root)
    read_tool = ReadTool(root)
    listed = list_tool.run(ToolCall(name="LS", arguments={"path": "."}, reason="inspect"))
    loaded = read_tool.run(
        ToolCall(
            name="Read",
            arguments={"path": "README.md", "offset": 1, "limit": 200},
            reason="inspect",
        )
    )
    assert listed.success is True
    assert "README.md" in listed.summary
    assert "hello world" in loaded.raw_payload["content"]


def test_unrestricted_read_only_tools_allow_absolute_paths_outside_workspace(
    tmp_path: Path,
) -> None:
    root = tmp_path / "workspace"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    (outside / "README.md").write_text("hello outside\n", encoding="utf-8")

    listed = LSTool(root, unrestricted=True).execute({"path": str(outside)})
    assert listed.success is True
    assert "README.md" in listed.raw_payload["files"]


def test_list_directory_returns_failure_for_missing_directory(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()

    tool = LSTool(root)
    result = tool.run(
        ToolCall(name="LS", arguments={"path": "mycli"}, reason="inspect")
    )

    assert result.success is False
    assert result.error is not None
    assert "directory" in result.error.lower()


def test_read_file_exposes_file_excerpt_evidence(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("hello world\nsecond line\n", encoding="utf-8")

    tool = ReadTool(root)
    result = tool.run(
        ToolCall(
            name="Read",
            arguments={"path": "README.md", "offset": 1, "limit": 200},
            reason="inspect",
        )
    )

    assert result.success is True
    assert len(result.evidence) == 1
    evidence = result.evidence[0]
    assert evidence.kind == "file_excerpt"
    assert evidence.title == "Excerpt from README.md"
    assert evidence.path == "README.md"
    assert evidence.line_start == 1
    assert evidence.line_end == 2
    assert "hello world" in evidence.snippet
    assert "second line" in evidence.snippet


def test_read_file_returns_plain_content_without_automatic_line_numbers(
    tmp_path: Path,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text(
        "alpha\n\tbeta\ngamma\ndelta\n",
        encoding="utf-8",
    )

    result = ReadTool(root).execute(
        {"file_path": "README.md", "offset": 2, "limit": 2}
    )

    assert result.success is True
    content = result.raw_payload["content"]
    assert content.startswith("\tbeta\ngamma\n")
    assert "use offset=4 with limit to continue" in content
    assert result.evidence[0].line_start == 2
    assert result.evidence[0].line_end == 3
    assert result.evidence[0].snippet == "\tbeta\ngamma"


def test_read_file_requires_explicit_offset_and_limit(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("hello world\n", encoding="utf-8")

    result = ReadTool(root).execute({"file_path": "README.md"})

    assert result.success is False
    assert result.error is not None
    assert "offset" in result.error
    assert "limit" in result.error


def test_read_file_uses_explicit_bounded_excerpt(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "large.txt").write_text(
        "\n".join(f"line {index}" for index in range(1, 251)) + "\n",
        encoding="utf-8",
    )

    result = ReadTool(root).execute({"file_path": "large.txt", "offset": 1, "limit": 200})

    assert result.success is True
    assert "line 1" in result.raw_payload["content"]
    assert "line 200" in result.raw_payload["content"]
    assert "line 201" not in result.raw_payload["content"]
    assert result.raw_payload["shown_lines"] == 200
    assert result.raw_payload["requested_limit"] == 200
    assert result.raw_payload["effective_limit"] == 200
    assert result.raw_payload["truncated"] is True
    assert result.evidence[0].line_end == 200


def test_read_file_clamps_large_explicit_limit(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "large.txt").write_text(
        "\n".join(f"line {index}" for index in range(1, 701)) + "\n",
        encoding="utf-8",
    )

    result = ReadTool(root).execute({"file_path": "large.txt", "offset": 1, "limit": 2000})

    assert result.success is True
    assert "line 500" in result.raw_payload["content"]
    assert "line 501" not in result.raw_payload["content"]
    assert result.raw_payload["shown_lines"] == 500
    assert result.raw_payload["requested_limit"] == 2000
    assert result.raw_payload["effective_limit"] == 500
    assert result.raw_payload["limit_clamped"] is True
    assert result.raw_payload["truncated"] is True


def test_read_csv_exposes_model_visible_table_content(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "weekly_sales.csv").write_text(
        "owner,region,weekly_revenue,new_deals\n"
        "Lin,East,128000,5\n"
        "Chen,South,42000,2\n",
        encoding="utf-8",
    )

    tool = ReadTool(root)
    result = tool.execute({"file_path": "weekly_sales.csv", "offset": 1, "limit": 200})
    rendered = ToolResultFormatter().format("Read", result)

    assert result.success is True
    assert result.evidence
    assert "owner,region,weekly_revenue,new_deals" in rendered
    assert "Chen,South,42000,2" in rendered
    assert "Path: weekly_sales.csv" in rendered


def test_read_csv_offset_limit_is_model_visible(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "data.csv").write_text(
        "name,score\nAlice,10\nBob,20\nCharlie,30\nDana,40\n",
        encoding="utf-8",
    )

    tool = ReadTool(root)
    result = tool.execute({"file_path": "data.csv", "offset": 3, "limit": 2})
    rendered = ToolResultFormatter().format("Read", result)

    assert result.success is True
    assert "Bob,20" in rendered
    assert "Charlie,30" in rendered
    assert "Alice,10" not in rendered
    assert "\nBob,20\nCharlie,30\n" in result.raw_payload["content"]
    assert "     3\t" not in result.raw_payload["content"]
    assert "Charlie,30" in result.evidence[0].snippet
    assert result.raw_payload["shown_lines"] == 2
    assert result.raw_payload["truncated"] is True


def test_read_csv_numeric_profile_is_model_visible(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "weekly_sales.csv").write_text(
        "owner,region,weekly_revenue,new_deals\n"
        "Lin,East,128000,5\n"
        "Chen,South,42000,2\n"
        "Ho,West,131000,5\n",
        encoding="utf-8",
    )

    tool = ReadTool(root)
    result = tool.execute({"file_path": "weekly_sales.csv", "offset": 1, "limit": 200})
    rendered = ToolResultFormatter().format("Read", result)

    assert result.success is True
    assert result.raw_payload["numeric_summary"]["weekly_revenue"]["sum"] == 301000
    assert "weekly_revenue: sum=301000" in rendered
    assert "min=42000" in rendered
    assert "owner=Chen" in rendered


def test_repeated_unchanged_read_returns_dedup_hint(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("hello world\n", encoding="utf-8")

    tool = ReadTool(root)
    first = tool.execute({"file_path": "README.md", "offset": 1, "limit": 200})
    second = tool.execute({"file_path": "README.md", "offset": 1, "limit": 200})
    rendered = ToolResultFormatter().format("Read", second)

    assert first.success is True
    assert second.success is True
    assert second.raw_payload["dedup"] is True
    assert "unchanged duplicate" in rendered
    assert "README.md" in rendered


def test_repeated_unrestricted_absolute_read_returns_dedup_hint(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    target = outside / "session.json"
    target.write_text('{"status": "ok"}\n', encoding="utf-8")

    runtime = FileSystemRuntime(workspace_root=root, unrestricted=True)
    tool = ReadTool(root, filesystem_runtime=runtime)

    first = tool.execute({"file_path": str(target), "offset": 1, "limit": 20})
    second = tool.execute({"file_path": str(target), "offset": 1, "limit": 20})

    assert first.success is True
    assert second.success is True
    assert second.raw_payload["dedup"] is True
    assert str(target) in second.raw_payload["content"]


def test_read_file_records_snapshot_metadata(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("hello world\n", encoding="utf-8")

    tool = ReadTool(root)
    result = tool.run(
        ToolCall(
            name="Read",
            arguments={"path": "README.md", "offset": 1, "limit": 200},
            reason="inspect",
        )
    )

    snapshot = result.raw_payload["snapshot"]
    assert snapshot["path"] == "README.md"
    assert snapshot["sha256"]
    assert snapshot["size"] == len("hello world\n".encode("utf-8"))
    assert isinstance(snapshot["mtime_ns"], int)


def test_read_tool_normalizes_zero_offset_to_first_line(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("first\nsecond\n", encoding="utf-8")

    result = ReadTool(root).execute(
        {"file_path": "README.md", "offset": 0, "limit": 1}
    )

    assert result.success is True
    assert result.raw_payload["content"].startswith("first\n")
    assert result.evidence[0].line_start == 1
    assert result.evidence[0].line_end == 1


def test_read_tool_reads_bounded_window_from_large_token_file(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    target = root / "huge.json"
    target.write_text(
        "\n".join(f'{{"index": {index}, "value": "token token token"}}' for index in range(30_000)),
        encoding="utf-8",
    )

    result = ReadTool(root).execute(
        {"file_path": "huge.json", "offset": 10, "limit": 2}
    )

    assert result.success is True
    assert result.raw_payload["content"].startswith(
        '{"index": 9, "value": "token token token"}\n'
        '{"index": 10, "value": "token token token"}\n'
    )
    assert result.raw_payload["truncated"] is True


def test_default_tools_share_read_snapshot_with_edit(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    target = root / "README.md"
    target.write_text("hello world\n", encoding="utf-8")
    tools = {tool.name: tool for tool in default_tools(root)}

    read = tools["Read"].execute({"file_path": "README.md", "offset": 1, "limit": 200})
    edited = tools["Edit"].execute(
        {
            "file_path": "README.md",
            "old_string": "hello world",
            "new_string": "hello snapshot",
        }
    )

    assert read.success is True
    assert edited.success is True
    assert target.read_text(encoding="utf-8") == "hello snapshot\n"


def test_read_file_uses_read_payload_for_snapshot_metadata(monkeypatch, tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("hello world\n", encoding="utf-8")

    def fail_fallback_snapshot(*args: object, **kwargs: object) -> None:
        raise AssertionError("ReadTool should not re-read text files for snapshots")

    monkeypatch.setattr("mycli.tools.read.build_file_snapshot", fail_fallback_snapshot)

    tool = ReadTool(root)
    result = tool.run(
        ToolCall(
            name="Read",
            arguments={"path": "README.md", "offset": 1, "limit": 200},
            reason="inspect",
        )
    )

    assert result.success is True
    assert result.raw_payload["snapshot"]["path"] == "README.md"


def test_read_file_returns_structured_failure_for_missing_file(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()

    tool = ReadTool(root)
    result = tool.run(
        ToolCall(
            name="Read",
            arguments={"path": "missing.py", "offset": 1, "limit": 200},
            reason="inspect",
        )
    )

    assert result.success is False
    assert result.error is not None
    assert result.raw_payload["path"] == "missing.py"
    assert "not found" in result.error.lower()


def test_ls_formatter_separates_directory_file_and_hidden_counts(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "src").mkdir()
    (root / "README.md").write_text("hello\n", encoding="utf-8")
    (root / ".env.example").write_text("TOKEN=\n", encoding="utf-8")

    result = LSTool(root).execute({"path": "."})
    rendered = ToolResultFormatter().format("LS", result)

    assert result.success is True
    assert result.raw_payload["dir_count"] == 1
    assert result.raw_payload["file_count"] == 1
    assert result.raw_payload["hidden_count"] == 1
    assert "Directories (1): src/" in rendered
    assert "Files (1): README.md" in rendered
    assert "Hidden (1): .env.example" in rendered
