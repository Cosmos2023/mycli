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

        assert len(q.options) == 3
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
                options=[{"label": str(i)} for i in range(5)],
            )

    def test_tool_response_shape(self):
        result = ask_user_question(
            question="Pick one",
            options=[{"label": "A"}, {"label": "B"}],
            header="Choice",
        )

        assert result["status"] == "awaiting_user_response"
        assert result["header"] == "Choice"
        assert result["options"][-1]["label"] == "Other"
