from pathlib import Path

import mycli.tools.search_text as search_text_module
from mycli.domain.tools import ToolCall, ToolEvidence
from mycli.tools.list_directory import ListDirectoryTool
from mycli.tools.base import ToolResultV2
from mycli.tools.read_file import ReadFileTool
from mycli.tools.search_text import SearchTextTool


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

    legacy = ToolResultV2(
        success=True,
        summary="Found 1 match for hello",
        evidence=evidence,
    ).to_legacy()

    assert legacy.evidence == evidence


def test_read_only_tools_return_grounded_results(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("hello world\n", encoding="utf-8")

    list_tool = ListDirectoryTool(root)
    read_tool = ReadFileTool(root)
    search_tool = SearchTextTool(root)

    listed = list_tool.run(ToolCall(name="list_directory", arguments={"path": "."}, reason="inspect"))
    loaded = read_tool.run(ToolCall(name="read_file", arguments={"path": "README.md"}, reason="inspect"))
    searched = search_tool.run(ToolCall(name="search_text", arguments={"query": "hello"}, reason="inspect"))

    assert listed.success is True
    assert "README.md" in listed.summary
    assert loaded.raw_payload["content"] == "hello world\n"
    assert searched.raw_payload["matches"][0]["path"] == "README.md"


def test_list_directory_returns_failure_for_missing_directory(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()

    tool = ListDirectoryTool(root)
    result = tool.run(
        ToolCall(name="list_directory", arguments={"path": "mycli"}, reason="inspect")
    )

    assert result.success is False
    assert result.error is not None
    assert "exist" in result.error.lower()


def test_search_text_exposes_match_evidence(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("hello world\n", encoding="utf-8")

    tool = SearchTextTool(root)
    result = tool.run(
        ToolCall(name="search_text", arguments={"query": "hello"}, reason="inspect")
    )

    assert result.success is True
    assert len(result.evidence) == 1
    evidence = result.evidence[0]
    assert evidence.kind == "search_match"
    assert evidence.title == 'Match 1 for "hello"'
    assert evidence.path == "README.md"
    assert evidence.line_start == 1
    assert evidence.line_end == 1
    assert evidence.snippet == "hello world"
    assert evidence.metadata["query"] == "hello"


def test_read_file_exposes_file_excerpt_evidence(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("hello world\nsecond line\n", encoding="utf-8")

    tool = ReadFileTool(root)
    result = tool.run(
        ToolCall(name="read_file", arguments={"path": "README.md"}, reason="inspect")
    )

    assert result.success is True
    assert len(result.evidence) == 1
    evidence = result.evidence[0]
    assert evidence.kind == "file_excerpt"
    assert evidence.title == "Excerpt from README.md"
    assert evidence.path == "README.md"
    assert evidence.line_start == 1
    assert evidence.line_end == 2
    assert evidence.snippet == "hello world\nsecond line\n"


def test_read_file_returns_structured_failure_for_missing_file(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()

    tool = ReadFileTool(root)
    result = tool.run(
        ToolCall(name="read_file", arguments={"path": "missing.py"}, reason="inspect")
    )

    assert result.success is False
    assert result.error is not None
    assert result.raw_payload["path"] == "missing.py"
    assert result.raw_payload["error_kind"] == "not_found"


def test_search_text_supports_path_and_glob_filters(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    (root / "src").mkdir(parents=True)
    (root / "docs").mkdir()
    (root / "src" / "app.py").write_text("TOKEN = 'abc'\n", encoding="utf-8")
    (root / "docs" / "notes.md").write_text("token mention\n", encoding="utf-8")

    tool = SearchTextTool(root)
    result = tool.run(
        ToolCall(
            name="search_text",
            arguments={"query": "TOKEN", "path": "src", "glob": "*.py"},
            reason="rg for token in source",
        )
    )

    assert result.success is True
    assert len(result.raw_payload["matches"]) == 1
    assert result.raw_payload["matches"][0]["path"] == "src/app.py"


def test_search_text_supports_case_sensitive_matching(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("Token\ntoken\n", encoding="utf-8")

    tool = SearchTextTool(root)
    result = tool.run(
        ToolCall(
            name="search_text",
            arguments={"query": "Token", "case_sensitive": True},
            reason="rg with case sensitivity",
        )
    )

    assert result.success is True
    assert len(result.raw_payload["matches"]) == 1
    assert result.raw_payload["matches"][0]["line"] == "Token"


def test_search_text_prefers_rg_when_available(monkeypatch, tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()

    captured: dict[str, object] = {}

    def fake_which(name: str) -> str | None:
        return "/usr/local/bin/rg" if name == "rg" else None

    def fake_run_command(args: list[str], cwd: Path):
        captured["args"] = args
        captured["cwd"] = cwd

        class Completed:
            returncode = 0
            stdout = "README.md:1:hello world\n"
            stderr = ""

        return Completed()

    monkeypatch.setattr(search_text_module.shutil, "which", fake_which)
    monkeypatch.setattr(search_text_module, "run_command", fake_run_command)

    tool = SearchTextTool(root)
    result = tool.run(
        ToolCall(name="search_text", arguments={"query": "hello"}, reason="inspect")
    )

    assert result.success is True
    assert captured["args"][0] == "rg"
    assert result.raw_payload["matches"][0]["path"] == "README.md"


def test_search_text_parses_single_file_rg_output(monkeypatch, tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    target = root / "README.md"
    target.write_text("hello world\nsecond line\n", encoding="utf-8")

    def fake_which(name: str) -> str | None:
        return "/usr/local/bin/rg" if name == "rg" else None

    def fake_run_command(args: list[str], cwd: Path):
        assert args[-1] == "README.md"
        assert cwd == root

        class Completed:
            returncode = 0
            stdout = "1:hello world\n"
            stderr = ""

        return Completed()

    monkeypatch.setattr(search_text_module.shutil, "which", fake_which)
    monkeypatch.setattr(search_text_module, "run_command", fake_run_command)

    tool = SearchTextTool(root)
    result = tool.run(
        ToolCall(
            name="search_text",
            arguments={"query": "hello", "path": "README.md"},
            reason="inspect single file",
        )
    )

    assert result.success is True
    assert result.raw_payload["matches"] == [
        {
            "path": "README.md",
            "line_number": 1,
            "line": "hello world",
        }
    ]


def test_search_text_falls_back_when_rg_is_unavailable(monkeypatch, tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("hello world\n", encoding="utf-8")

    monkeypatch.setattr(search_text_module.shutil, "which", lambda _name: None)

    tool = SearchTextTool(root)
    result = tool.run(
        ToolCall(name="search_text", arguments={"query": "hello"}, reason="inspect")
    )

    assert result.success is True
    assert result.raw_payload["matches"][0]["path"] == "README.md"
