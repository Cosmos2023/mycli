from __future__ import annotations

from pathlib import Path

from mycli.application.runtime.tools.tool_execution_service import ToolExecutionService
from mycli.application.runtime.tools.contributed_tool_registry import ToolContributionRegistry
from mycli.domain.conversation import Conversation
from mycli.domain.runtime import PlanState, TurnItemType
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.exposure import ToolExposure, ToolExposureEntry, ToolRouteKey, ToolRouteSource
from mycli.services.context.context_manager import ContextManager
from mycli.services.file_history import FileHistoryService
from mycli.services.hooks import HookAction, HookContext, HookManager, HookPoint, HookResult
from mycli.services.tracing import TraceService
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec
from mycli.tools.registry import ToolRegistry
from mycli.tools.routing.tool_router import ToolRouter


class FakeTool:
    spec = ToolSpec(
        name="read_file",
        description="Read a file",
        parameters=(ToolParameter("path", "string"),),
    )

    def __init__(self) -> None:
        self.seen_arguments: list[dict[str, object]] = []

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        self.seen_arguments.append(dict(arguments))
        path = str(arguments["path"])
        return ToolResult(
            success=True,
            summary=f"Read {path}",
            raw_payload={"path": path, "content": f"content of {path}"},
        )


class FakeEditTool:
    spec = ToolSpec(
        name="edit_file",
        description="Edit a file",
        parameters=(ToolParameter("path", "string"), ToolParameter("new_content", "string")),
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        path = str(arguments["path"])
        target = self._workspace_root / path
        target.write_text(str(arguments["new_content"]), encoding="utf-8")
        return ToolResult(
            success=True,
            summary=f"Edited {path}",
            raw_payload={"path": path},
        )


class FakeSkillTool:
    spec = ToolSpec(
        name="Skill",
        description="Load skill",
        parameters=(ToolParameter("skill_name", "string"),),
    )

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        return ToolResult(
            success=True,
            summary="Activated skill: code-review",
            raw_payload={
                "skill_name": str(arguments["skill_name"]),
                "description": "Review code",
                "content": "Find correctness bugs first.",
                "source_path": "/tmp/code-review.md",
            },
        )


def _tool_exposure() -> ToolExposure:
    return ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("read_file"),
                source=ToolRouteSource.REGISTRY,
                spec=FakeTool.spec,
            ),
        )
    )


def _service(
    tmp_path: Path,
    *,
    hook_manager: HookManager,
    registry: ToolRegistry | None = None,
    file_history: FileHistoryService | None = None,
) -> tuple[ToolExecutionService, FakeTool]:
    fake_tool = FakeTool()
    tool_registry = registry or ToolRegistry.from_tools([fake_tool])

    def append_turn_item(**kwargs: object) -> None:
        turn_items = kwargs["turn_items"]
        item = kwargs["item"]
        assert isinstance(turn_items, list)
        turn_items.append(item)

    service = ToolExecutionService(
        session_id="demo",
        context_manager=ContextManager(),
        trace_service=TraceService(home_dir=tmp_path / "home"),
        append_turn_item=append_turn_item,
        append_lifecycle_events=lambda **_: None,
        apply_tool_effects=lambda **kwargs: kwargs["plan_state"],
        normalize_tool_call=lambda call: call,
        hook_manager=hook_manager,
        file_history=file_history,
    )
    router = ToolRouter(
        tool_registry=tool_registry,
        contributed_tool_registry=ToolContributionRegistry(),
    )
    service._test_router = router  # type: ignore[attr-defined]
    return service, fake_tool


def test_tool_execution_service_denies_tool_before_execution(tmp_path: Path) -> None:
    hook_manager = HookManager()
    hook_manager.register(
        HookPoint.PRE_TOOL_USE,
        lambda ctx: HookResult(action=HookAction.DENY, message="blocked"),
    )
    service, fake_tool = _service(tmp_path, hook_manager=hook_manager)
    router = service._test_router  # type: ignore[attr-defined]
    conversation = Conversation(session_id="demo")

    service.execute_tool_call(
        conversation=conversation,
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_1",
        ),
        tool_router=router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert fake_tool.seen_arguments == []
    assert conversation.messages[-1].content.startswith("<tool_output><![CDATA[")
    assert "Tool denied:" in conversation.messages[-1].content


def test_tool_execution_service_records_skill_body_only_as_tool_result(tmp_path: Path) -> None:
    hook_manager = HookManager()
    skill_tool = FakeSkillTool()
    registry = ToolRegistry.from_tools([skill_tool])
    service, _ = _service(tmp_path, hook_manager=hook_manager, registry=registry)
    router = service._test_router  # type: ignore[attr-defined]
    exposure = ToolExposure(
        entries=(
            ToolExposureEntry(
                route_key=ToolRouteKey.local("Skill"),
                source=ToolRouteSource.REGISTRY,
                spec=skill_tool.spec,
            ),
        )
    )
    conversation = Conversation(session_id="demo")
    turn_items = []

    service.execute_tool_call(
        conversation=conversation,
        call=ToolCall(
            name="Skill",
            arguments={"skill_name": "code-review"},
            reason="Need code review instructions",
            call_id="call_skill",
        ),
        tool_router=router,
        tool_exposure=exposure,
        plan_state=PlanState(),
        turn_id="turn-1",
        activity_events=[],
        turn_items=turn_items,
    )

    tool_result = next(item for item in turn_items if item.type is TurnItemType.TOOL_RESULT)
    assert tool_result.tool_name == "Skill"
    assert tool_result.call_id == "call_skill"
    assert tool_result.metadata["transcript_content"] == "Find correctness bugs first."
    assert [item.type for item in turn_items].count(TurnItemType.TOOL_RESULT) == 1
    assert conversation.messages[-1].content == "Find correctness bugs first."


def test_tool_execution_service_applies_modified_args(tmp_path: Path) -> None:
    hook_manager = HookManager()
    hook_manager.register(
        HookPoint.PRE_TOOL_USE,
        lambda ctx: HookResult(
            action=HookAction.MODIFY,
            modified_args={"path": "pyproject.toml"},
        ),
    )
    service, fake_tool = _service(tmp_path, hook_manager=hook_manager)
    router = service._test_router  # type: ignore[attr-defined]
    conversation = Conversation(session_id="demo")

    service.execute_tool_call(
        conversation=conversation,
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_1",
        ),
        tool_router=router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert fake_tool.seen_arguments == [{"path": "pyproject.toml"}]
    assert conversation.messages[-1].content.startswith("<tool_output><![CDATA[")
    assert "pyproject.toml" in conversation.messages[-1].content
    assert conversation.messages[-1].content.endswith("]]></tool_output>")


def test_tool_execution_service_guards_tool_transcript_before_context(tmp_path: Path) -> None:
    hook_manager = HookManager()
    service, _fake_tool = _service(tmp_path, hook_manager=hook_manager)
    router = service._test_router  # type: ignore[attr-defined]
    conversation = Conversation(session_id="demo")
    turn_items = []

    service.execute_tool_call(
        conversation=conversation,
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_1",
        ),
        tool_router=router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=turn_items,
    )

    content = conversation.messages[-1].content
    assert content.startswith("<tool_output><![CDATA[")
    assert content.endswith("]]></tool_output>")
    assert turn_items[-1].metadata["transcript_content"] == content


def test_tool_execution_service_emits_post_tool_hook(tmp_path: Path) -> None:
    seen: list[HookContext] = []
    hook_manager = HookManager()
    hook_manager.register(
        HookPoint.POST_TOOL_USE,
        lambda ctx: seen.append(ctx) or HookResult(action=HookAction.ALLOW),
    )
    service, _fake_tool = _service(tmp_path, hook_manager=hook_manager)
    router = service._test_router  # type: ignore[attr-defined]
    conversation = Conversation(session_id="demo")

    service.execute_tool_call(
        conversation=conversation,
        call=ToolCall(
            name="read_file",
            arguments={"path": "README.md"},
            reason="inspect",
            call_id="call_read_1",
        ),
        tool_router=router,
        tool_exposure=_tool_exposure(),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert len(seen) == 1
    assert seen[0].hook_point is HookPoint.POST_TOOL_USE
    assert seen[0].tool_name == "read_file"
    assert seen[0].metadata["success"] is True


def test_tool_execution_service_snapshots_file_before_mutating_tool(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "notes.txt").write_text("before\n", encoding="utf-8")
    edit_tool = FakeEditTool(workspace)
    registry = ToolRegistry.from_tools([edit_tool])
    file_history = FileHistoryService(home_dir=tmp_path / "home", workspace_root=workspace)
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=registry,
        file_history=file_history,
    )
    router = service._test_router  # type: ignore[attr-defined]

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="edit_file",
            arguments={"path": "notes.txt", "new_content": "after\n"},
            reason="edit",
            call_id="call_edit_1",
        ),
        tool_router=router,
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("edit_file"),
                    source=ToolRouteSource.REGISTRY,
                    spec=edit_tool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=[],
    )

    assert (workspace / "notes.txt").read_text(encoding="utf-8") == "after\n"
    rewind = file_history.rewind_latest(session_id="demo")
    assert rewind.error is None
    assert rewind.restored_paths == ("notes.txt",)
    assert (workspace / "notes.txt").read_text(encoding="utf-8") == "before\n"


def test_tool_execution_records_edit_diff_in_turn_item(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    path = workspace / "notes.txt"
    path.write_text("before\n", encoding="utf-8")

    class DiffEditTool(FakeEditTool):
        def execute(self, arguments: dict[str, object]) -> ToolResult:
            target = self._workspace_root / str(arguments["path"])
            before = target.read_text(encoding="utf-8")
            target.write_text(str(arguments["new_content"]), encoding="utf-8")
            return ToolResult(
                success=True,
                summary="Edited notes.txt",
                raw_payload={
                    "path": "notes.txt",
                    "diff": "@@ -1 +1 @@\n-before\n+after",
                    "before": before,
                },
            )

    edit_tool = DiffEditTool(workspace)
    service, _fake_tool = _service(
        tmp_path,
        hook_manager=HookManager(),
        registry=ToolRegistry.from_tools([edit_tool]),
    )
    router = service._test_router  # type: ignore[attr-defined]
    turn_items = []

    service.execute_tool_call(
        conversation=Conversation(session_id="demo"),
        call=ToolCall(
            name="edit_file",
            arguments={"path": "notes.txt", "new_content": "after\n"},
            reason="edit",
            call_id="call_edit_1",
        ),
        tool_router=router,
        tool_exposure=ToolExposure(
            entries=(
                ToolExposureEntry(
                    route_key=ToolRouteKey.local("edit_file"),
                    source=ToolRouteSource.REGISTRY,
                    spec=edit_tool.spec,
                ),
            )
        ),
        plan_state=PlanState(),
        turn_id="turn_1",
        activity_events=[],
        turn_items=turn_items,
    )

    result_items = [item for item in turn_items if item.type is TurnItemType.TOOL_RESULT]
    assert result_items[0].metadata["diff"] == "@@ -1 +1 @@\n-before\n+after"
