from pathlib import Path
import time

from mycli.cli.main import build_turn_service
from mycli.application.runtime.agent_runtime import AgentRuntime
from mycli.application.turn_service import TurnService
from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import (
    AgentConfig,
    DecisionAction,
    DecisionKind,
    HistoryItem,
    HistoryItemType,
    ModelTurnResult,
    ModelDecision,
    PendingApproval,
    PendingDecision,
    RuntimeBlock,
    RuntimeItem,
    ShellLifecycleEvent,
    SessionCommandAllowance,
    StopReason,
    SuspendedTurn,
    TurnResponse,
    TurnStatus,
)
from mycli.domain.memory import MemoryKind
from mycli.memory.service import MemoryService
from mycli.domain.tooling.calls import ToolCall
from mycli.tools.ask_user_question import AskUserQuestionTool
from mycli.tools.base import ToolResult, ToolSpec
from mycli.tools.registry import ToolRegistry
from mycli.tools.bash import BashTool
from mycli.tools.shell_registry import SHELL_REGISTRY
from mycli.services.execpolicy import ExecPolicyRefreshError
from mycli.services.execpolicy_writer import ExecPolicyWriteError


class PushModel:
    def decide(self, *_args, **_kwargs) -> ModelDecision:
        return ModelDecision(
            progress_message="Preparing a risky push",
            tool_call=ToolCall(
                name="Shell",
                arguments={"command": "git push origin main"},
                reason="publish branch",
            ),
        )


class FakeModel:
    def __init__(self) -> None:
        self._decisions = [
            ModelDecision(
                progress_message="Checking the repository structure",
                tool_call=ToolCall(name="LS", arguments={"path": "."}, reason="inspect root"),
            ),
            ModelDecision(assistant_message="The repo starts with src/ and tests/", done=True),
        ]

    def decide(self, *_args, **_kwargs) -> ModelDecision:
        return self._decisions.pop(0)


class FakeToolRegistry:
    def run(self, call: ToolCall) -> ToolResult:
        if call.name == "Shell":
            return ToolResult(success=True, summary="pushed", raw_payload={"stdout": "", "stderr": ""})
        return ToolResult(success=True, summary="src, tests", raw_payload={"entries": ["src", "tests"]})

    def list_names(self) -> list[str]:
        return ["Edit", "LS", "Read", "Shell", "Grep"]


class SkillAwareModel:
    def __init__(self) -> None:
        self.prompts: list[str] = []
        self._decisions = [
            ModelDecision(
                progress_message="Inspecting the repository with repository-analysis",
                tool_call=ToolCall(name="LS", arguments={"path": "."}, reason="inspect root"),
            ),
            ModelDecision(
                assistant_message="Start with src/mycli/cli/main.py and src/mycli/application/turn_service.py",
                done=True,
            ),
        ]

    def decide(self, prompt: str) -> ModelDecision:
        self.prompts.append(prompt)
        if "Select up to 5 memory files. Return JSON only." in prompt:
            return ModelDecision(assistant_message='{"files":["repository_entrypoint.md"]}', done=True)
        return self._decisions.pop(0)


class PromptCaptureModel:
    def __init__(self) -> None:
        self.prompts: list[str] = []

    def decide(self, prompt: str) -> ModelDecision:
        self.prompts.append(prompt)
        return ModelDecision(assistant_message="Captured prompt", done=True)


class UnusedToolRegistry:
    def run(self, _call):
        raise AssertionError("Shell should not execute before approval")

    def list_names(self) -> list[str]:
        return ["Edit", "LS", "Read", "Shell", "Grep"]


class CountingPushModel:
    def __init__(self) -> None:
        self.calls = 0

    def decide(self, *_args, **_kwargs) -> ModelDecision:
        self.calls += 1
        return PushModel().decide()


class PushThenDoneModel:
    def __init__(self) -> None:
        self.calls = 0

    def decide(self, *_args, **_kwargs) -> ModelDecision:
        self.calls += 1
        if self.calls == 1:
            return PushModel().decide()
        return ModelDecision(assistant_message="Done", done=True)


class PersistentPushTwiceModel:
    def __init__(self) -> None:
        self.calls = 0

    def decide(self, *_args, **_kwargs) -> ModelDecision:
        self.calls += 1
        if self.calls in {1, 3}:
            return ModelDecision(
                progress_message="Preparing a persistent push",
                tool_call=ToolCall(
                    name="Shell",
                    arguments={
                        "command": "git push origin main",
                        "prefix_rule": ["git", "push"],
                    },
                    reason="publish branch",
                    call_id=f"call_push_{self.calls}",
                ),
            )
        return ModelDecision(assistant_message="Done", done=True)


class DoneModel:
    def decide(self, *_args: object, **_kwargs: object) -> ModelDecision:
        return ModelDecision(assistant_message="Done", done=True)


class SpyToolRegistry:
    def __init__(self) -> None:
        self.calls: list[ToolCall] = []

    def run(self, call: ToolCall) -> ToolResult:
        self.calls.append(call)
        return ToolResult(success=True, summary="ok", raw_payload={})

    def list_names(self) -> list[str]:
        return ["LS", "Read", "Shell", "Grep", "Edit"]


class LegacyBashSpyRegistry(SpyToolRegistry):
    def list_names(self) -> list[str]:
        return ["LS", "Read", "Shell", "Bash", "Grep", "Edit"]


class FakeRuntime:
    def __init__(self) -> None:
        self.user_messages: list[str] = []
        self.choices: list[str] = []

    def handle_user_turn(self, user_message: str) -> TurnResponse:
        self.user_messages.append(user_message)
        return TurnResponse(assistant_message="runtime answer")

    def resolve_pending_approval(self, choice: str, **_kwargs: object) -> TurnResponse:
        self.choices.append(choice)
        return TurnResponse(assistant_message=f"runtime resolved {choice}")


class DecisionModelAdapter:
    def __init__(self, model: object) -> None:
        self._model = model

    def next_action(self, *, messages: list[object], tools: list[object]) -> ModelDecision:
        del tools
        prompt = "\n\n".join(
            str(getattr(message, "content", ""))
            for message in messages
            if getattr(message, "content", "")
        )
        decide = getattr(self._model, "decide")
        return decide(prompt)


class SpySchemaTool:
    def __init__(self, name: str, registry: object) -> None:
        self.spec = ToolSpec(name=name, description=f"Test tool {name}")
        self._registry = registry

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        result = self.run(
            ToolCall(name=self.spec.name, arguments=arguments, reason="test tool call")
        )
        return ToolResult(
            success=result.success,
            summary=result.summary,
            artifacts=result.artifacts,
            raw_payload=result.raw_payload,
            evidence=result.evidence,
            error=result.error,
        )

    def run(self, call: ToolCall) -> ToolResult:
        run = getattr(self._registry, "run")
        return run(call)


def make_turn_service(
    *,
    tmp_path: Path,
    model: object,
    tool_registry: object,
    config: AgentConfig | None = None,
    home_dir: Path | None = None,
) -> TurnService:
    resolved_config = config or AgentConfig(workspace_root=tmp_path, session_id="demo")
    resolved_home = home_dir or tmp_path / "home"
    tools = [SpySchemaTool(name, tool_registry) for name in tool_registry.list_names()]
    runtime = AgentRuntime(
        model_adapter=DecisionModelAdapter(model),
        tool_registry=ToolRegistry.from_tools(tools),
        config=resolved_config,
        home_dir=resolved_home,
    )
    return TurnService(
        runtime=runtime,
        config=resolved_config,
        home_dir=resolved_home,
    )


def test_turn_service_exposes_owner_scoped_shell_lifecycle_state(tmp_path: Path) -> None:
    bash = BashTool(tmp_path)
    config = AgentConfig(workspace_root=tmp_path, session_id="service-shell-owner")
    runtime = AgentRuntime(
        model_adapter=DecisionModelAdapter(FakeModel()),
        tool_registry=ToolRegistry.from_tools([bash]),
        config=config,
        home_dir=tmp_path / "home",
    )
    service = TurnService(runtime=runtime, config=config, home_dir=tmp_path / "home")
    events: list[ShellLifecycleEvent] = []
    unsubscribe = service.register_shell_lifecycle_listener(events.append)

    result = bash.execute({"command": "sleep 30", "run_in_background": True})
    shell_id = str(result.raw_payload["shell_id"])
    deadline = time.monotonic() + 2
    while not events and time.monotonic() < deadline:
        time.sleep(0.01)

    try:
        rows = service.active_background_shells()
        assert {row["shell_id"] for row in rows} == {shell_id}
        assert events[0].owner_session_id == "service-shell-owner"
    finally:
        unsubscribe()
        SHELL_REGISTRY.kill(shell_id, owner_session_id="service-shell-owner")
        runtime.close()


def test_turn_service_inspects_and_stops_only_owned_background_shells(
    tmp_path: Path,
) -> None:
    bash = BashTool(tmp_path)
    config = AgentConfig(workspace_root=tmp_path, session_id="session-a-commands")
    runtime = AgentRuntime(
        model_adapter=DecisionModelAdapter(FakeModel()),
        tool_registry=ToolRegistry.from_tools([bash]),
        config=config,
        home_dir=tmp_path / "home",
    )
    service = TurnService(runtime=runtime, config=config, home_dir=tmp_path / "home")
    owned = bash.execute({"command": "sleep 30", "run_in_background": True})
    owned_id = str(owned.raw_payload["shell_id"])
    foreign = SHELL_REGISTRY.execute(
        "sleep 30",
        owner_session_id="session-b-commands",
        workdir=str(tmp_path),
        background=True,
    )
    foreign_id = str(foreign["shell_id"])

    try:
        lines = service.inspect_bashes()
        assert len(lines) == 1
        assert owned_id in lines[0]
        assert "state=running_background" in lines[0]
        assert foreign_id not in lines[0]

        assert service.stop_background_shells() == (
            "Stopping all background terminals.",
        )
        assert owned_id not in SHELL_REGISTRY.processes()
        assert foreign_id in SHELL_REGISTRY.processes()
    finally:
        SHELL_REGISTRY.kill(foreign_id, owner_session_id="session-b-commands")
        runtime.close()


class PushThenDoneRuntimeAdapter:
    def __init__(self) -> None:
        self.calls = 0

    def next_action(self, *_args, **_kwargs) -> ModelDecision:
        self.calls += 1
        if self.calls == 1:
            return ModelDecision(
                progress_message="Preparing a risky push",
                tool_call=ToolCall(
                    name="Shell",
                    arguments={"command": "git push origin main"},
                    reason="publish branch",
                ),
            )
        return ModelDecision(assistant_message="Push finished", done=True)


class DoneRuntimeAdapter:
    def next_action(self, *_args, **_kwargs) -> ModelDecision:
        return ModelDecision(assistant_message="Push finished", done=True)


class ClarifyThenWaitingRuntimeAdapter:
    def __init__(self) -> None:
        self.calls = 0

    def next_turn(self, *, items, tools) -> ModelTurnResult:
        del items, tools
        self.calls += 1
        if self.calls == 1:
            return ModelTurnResult(
                items=(
                    RuntimeItem(
                        role="assistant",
                        blocks=(
                            RuntimeBlock(
                                type="tool_call",
                                tool_name="AskUserQuestion",
                                tool_arguments={
                                    "question": "Which slice should come next?",
                                    "options": [
                                        {"label": "Runtime"},
                                        {"label": "TUI"},
                                    ],
                                },
                                call_id="call_question_1",
                            ),
                        ),
                    ),
                ),
                done=False,
            )
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Runtime slice selected."),),
                ),
            ),
            done=True,
        )


class ClarificationDoneRuntimeAdapter:
    def next_turn(self, *, items, tools) -> ModelTurnResult:
        del items, tools
        return ModelTurnResult(
            items=(
                RuntimeItem(
                    role="assistant",
                    blocks=(RuntimeBlock(type="text", text="Runtime slice selected."),),
                ),
            ),
            done=True,
        )


def test_turn_service_returns_pending_decision_for_risky_command(tmp_path: Path) -> None:
    service = make_turn_service(
        tmp_path=tmp_path,
        model=PushModel(),
        tool_registry=UnusedToolRegistry(),
        config=AgentConfig(workspace_root=tmp_path, session_id="demo"),
        home_dir=tmp_path / "home",
    )

    response = service.handle_user_turn("push the branch")

    assert response.pending_decision is not None
    assert response.pending_decision.command_pattern == "git push"


def test_turn_service_delegates_to_runtime_when_present(tmp_path: Path) -> None:
    runtime = FakeRuntime()
    service = TurnService(
        runtime=runtime,
        config=AgentConfig(workspace_root=tmp_path, session_id="demo"),
        home_dir=tmp_path / "home",
    )

    response = service.handle_user_turn("inspect repo")
    resolved = service.resolve_pending_decision("1")

    assert response.assistant_message == "runtime answer"
    assert resolved.assistant_message == "runtime resolved 1"
    assert runtime.user_messages == ["inspect repo"]
    assert runtime.choices == ["1"]


def test_turn_service_runtime_recovers_pending_approval_from_structured_runtime_state(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PushThenDoneRuntimeAdapter(),
    )
    service = TurnService(
        runtime=runtime,
        config=AgentConfig(workspace_root=tmp_path, session_id="default"),
        home_dir=tmp_path / "home",
    )

    first = service.handle_user_turn("push the branch")
    assert first.pending_decision is not None
    runtime._session_service.clear_suspended_turn(runtime._config.session_id)

    resolved = service.resolve_pending_decision("1")

    assert resolved.assistant_message == "Push finished"


def test_turn_service_resolves_pending_approval_from_suspended_state_when_decision_row_missing(
    tmp_path: Path,
) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=PushThenDoneRuntimeAdapter(),
    )
    service = TurnService(
        runtime=runtime,
        config=AgentConfig(workspace_root=tmp_path, session_id="default"),
        home_dir=tmp_path / "home",
    )

    first = service.handle_user_turn("push the branch")
    assert first.pending_decision is not None
    runtime._session_service.clear_pending_decision(runtime._config.session_id)

    blocked = service.handle_user_turn("new user input should wait")
    resolved = service.resolve_pending_decision("1")

    assert blocked.pending_decision is not None
    assert "choose 1, 2, or 3" in blocked.assistant_message.lower()
    assert resolved.assistant_message == "Push finished"
    assert runtime._session_service.load_pending_decision("default") is None
    assert runtime._session_service.load_suspended_turn("default") is None


def test_turn_service_resumes_root_to_tip_before_resolving_pending_approval(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=home_dir,
        model_adapter=PushThenDoneRuntimeAdapter(),
    )
    service = TurnService(
        runtime=runtime,
        config=AgentConfig(workspace_root=tmp_path, session_id="default"),
        home_dir=home_dir,
    )
    root = Conversation(session_id="default")
    root.append(Message(role="user", content="start here"))
    root.append(Message(role="assistant", content="root answer"))
    runtime._session_service.save_conversation(root)

    assert service.fork_session(None, "branch", None)[0] == "forked default -> branch"
    first = service.handle_user_turn("push the branch")
    assert first.pending_decision is not None
    assert runtime._session_service.load_pending_decision("branch") is not None
    assert runtime._session_service.load_pending_decision("default") is None

    fresh_runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=home_dir,
        model_adapter=DoneRuntimeAdapter(),
    )
    fresh_service = TurnService(
        runtime=fresh_runtime,
        config=AgentConfig(workspace_root=tmp_path, session_id="default"),
        home_dir=home_dir,
    )

    resumed = fresh_service.resume_session("default")
    resolved = fresh_service.resolve_pending_decision("1")

    assert resumed[0] == "resumed branch"
    assert fresh_service._config.session_id == "branch"
    assert fresh_runtime._config.session_id == "branch"
    assert resolved.assistant_message == "Push finished"
    assert fresh_runtime._session_service.load_pending_decision("branch") is None
    assert fresh_runtime._session_service.load_pending_decision("default") is None
    trace_events = fresh_runtime._trace_service.load("branch")
    continuity = next(
        event
        for event in trace_events
        if event.kind == "session_continuity"
        and event.payload.get("action") == "resume"
    )
    assert continuity.payload == {
        "action": "resume",
        "result": "resolved",
        "requested_session_id": "default",
        "resolved_session_id": "branch",
        "lineage_switched": True,
        "message_count": 3,
        "fork_point": 2,
        "pending_decision": True,
        "pending_clarification": False,
    }


def test_turn_service_resumes_root_to_tip_before_resolving_pending_clarification(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=home_dir,
        model_adapter=ClarifyThenWaitingRuntimeAdapter(),
    )
    runtime._tool_registry.register(AskUserQuestionTool())
    service = TurnService(
        runtime=runtime,
        config=AgentConfig(workspace_root=tmp_path, session_id="default"),
        home_dir=home_dir,
    )
    root = Conversation(session_id="default")
    root.append(Message(role="user", content="start here"))
    root.append(Message(role="assistant", content="root answer"))
    runtime._session_service.save_conversation(root)

    assert service.fork_session(None, "branch", None)[0] == "forked default -> branch"
    first = service.handle_user_turn("choose next slice")
    assert first.turn is not None
    assert first.turn.status is TurnStatus.WAITING_CLARIFICATION
    assert runtime._session_service.load_suspended_turn("branch") is not None
    assert runtime._session_service.load_suspended_turn("default") is None

    fresh_runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=home_dir,
        model_adapter=ClarificationDoneRuntimeAdapter(),
    )
    fresh_runtime._tool_registry.register(AskUserQuestionTool())
    fresh_service = TurnService(
        runtime=fresh_runtime,
        config=AgentConfig(workspace_root=tmp_path, session_id="default"),
        home_dir=home_dir,
    )

    resumed = fresh_service.resume_session("default")
    resolved = fresh_service.resolve_pending_clarification("call_question_1", "Runtime")

    assert resumed[0] == "resumed branch"
    assert fresh_service._config.session_id == "branch"
    assert fresh_runtime._config.session_id == "branch"
    assert resolved.assistant_message == "Runtime slice selected."
    assert fresh_runtime._session_service.load_suspended_turn("branch") is None
    assert fresh_runtime._session_service.load_suspended_turn("default") is None
    trace_events = fresh_runtime._trace_service.load("branch")
    resolution = next(
        event
        for event in trace_events
        if event.kind == "clarification_resolution"
        and event.payload["result"] == "answered"
    )
    assert resolution.payload["request_id"] == "call_question_1"
    assert resolution.payload["tool_name"] == "AskUserQuestion"
    assert resolution.payload["response_chars"] == len("Runtime")


def test_turn_service_allows_session_pattern_after_choice_three(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    service = make_turn_service(
        tmp_path=tmp_path,
        model=PushThenDoneModel(),
        tool_registry=FakeToolRegistry(),
        config=AgentConfig(workspace_root=tmp_path, session_id="demo"),
        home_dir=home_dir,
    )

    service.handle_user_turn("push the branch")
    resolved = service.resolve_pending_decision("3")
    shell_kind = service._active_shell_kind()

    assert "[decision] approved" in resolved.progress_updates
    assert service._session_service.is_command_allowed("demo", "git push", shell_kind) is True
    trace_events = service._trace_service.load("demo")
    allowance_event = next(event for event in trace_events if event.kind == "approval_allowance")
    assert allowance_event.turn_id == resolved.turn.turn_id
    assert allowance_event.payload["call_id"]
    assert allowance_event.payload == {
        "action": "allow_session",
        "tool_name": "Shell",
        "call_id": allowance_event.payload["call_id"],
        "command_pattern": "git push",
        "decision_id": allowance_event.payload["call_id"],
        "new_allowance": True,
        "reason": "git push requires confirmation.",
        "safety_metadata": {
            "tool_name": "Shell",
            "canonical_tool_name": "Shell",
            "risk_level": "high",
            "decision_kind": "needs_choice",
            "policy": "shell_command_analysis",
            "command_pattern": "git push",
            "shell_kind": shell_kind.value,
        },
    }
    agent_log = service._runtime._workspace_log_service.agent_log_path().read_text(
        encoding="utf-8"
    )
    assert "approval_allowance" in agent_log
    assert "git push" in agent_log


def test_turn_service_persists_and_immediately_uses_always_allow(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    registry = SpyToolRegistry()
    model = PersistentPushTwiceModel()
    service = make_turn_service(
        tmp_path=tmp_path,
        model=model,
        tool_registry=registry,
        config=AgentConfig(workspace_root=tmp_path, session_id="demo"),
        home_dir=home_dir,
    )

    first = service.handle_user_turn("push the branch")
    assert first.pending_decision is not None
    assert first.pending_decision.options[-1] is DecisionAction.ALWAYS_ALLOW

    resolved = service.resolve_pending_decision("4")

    assert resolved.pending_decision is None
    assert len(registry.calls) == 1
    assert service._session_service.load_pending_decision("demo") is None
    rules_text = (home_dir / ".mycli" / "rules" / "default.rules").read_text(
        encoding="utf-8"
    )
    assert 'pattern=["git", "push"]' in rules_text
    audit = next(
        event
        for event in service._trace_service.load("demo")
        if event.kind == "persistent_approval"
    )
    assert audit.payload["action"] == "always_allow"
    assert audit.payload["rule_source"] == "user"
    assert audit.payload["pattern_token_count"] == 2
    assert audit.payload["write_result"] == "created"
    assert len(str(audit.payload["pattern_hash"])) == 16
    assert "git" not in str(audit.payload)

    second = service.handle_user_turn("push the branch again")

    assert second.pending_decision is None
    assert len(registry.calls) == 2
    policy_events = [
        event
        for event in service._trace_service.load("demo")
        if event.kind == "runtime_policy_decision"
        and event.payload.get("execpolicy_decision") == "allow"
    ]
    assert policy_events


def test_provider_without_prefix_rule_keeps_existing_approval_choices(tmp_path: Path) -> None:
    service = make_turn_service(
        tmp_path=tmp_path,
        model=PushThenDoneModel(),
        tool_registry=SpyToolRegistry(),
        config=AgentConfig(workspace_root=tmp_path, session_id="demo"),
        home_dir=tmp_path / "home",
    )

    response = service.handle_user_turn("push the branch")

    assert response.pending_decision is not None
    assert response.pending_decision.proposed_execpolicy_pattern is None
    assert response.pending_decision.options == (
        DecisionAction.APPROVE_ONCE,
        DecisionAction.REJECT,
        DecisionAction.ALLOW_SESSION,
    )


def test_legacy_bash_replay_never_offers_always_allow_and_still_executes(
    tmp_path: Path,
) -> None:
    registry = LegacyBashSpyRegistry()
    service = make_turn_service(
        tmp_path=tmp_path,
        model=DoneModel(),
        tool_registry=registry,
        config=AgentConfig(workspace_root=tmp_path, session_id="legacy"),
        home_dir=tmp_path / "home",
    )
    call = ToolCall(
        name="Bash",
        arguments={
            "command": "git push origin main",
            "prefix_rule": ["git", "push"],
        },
        reason="legacy publish",
        call_id="call_legacy_bash_1",
    )
    decision = PendingDecision(
        tool_call=call,
        kind=DecisionKind.NEEDS_CHOICE,
        reason="git push requires confirmation.",
        preview="git push origin main",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
    )
    service._session_service.save_pending_decision("legacy", decision)
    service._session_service.save_suspended_turn(
        "legacy",
        SuspendedTurn(
            user_message="replay the old call",
            conversation=(Message(role="user", content="replay the old call"),),
            pending_approval=PendingApproval(
                tool_call=call,
                reason=decision.reason,
                preview=decision.preview,
            ),
        ),
    )

    response = service._session_service.load_pending_decision("legacy")

    assert response is not None
    assert response.proposed_execpolicy_pattern is None
    assert DecisionAction.ALWAYS_ALLOW not in response.options

    resolved = service.resolve_pending_decision("1")

    assert resolved.pending_decision is None
    assert [call.name for call in registry.calls] == ["Shell"]
    assert registry.calls[0].arguments["command"] == "git push origin main"
    assert "prefix_rule" not in registry.calls[0].arguments


def test_resumed_persistent_approval_can_write_and_execute_once(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    first_service = make_turn_service(
        tmp_path=tmp_path,
        model=PersistentPushTwiceModel(),
        tool_registry=SpyToolRegistry(),
        config=AgentConfig(workspace_root=tmp_path, session_id="resume"),
        home_dir=home_dir,
    )
    first = first_service.handle_user_turn("push the branch")
    assert first.pending_decision is not None
    assert first.pending_decision.options[-1] is DecisionAction.ALWAYS_ALLOW

    resumed_registry = SpyToolRegistry()
    resumed_service = make_turn_service(
        tmp_path=tmp_path,
        model=DoneModel(),
        tool_registry=resumed_registry,
        config=AgentConfig(workspace_root=tmp_path, session_id="resume"),
        home_dir=home_dir,
    )

    resolved = resumed_service.resolve_pending_decision("4")

    assert resolved.pending_decision is None
    assert len(resumed_registry.calls) == 1
    assert resumed_registry.calls[0].name == "Shell"
    rules_text = (home_dir / ".mycli" / "rules" / "default.rules").read_text(
        encoding="utf-8"
    )
    assert 'pattern=["git", "push"]' in rules_text


def test_project_execpolicy_rules_suppress_and_override_persistent_approval(
    tmp_path: Path,
) -> None:
    for project_decision in ("ask", "deny"):
        workspace = tmp_path / project_decision
        rules_dir = workspace / ".mycli" / "rules"
        rules_dir.mkdir(parents=True)
        (rules_dir / "default.rules").write_text(
            f'prefix_rule(pattern=["git", "push"], decision="{project_decision}")\n',
            encoding="utf-8",
        )
        home_dir = tmp_path / f"home-{project_decision}"
        user_rules_dir = home_dir / ".mycli" / "rules"
        user_rules_dir.mkdir(parents=True)
        (user_rules_dir / "default.rules").write_text(
            'prefix_rule(pattern=["git", "push"], decision="allow")\n',
            encoding="utf-8",
        )
        registry = SpyToolRegistry()
        service = make_turn_service(
            tmp_path=workspace,
            model=PersistentPushTwiceModel(),
            tool_registry=registry,
            config=AgentConfig(workspace_root=workspace, session_id=project_decision),
            home_dir=home_dir,
        )

        response = service.handle_user_turn("push the branch")

        if project_decision == "ask":
            assert response.pending_decision is not None
            assert response.pending_decision.proposed_execpolicy_pattern is None
            assert DecisionAction.ALWAYS_ALLOW not in response.pending_decision.options
        else:
            assert response.pending_decision is None
            assert response.assistant_message.startswith("Denied:")
        assert registry.calls == []
        policy_event = next(
            event
            for event in service._trace_service.load(project_decision)
            if event.kind == "runtime_policy_decision"
        )
        assert policy_event.payload["execpolicy_rule_source"] == "project"
        assert "git push" not in str(policy_event.payload)


def test_always_allow_write_failure_keeps_command_pending(tmp_path: Path) -> None:
    registry = SpyToolRegistry()
    service = make_turn_service(
        tmp_path=tmp_path,
        model=PersistentPushTwiceModel(),
        tool_registry=registry,
        config=AgentConfig(workspace_root=tmp_path, session_id="demo"),
        home_dir=tmp_path / "home",
    )
    first = service.handle_user_turn("push the branch")
    assert first.pending_decision is not None

    class FailingWriter:
        def allow_prefix(self, _pattern: tuple[str, ...]):
            raise ExecPolicyWriteError("write failed")

    service._runtime._execpolicy_writer = FailingWriter()

    failed = service.resolve_pending_decision("4")

    assert "could not persist" in failed.assistant_message.lower()
    assert failed.pending_decision is not None
    assert service._session_service.load_pending_decision("demo") is not None
    assert service._session_service.load_suspended_turn("demo") is not None
    assert registry.calls == []


def test_always_allow_refresh_failure_reports_persisted_rule_and_retries(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    registry = SpyToolRegistry()
    service = make_turn_service(
        tmp_path=tmp_path,
        model=PersistentPushTwiceModel(),
        tool_registry=registry,
        config=AgentConfig(workspace_root=tmp_path, session_id="demo"),
        home_dir=home_dir,
    )
    first = service.handle_user_turn("push the branch")
    assert first.pending_decision is not None
    original_refresh = service._runtime.refresh_execpolicy_rules

    def fail_refresh():
        raise ExecPolicyRefreshError("refresh failed")

    service._runtime.refresh_execpolicy_rules = fail_refresh
    try:
        failed = service.resolve_pending_decision("4")
    finally:
        service._runtime.refresh_execpolicy_rules = original_refresh

    assert "persisted" in failed.assistant_message.lower()
    assert failed.pending_decision is not None
    assert registry.calls == []
    assert (home_dir / ".mycli" / "rules" / "default.rules").exists()

    retried = service.resolve_pending_decision("4")

    assert retried.pending_decision is None
    assert len(registry.calls) == 1
    audit = next(
        event
        for event in service._trace_service.load("demo")
        if event.kind == "persistent_approval"
    )
    assert audit.payload["write_result"] == "existing"


def test_turn_service_records_duplicate_allow_session_diagnostic(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    service = make_turn_service(
        tmp_path=tmp_path,
        model=PushThenDoneModel(),
        tool_registry=FakeToolRegistry(),
        config=AgentConfig(workspace_root=tmp_path, session_id="demo"),
        home_dir=home_dir,
    )
    first = service.handle_user_turn("push the branch")
    assert first.pending_decision is not None
    shell_kind = service._active_shell_kind()
    service._session_service.add_command_allowance(
        "demo",
        SessionCommandAllowance(command_pattern="git push", shell_kind=shell_kind),
    )
    resolved = service.resolve_pending_decision("3")

    assert "[decision] approved" in resolved.progress_updates
    trace_events = service._trace_service.load("demo")
    allowance_event = next(event for event in trace_events if event.kind == "approval_allowance")
    assert allowance_event.payload["command_pattern"] == "git push"
    assert allowance_event.payload["new_allowance"] is False


def test_resolve_pending_decision_choice_one_executes_and_clears(tmp_path: Path) -> None:
    tool_registry = SpyToolRegistry()
    service = make_turn_service(
        tmp_path=tmp_path,
        model=PushThenDoneModel(),
        tool_registry=tool_registry,
        config=AgentConfig(workspace_root=tmp_path, session_id="demo"),
        home_dir=tmp_path / "home",
    )

    first = service.handle_user_turn("push the branch")
    resolved = service.resolve_pending_decision("1")

    assert first.pending_decision is not None
    assert "[decision] approved" in resolved.progress_updates
    assert service._session_service.load_pending_decision("demo") is None
    assert len(tool_registry.calls) == 1


def test_allowlist_hit_prevents_new_pending_decision(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    registry = SpyToolRegistry()
    model = PushThenDoneModel()
    service = make_turn_service(
        tmp_path=tmp_path,
        model=model,
        tool_registry=registry,
        config=AgentConfig(workspace_root=tmp_path, session_id="demo"),
        home_dir=home_dir,
    )

    service.handle_user_turn("push the branch")
    service.resolve_pending_decision("3")
    shell_kind = service._active_shell_kind()
    model.calls = 0

    response = service.handle_user_turn("push the branch again")

    assert response.pending_decision is None
    assert len(registry.calls) == 2
    trace_events = service._trace_service.load("demo")
    auto_allowed = next(event for event in trace_events if event.kind == "approval_auto_allowed")
    assert auto_allowed.payload["source"] == "session_allowance"
    assert auto_allowed.payload["tool_name"] == "Shell"
    assert auto_allowed.payload["command_pattern"] == "git push"
    assert auto_allowed.payload["call_id"]
    assert auto_allowed.payload["decision_id"] == auto_allowed.payload["call_id"]
    assert auto_allowed.payload["reason"] == "git push requires confirmation."
    assert auto_allowed.payload["safety_metadata"] == {
        "tool_name": "Shell",
        "canonical_tool_name": "Shell",
        "risk_level": "high",
        "decision_kind": "needs_choice",
        "policy": "shell_command_analysis",
        "command_pattern": "git push",
        "shell_kind": shell_kind.value,
    }
    agent_log = service._runtime._workspace_log_service.agent_log_path().read_text(
        encoding="utf-8"
    )
    assert "approval_auto_allowed" in agent_log
    assert "session_allowance" in agent_log


def test_turn_service_blocks_new_turns_while_decision_is_pending(tmp_path: Path) -> None:
    model = CountingPushModel()
    service = make_turn_service(
        tmp_path=tmp_path,
        model=model,
        tool_registry=UnusedToolRegistry(),
        config=AgentConfig(workspace_root=tmp_path, session_id="demo"),
        home_dir=tmp_path / "home",
    )

    service.handle_user_turn("Which folder am I in?")
    second = service.handle_user_turn("继续")

    assert second.pending_decision is not None
    assert "pending" in second.assistant_message.lower()
    assert model.calls == 1


def test_handle_user_turn_reflects_actual_pending_decision_choices(tmp_path: Path) -> None:
    service = make_turn_service(
        tmp_path=tmp_path,
        model=FakeModel(),
        tool_registry=FakeToolRegistry(),
        config=AgentConfig(workspace_root=tmp_path, session_id="demo"),
        home_dir=tmp_path / "home",
    )
    pending = PendingDecision(
        tool_call=ToolCall(
            name="Read",
            arguments={"path": "README.md"},
            reason="inspect file",
        ),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="manual approval needed",
        preview="README.md",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
    )
    service._session_service.save_pending_decision("demo", pending)

    response = service.handle_user_turn("继续")

    assert response.pending_decision is not None
    assert "choose 1 or 2" in response.assistant_message.lower()
    assert "3" not in response.assistant_message


def test_resolve_pending_decision_reject_clears_it(tmp_path: Path) -> None:
    service = make_turn_service(
        tmp_path=tmp_path,
        model=PushModel(),
        tool_registry=FakeToolRegistry(),
        config=AgentConfig(workspace_root=tmp_path, session_id="demo"),
        home_dir=tmp_path / "home",
    )

    service.handle_user_turn("push the branch")
    rejected = service.resolve_pending_decision("2")
    after = service.resolve_pending_decision("1")

    assert "rejected" in rejected.assistant_message.lower()
    assert rejected.turn is not None
    assert rejected.turn.status is TurnStatus.REJECTED
    assert rejected.turn.stop_reason is StopReason.APPROVAL_REJECTED
    assert "no pending" in after.assistant_message.lower()
    trace_events = service._trace_service.load("demo")
    rejected_event = next(
        event
        for event in trace_events
        if event.kind == "approval_resolution" and event.payload["result"] == "rejected"
    )
    assert rejected_event.turn_id == rejected.turn.turn_id
    assert rejected_event.payload["choice"] == "2"
    assert rejected_event.payload["tool_name"] == "Shell"
    assert rejected_event.payload["command_pattern"] == "git push"
    no_pending_event = next(
        event
        for event in trace_events
        if event.kind == "approval_resolution"
        and event.payload["result"] == "no_pending_decision"
    )
    assert no_pending_event.payload["choice"] == "1"
    agent_log = service._runtime._workspace_log_service.agent_log_path().read_text(
        encoding="utf-8"
    )
    assert "approval_resolution" in agent_log
    assert "no_pending_decision" in agent_log


def test_resolve_pending_decision_invalid_choice_keeps_it(tmp_path: Path) -> None:
    service = make_turn_service(
        tmp_path=tmp_path,
        model=PushModel(),
        tool_registry=FakeToolRegistry(),
        config=AgentConfig(workspace_root=tmp_path, session_id="demo"),
        home_dir=tmp_path / "home",
    )

    service.handle_user_turn("push the branch")
    response = service.resolve_pending_decision("nope")

    assert "choose 1, 2, or 3" in response.assistant_message.lower()
    assert service._session_service.load_pending_decision("demo") is not None
    trace_events = service._trace_service.load("demo")
    invalid_event = next(
        event for event in trace_events if event.kind == "approval_resolution"
    )
    assert invalid_event.payload["result"] == "invalid_choice"
    assert invalid_event.payload["choice"] == "nope"
    assert invalid_event.payload["tool_name"] == "Shell"
    agent_log = service._runtime._workspace_log_service.agent_log_path().read_text(
        encoding="utf-8"
    )
    assert "invalid_choice" in agent_log


def test_resolve_pending_decision_choice_three_rejected_without_allow_session_option(tmp_path: Path) -> None:
    service = make_turn_service(
        tmp_path=tmp_path,
        model=FakeModel(),
        tool_registry=FakeToolRegistry(),
        config=AgentConfig(workspace_root=tmp_path, session_id="demo"),
        home_dir=tmp_path / "home",
    )
    pending = PendingDecision(
        tool_call=ToolCall(
            name="Read",
            arguments={"path": "README.md"},
            reason="inspect file",
        ),
        kind=DecisionKind.NEEDS_CHOICE,
        reason="manual approval needed",
        preview="README.md",
        options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
    )
    service._session_service.save_pending_decision("demo", pending)

    response = service.resolve_pending_decision("3")

    assert "choose 1 or 2" in response.assistant_message.lower()
    assert response.pending_decision is not None
    assert service._session_service.load_pending_decision("demo") is not None


def test_turn_service_returns_assistant_message_and_persists_session(tmp_path: Path) -> None:
    service = make_turn_service(
        tmp_path=tmp_path,
        model=FakeModel(),
        tool_registry=FakeToolRegistry(),
        config=AgentConfig(workspace_root=tmp_path, session_id="demo"),
        home_dir=tmp_path / "home",
    )

    response = service.handle_user_turn("How does this repo start?")

    assert response.assistant_message == "The repo starts with src/ and tests/"
    assert response.progress_updates[0] == "Checking the repository structure"


def test_turn_service_restores_conversation_from_sqlite_after_restart(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    first = build_turn_service(
        cli_args={"session": "demo"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )
    second = build_turn_service(
        cli_args={"session": "demo"},
        cwd=workspace,
        home=home_dir,
        env={"MYCLI_API_KEY": "test-key"},
    )

    conversation = Conversation(session_id="demo")
    conversation.append(Message(role="user", content="hello again"))
    first._session_service.save_conversation(conversation)

    loaded = second._session_service.load_conversation("demo")

    assert [message.content for message in loaded.messages] == ["hello again"]


def test_turn_service_injects_memory_and_skill_context(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()
    memory_service = MemoryService(home_dir=home_dir, workspace_root=workspace)
    memory_service.add_file_memory(
        kind=MemoryKind.PROJECT,
        name="repository entrypoint",
        description="Repository entrypoint",
        content="The repository entrypoint is src/mycli/cli/main.py.",
    )

    model = SkillAwareModel()
    service = make_turn_service(
        tmp_path=workspace,
        model=model,
        tool_registry=FakeToolRegistry(),
        config=AgentConfig(workspace_root=workspace, memory_enabled=True),
        home_dir=home_dir,
    )
    service._memory_service = memory_service

    response = service.handle_user_turn("Help me understand this repository")

    assert "src/mycli/cli/main.py" in response.assistant_message
    runtime_prompt = next(prompt for prompt in model.prompts if "repository-analysis" in prompt)
    assert "src/mycli/cli/main.py" in runtime_prompt


def test_turn_service_includes_recent_conversation_in_prompt(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    model = PromptCaptureModel()
    service = make_turn_service(
        tmp_path=workspace,
        model=model,
        tool_registry=FakeToolRegistry(),
        config=AgentConfig(workspace_root=workspace, session_id="demo"),
        home_dir=home_dir,
    )
    conversation = Conversation(session_id="demo")
    conversation.append(Message(role="user", content="first question"))
    conversation.append(Message(role="assistant", content="first answer"))
    service._session_service.save_conversation(conversation)

    service.handle_user_turn("second question")

    assert "first question" in model.prompts[0]
    assert "first answer" in model.prompts[0]


def test_turn_service_keeps_original_title_after_compact_replacement(tmp_path: Path) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    service = make_turn_service(
        tmp_path=workspace,
        model=FakeModel(),
        tool_registry=FakeToolRegistry(),
        config=AgentConfig(workspace_root=workspace, session_id="demo"),
        home_dir=home_dir,
    )
    conversation = Conversation(session_id="demo")
    conversation.append(Message(role="user", content="Fix the TUI session title rendering"))
    conversation.append(Message(role="assistant", content="Done"))
    service._session_service.save_conversation(conversation)

    assert service.session_title() == "Fix the TUI session title rendering"
    assert service.inspect_session()[0] == "session=Fix the TUI session title rendering"

    service._session_service.append_history_items(
        "demo",
        (
            HistoryItem(
                id="turn-1:user",
                thread_id="demo",
                turn_id="turn-1",
                type=HistoryItemType.USER_MESSAGE,
                text="Fix the TUI session title rendering",
            ),
        ),
    )
    service._session_service.save_conversation(
        Conversation(
            session_id="demo",
            messages=[
                Message(
                    role="user",
                    content="## 1. Primary Request\nA compacted conversation summary",
                    metadata={"compaction": True},
                ),
                Message(role="user", content="Continue the implementation"),
            ],
        )
    )
    service._session_title_cache.clear()

    assert service.session_title() == "Fix the TUI session title rendering"
    assert service.inspect_session()[0] == "session=Fix the TUI session title rendering"


def test_turn_service_compacts_older_turns_when_token_limit_is_exceeded(
    tmp_path: Path,
) -> None:
    home_dir = tmp_path / "home"
    workspace = tmp_path / "workspace"
    home_dir.mkdir()
    workspace.mkdir()

    very_old_user = "user-" + " ".join(f"old_user_token_{index}" for index in range(40))
    very_old_assistant = "assistant-" + " ".join(
        f"old_assistant_token_{index}" for index in range(40)
    )
    recent_user = "recent-user"
    recent_assistant = "recent-assistant"
    latest_user = "latest-user"
    latest_assistant = "latest-assistant"

    model = PromptCaptureModel()
    service = make_turn_service(
        tmp_path=workspace,
        model=model,
        tool_registry=FakeToolRegistry(),
        config=AgentConfig(
            workspace_root=workspace,
            session_id="demo",
            max_prompt_tokens=120,
            compaction_token_limit=80,
            compaction_tail_turns=2,
        ),
        home_dir=home_dir,
    )
    conversation = Conversation(session_id="demo")
    conversation.append(Message(role="user", content=very_old_user))
    conversation.append(Message(role="assistant", content=very_old_assistant))
    conversation.append(Message(role="user", content=recent_user))
    conversation.append(Message(role="assistant", content=recent_assistant))
    conversation.append(Message(role="user", content=latest_user))
    conversation.append(Message(role="assistant", content=latest_assistant))
    service._session_service.save_conversation(conversation)

    service.handle_user_turn("new question")

    assert "## 1. Primary Request" in model.prompts[0]
    assert very_old_user[:80] in model.prompts[0]
    assert "Captured prompt" in model.prompts[1]
    assert very_old_user not in model.prompts[1]
    assert recent_user in model.prompts[1]
    assert recent_assistant in model.prompts[1]
    assert latest_user in model.prompts[1]
    assert latest_assistant in model.prompts[1]


def test_turn_service_pops_only_latest_follow_up(tmp_path: Path) -> None:
    service = make_turn_service(
        tmp_path=tmp_path,
        model=FakeModel(),
        tool_registry=FakeToolRegistry(),
    )
    service.queue_steering_message("keep steering")
    service.queue_follow_up_message("first")
    service.queue_follow_up_message("second")

    popped = service.pop_last_follow_up_input()

    assert popped is not None
    assert popped.text == "second"
    assert service.queued_messages() == (("keep steering",), ("first",))
