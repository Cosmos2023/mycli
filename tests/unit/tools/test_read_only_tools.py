from pathlib import Path

from mycli.domain.tools import ToolCall, ToolEvidence
from mycli.tools.base import ToolResult
from mycli.tools.grep import GrepTool
from mycli.tools.ls import LSTool
from mycli.tools.read import ReadTool


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
