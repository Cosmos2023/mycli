def test_all_tools_importable():
    from mycli.tools.ask_user_question import AskUserQuestionTool
    from mycli.tools.bash import BashTool
    from mycli.tools.bash_output import BashOutputTool
    from mycli.tools.edit import EditTool
    from mycli.tools.git_tools import GitDiffTool, GitLogTool, GitShowTool, GitStatusTool
    from mycli.tools.kill_shell import KillShellTool
    from mycli.tools.lint import LintTool
    from mycli.tools.ls import LSTool
    from mycli.tools.patch import PatchTool
    from mycli.tools.plan import PlanTool
    from mycli.tools.plan_mode import EnterPlanModeTool, ExitPlanModeTool
    from mycli.tools.read import ReadTool
    from mycli.tools.web_fetch import WebFetchTool
    from mycli.tools.web_search import WebSearchTool
    from mycli.tools.write import WriteTool

    assert all(
        tool is not None
        for tool in (
            ReadTool,
            EditTool,
            PatchTool,
            WriteTool,
            LSTool,
            BashTool,
            BashOutputTool,
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
            EnterPlanModeTool,
            ExitPlanModeTool,
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
        "enter_plan_mode",
        "exit_plan_mode",
    }
    assert set(names) == expected
