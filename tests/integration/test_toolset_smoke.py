from pathlib import Path


def test_all_tools_importable():
    from mycli.tools.ask_user_question import AskUserQuestionTool
    from mycli.tools.bash import BashTool, ShellTool
    from mycli.tools.bash_output import BashOutputTool
    from mycli.tools.edit import EditTool
    from mycli.tools.git_tools import GitDiffTool, GitLogTool, GitShowTool, GitStatusTool
    from mycli.tools.kill_shell import KillShellTool
    from mycli.tools.lint import LintTool
    from mycli.tools.ls import LSTool
    from mycli.tools.patch import PatchTool
    from mycli.tools.plan import PlanTool
    from mycli.tools.read import ReadTool
    from mycli.tools.send_message import SendMessageTool
    from mycli.tools.shell_output import ShellOutputTool
    from mycli.tools.web_fetch import WebFetchTool
    from mycli.tools.web_search import WebSearchTool
    from mycli.tools.write import WriteTool
    from mycli.tools.write_stdin import WriteStdinTool

    assert all(
        tool is not None
        for tool in (
            ReadTool,
            SendMessageTool,
            EditTool,
            PatchTool,
            WriteTool,
            LSTool,
            BashTool,
            ShellTool,
            WriteStdinTool,
            BashOutputTool,
            ShellOutputTool,
            KillShellTool,
            WebSearchTool,
            WebFetchTool,
            LintTool,
            GitStatusTool,
            GitDiffTool,
            GitLogTool,
            GitShowTool,
            AskUserQuestionTool,
            PlanTool,
        )
    )


def test_all_tools_registered():
    from mycli.tools.registry import ToolRegistry

    registry = ToolRegistry()
    names = [tool.spec.name for tool in registry.list_all()]
    expected = {
        "Read",
        "Edit",
        "Patch",
        "Write",
        "LS",
        "Bash",
        "BashOutput",
        "Shell",
        "WriteStdin",
        "ShellOutput",
        "KillShell",
        "WebSearch",
        "WebFetch",
        "Lint",
        "GitStatus",
        "GitDiff",
        "GitLog",
        "GitShow",
        "AskUserQuestion",
        "Plan",
        "Task",
        "SubagentOutput",
        "SendMessage",
    }
    assert set(names) == expected


def test_every_default_tool_has_display_presentation(tmp_path: Path) -> None:
    from mycli.services.tool_display import ToolDisplayProjector
    from mycli.tools.registry import default_tools

    projector = ToolDisplayProjector()
    unknown = [
        tool.spec.name
        for tool in default_tools(tmp_path)
        if projector.presentation_for(tool.spec.name) == "external"
    ]

    assert unknown == []
