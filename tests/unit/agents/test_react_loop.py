from pathlib import Path

from mycli.agents.react_loop import ReactAgent
from mycli.domain.runtime import AgentConfig, DecisionKind, ExecutionContext, ModelDecision
from mycli.domain.tools import ToolCall, ToolResult
from mycli.services.safety_policy import ToolSafetyDecision


class FakeModel:
    def __init__(self) -> None:
        self._decisions = [
            ModelDecision(
                progress_message="Inspecting the workspace",
                tool_call=ToolCall(name="list_directory", arguments={"path": "."}, reason="find entrypoints"),
            ),
            ModelDecision(
                assistant_message="The workspace root contains README.md and src/",
                done=True,
            ),
        ]

    def decide(self, *_args, **_kwargs) -> ModelDecision:
        return self._decisions.pop(0)


class FakeToolRegistry:
    def run(self, call: ToolCall) -> ToolResult:
        return ToolResult(success=True, summary="README.md, src", raw_payload={"entries": ["README.md", "src"]})

    def list_names(self) -> list[str]:
        return ["list_directory"]


def test_react_agent_runs_until_done(tmp_path: Path) -> None:
    agent = ReactAgent(model_client=FakeModel(), tool_registry=FakeToolRegistry())
    response = agent.run(
        user_message="Help me inspect the project",
        context=ExecutionContext(config=AgentConfig(workspace_root=tmp_path)),
    )

    assert response.assistant_message == "The workspace root contains README.md and src/"
    assert response.progress_updates == ("Inspecting the workspace",)


class UnknownToolModel:
    def decide(self, *_args, **_kwargs) -> ModelDecision:
        return ModelDecision(
            progress_message="Trying to inspect the working directory",
            tool_call=ToolCall(name="execute_command", arguments={"args": ["pwd"]}, reason="show cwd"),
        )


def test_react_agent_returns_error_for_unknown_tool(tmp_path: Path) -> None:
    agent = ReactAgent(model_client=UnknownToolModel(), tool_registry=FakeToolRegistry())

    response = agent.run(
        user_message="Which folder am I in?",
        context=ExecutionContext(config=AgentConfig(workspace_root=tmp_path)),
    )

    assert response.pending_decision is None
    assert "unsupported tool" in response.assistant_message.lower()
    assert "execute_command" in response.assistant_message


class EditThenDoneModel:
    def __init__(self) -> None:
        self.calls = 0

    def decide(self, *_args, **_kwargs) -> ModelDecision:
        self.calls += 1
        if self.calls > 1:
            return ModelDecision(assistant_message="Edit complete", done=True)
        return ModelDecision(
            progress_message="Preparing an edit",
            tool_call=ToolCall(
                name="edit_file",
                arguments={"path": "README.md", "new_content": "updated"},
                reason="update docs",
            ),
        )


class RunShellModel:
    def __init__(self, call: ToolCall) -> None:
        self._call = call

    def decide(self, *_args, **_kwargs) -> ModelDecision:
        return ModelDecision(
            progress_message="Running shell command",
            tool_call=self._call,
        )


class MultiToolRegistry:
    def __init__(self) -> None:
        self.run_calls: list[ToolCall] = []

    def run(self, call: ToolCall) -> ToolResult:
        self.run_calls.append(call)
        return ToolResult(success=True, summary="ok", raw_payload={})

    def list_names(self) -> list[str]:
        return ["edit_file", "run_shell", "list_directory"]


class NeedsChoiceSafetyPolicy:
    def evaluate(self, call: ToolCall) -> ToolSafetyDecision:
        return ToolSafetyDecision(
            kind=DecisionKind.NEEDS_CHOICE,
            reason=call.reason,
            preview="dangerous action",
            command_pattern="git push",
        )


def test_react_agent_delegates_edit_execution_to_runtime(tmp_path: Path) -> None:
    registry = MultiToolRegistry()
    agent = ReactAgent(model_client=EditThenDoneModel(), tool_registry=registry)

    response = agent.run(
        user_message="Update the readme",
        context=ExecutionContext(config=AgentConfig(workspace_root=tmp_path)),
    )

    assert response.pending_decision is None
    assert response.assistant_message == "Edit complete"
    assert len(registry.run_calls) == 1


def test_react_agent_returns_pending_decision_for_needs_choice_from_safety_policy(tmp_path: Path) -> None:
    registry = MultiToolRegistry()
    agent = ReactAgent(
        model_client=RunShellModel(
            ToolCall(name="run_shell", arguments={"args": ["git", "push", "origin", "main"]}, reason="publish")
        ),
        tool_registry=registry,
        safety_policy=NeedsChoiceSafetyPolicy(),
    )

    response = agent.run(
        user_message="push this branch",
        context=ExecutionContext(config=AgentConfig(workspace_root=tmp_path)),
    )

    assert response.pending_decision is not None
    assert response.pending_decision.tool_call.name == "run_shell"
    assert len(registry.run_calls) == 0


def test_react_agent_returns_deny_message_for_safety_policy_denial(tmp_path: Path) -> None:
    registry = MultiToolRegistry()
    agent = ReactAgent(
        model_client=RunShellModel(
            ToolCall(name="run_shell", arguments={"args": "not-a-list"}, reason="run invalid")
        ),
        tool_registry=registry,
    )

    response = agent.run(
        user_message="run shell",
        context=ExecutionContext(config=AgentConfig(workspace_root=tmp_path)),
    )

    assert response.pending_decision is None
    assert "denied:" in response.assistant_message.lower()
    assert len(registry.run_calls) == 0
