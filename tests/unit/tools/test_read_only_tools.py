from pathlib import Path

from mycli.domain.tools import ToolCall, ToolEvidence
from mycli.services.context.tool_result_formatter import ToolResultFormatter
from mycli.tools.base import ToolResult
from mycli.tools.grep import GrepTool
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
    search_tool = GrepTool(root)

    listed = list_tool.run(ToolCall(name="LS", arguments={"path": "."}, reason="inspect"))
    loaded = read_tool.run(ToolCall(name="Read", arguments={"path": "README.md"}, reason="inspect"))
    searched = search_tool.run(ToolCall(name="Grep", arguments={"query": "hello"}, reason="inspect"))

    assert listed.success is True
    assert "README.md" in listed.summary
    assert "hello world" in loaded.raw_payload["content"]
    assert "README.md" in searched.raw_payload["matches"][0]


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


def test_search_text_exposes_match_evidence(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("hello world\n", encoding="utf-8")

    tool = GrepTool(root)
    result = tool.run(
        ToolCall(
            name="Grep",
            arguments={"query": "hello", "output_mode": "content"},
            reason="inspect",
        )
    )

    assert result.success is True
    assert len(result.evidence) == 1
    evidence = result.evidence[0]
    assert evidence.kind == "search_match"
    assert evidence.title == 'Match 1 for "hello"'
    assert evidence.path.endswith("README.md")
    assert evidence.line_start == 1
    assert evidence.line_end == 1
    assert evidence.snippet == "hello world"
    assert evidence.metadata["query"] == "hello"


def test_read_file_exposes_file_excerpt_evidence(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("hello world\nsecond line\n", encoding="utf-8")

    tool = ReadTool(root)
    result = tool.run(
        ToolCall(name="Read", arguments={"path": "README.md"}, reason="inspect")
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
    result = tool.execute({"file_path": "weekly_sales.csv"})
    rendered = ToolResultFormatter().format("Read", result)

    assert result.success is True
    assert result.evidence
    assert "owner,region,weekly_revenue,new_deals" in rendered
    assert "Chen,South,42000,2" in rendered
    assert "File: weekly_sales.csv" in rendered


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
    result = tool.execute({"file_path": "weekly_sales.csv"})
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
    first = tool.execute({"file_path": "README.md"})
    second = tool.execute({"file_path": "README.md"})
    rendered = ToolResultFormatter().format("Read", second)

    assert first.success is True
    assert second.success is True
    assert second.raw_payload["dedup"] is True
    assert "already read" in rendered
    assert "README.md" in rendered


def test_read_file_records_snapshot_metadata(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("hello world\n", encoding="utf-8")

    tool = ReadTool(root)
    result = tool.run(
        ToolCall(name="Read", arguments={"path": "README.md"}, reason="inspect")
    )

    snapshot = result.raw_payload["snapshot"]
    assert snapshot["path"] == "README.md"
    assert snapshot["sha256"]
    assert snapshot["size"] == len("hello world\n".encode("utf-8"))
    assert isinstance(snapshot["mtime_ns"], int)


def test_default_tools_share_read_snapshot_with_edit(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    target = root / "README.md"
    target.write_text("hello world\n", encoding="utf-8")
    tools = {tool.name: tool for tool in default_tools(root)}

    read = tools["Read"].execute({"file_path": "README.md"})
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
        ToolCall(name="Read", arguments={"path": "README.md"}, reason="inspect")
    )

    assert result.success is True
    assert result.raw_payload["snapshot"]["path"] == "README.md"


def test_read_file_returns_structured_failure_for_missing_file(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()

    tool = ReadTool(root)
    result = tool.run(
        ToolCall(name="Read", arguments={"path": "missing.py"}, reason="inspect")
    )

    assert result.success is False
    assert result.error is not None
    assert result.raw_payload["path"] == "missing.py"
    assert "not found" in result.error.lower()


def test_search_text_supports_path_and_glob_filters(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    (root / "src").mkdir(parents=True)
    (root / "docs").mkdir()
    (root / "src" / "app.py").write_text("TOKEN = 'abc'\n", encoding="utf-8")
    (root / "docs" / "notes.md").write_text("token mention\n", encoding="utf-8")

    tool = GrepTool(root)
    result = tool.run(
        ToolCall(
            name="Grep",
            arguments={
                "query": "TOKEN",
                "path": "src",
                "include": "*.py",
                "output_mode": "content",
            },
            reason="rg for token in source",
        )
    )

    assert result.success is True
    assert len(result.raw_payload["matches"]) == 1
    assert "app.py" in result.raw_payload["matches"][0]


def test_search_text_supports_case_sensitive_matching(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("Token\ntoken\n", encoding="utf-8")

    tool = GrepTool(root)
    result = tool.run(
        ToolCall(
            name="Grep",
            arguments={
                "query": "Token",
                "case_sensitive": True,
                "output_mode": "content",
            },
            reason="rg with case sensitivity",
        )
    )

    assert result.success is True
    assert any("Token" in match for match in result.raw_payload["matches"])
    assert all("Token" in evidence.snippet for evidence in result.evidence)


def test_search_text_returns_matching_files_by_default(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("hello world\n", encoding="utf-8")

    tool = GrepTool(root)
    result = tool.run(
        ToolCall(name="Grep", arguments={"query": "hello"}, reason="inspect")
    )

    assert result.success is True
    assert "README.md" in result.raw_payload["matches"][0]


def test_search_text_supports_single_file_content_mode(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    target = root / "README.md"
    target.write_text("hello world\nsecond line\n", encoding="utf-8")

    tool = GrepTool(root)
    result = tool.run(
        ToolCall(
            name="Grep",
            arguments={"query": "hello", "path": "README.md", "output_mode": "content"},
            reason="inspect single file",
        )
    )

    assert result.success is True
    assert "hello world" in result.raw_payload["matches"][0]


def test_search_text_returns_empty_matches_for_no_hits(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("hello world\n", encoding="utf-8")

    tool = GrepTool(root)
    result = tool.run(
        ToolCall(name="Grep", arguments={"query": "missing"}, reason="inspect")
    )

    assert result.success is True
    assert result.raw_payload["matches"] == []
