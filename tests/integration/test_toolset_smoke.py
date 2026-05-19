def test_all_tools_importable():
    from mycli.tools.ask_user_question import AskUserQuestionTool
    from mycli.tools.bash import BashTool
    from mycli.tools.bash_output import BashOutputTool
    from mycli.tools.edit import EditTool
    from mycli.tools.glob import GlobTool
    from mycli.tools.grep import GrepTool
    from mycli.tools.kill_shell import KillShellTool
    from mycli.tools.lint import LintTool
    from mycli.tools.ls import LSTool
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
            WriteTool,
            GrepTool,
            GlobTool,
            LSTool,
            BashTool,
            BashOutputTool,
            KillShellTool,
            WebSearchTool,
            WebFetchTool,
            LintTool,
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
        "Write",
        "Grep",
        "Glob",
        "LS",
        "Bash",
        "BashOutput",
        "KillShell",
        "WebSearch",
        "WebFetch",
        "Lint",
        "AskUserQuestion",
        "Plan",
        "enter_plan_mode",
        "exit_plan_mode",
    }
    assert set(names) == expected
