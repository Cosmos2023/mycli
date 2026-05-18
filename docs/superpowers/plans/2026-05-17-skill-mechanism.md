# Skill Mechanism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace trigger-hint skill activation with model-driven Skill tool activation, visible skill catalog context, and same-turn context rebuild after activation.

**Architecture:** Skill metadata is always available as a volatile request context section. The model activates a skill by calling a first-class `Skill` tool; the tool result carries a structured `raw_payload`, `ToolExecutionService` records a `SKILL_ACTIVATED` turn item, and `TurnExecutor` appends a `CapabilityActivation` before continuing the same turn. Explicit `$skill-name` activation remains supported, but substring `trigger_hints` activation is removed.

**Tech Stack:** Python 3.13, pytest, existing mycli runtime/tooling/context layers.

**Spec:** `docs/superpowers/specs/2026-05-17-skill-mechanism.md`

---

## Current Code Anchors

- `SkillRegistry.load()` and `get_metadata()` already exist in `src/mycli/services/skills/registry.py`.
- Real CLI builds a manual `ToolRegistry.from_tools([...])` in `src/mycli/cli/bootstrap.py`; do not rely only on `default_tools()`.
- `AgentRuntime.__init__()` creates `_skill_registry` after receiving `tool_registry`, then passes the original registry into `ToolExposurePlanner`, `ToolOrchestrator`, and `RuntimeContextBuilder`.
- `ToolExecutionService._record_tool_outcome()` already records `TurnItemType.TOOL_RESULT` with `metadata["raw_payload"]`; this is the correct place to append skill activation turn items.
- `TurnExecutor._run_turn_loop()` is the same-turn loop. Capture the turn item index before `_consume_assistant_blocks()` and inspect only newly appended items after it returns.
- `InstructionContractAssembler` does not automatically pass new `TurnContextSectionType` values through. Any new skill catalog section needs an explicit assembler branch.
- `RequestShapeBuilder._responses_contextual_section_is_model_visible()` allowlists contextual fragment kinds for the `responses` protocol. Add `skill_catalog` there or the catalog will be invisible for responses requests.

## File Map

- Create `src/mycli/tools/skill.py`: first-class Skill tool that loads skill bodies and returns structured activation payloads.
- Modify `src/mycli/tools/registry.py`: add `ToolRegistry.register()` and keep `default_tools(workspace_root)` simple.
- Modify `src/mycli/application/runtime/agent_runtime.py`: register `SkillTool` after `_skill_registry` exists and route every runtime service through `self._tool_registry`.
- Create `src/mycli/services/context/skill_catalog.py`: render name/description catalog only, not skill bodies.
- Modify `src/mycli/domain/runtime/__init__.py`: add `ExecutionContext.skill_catalog`.
- Modify `src/mycli/domain/runtime/turn_context.py`: add `TurnContextSectionType.SKILL_CATALOG`.
- Modify `src/mycli/domain/runtime/instruction_contract.py`: add `InstructionFragmentKind.SKILL_CATALOG`.
- Modify `src/mycli/services/context/turn_context_assembler.py`: add deterministic skill catalog section.
- Modify `src/mycli/services/context/instruction_contract_assembler.py`: convert catalog section into a model-visible contextual fragment.
- Modify `src/mycli/application/runtime/request/request_shape_builder.py`: allow `skill_catalog` in responses delta context.
- Modify `src/mycli/domain/runtime/protocol.py`: add `TurnItemType.SKILL_ACTIVATED`.
- Modify `src/mycli/application/runtime/tools/tool_execution_service.py`: append `SKILL_ACTIVATED` after successful Skill tool results.
- Modify `src/mycli/application/runtime/turn_executor.py`: convert newly appended `SKILL_ACTIVATED` items into active capabilities and continue the same turn.
- Modify `src/mycli/services/capabilities/resolver.py`: remove trigger-hint scan, preserve `$name`.
- Modify `src/mycli/application/runtime/context/runtime_context_builder.py`: remove `select_skill_metadata()` and `load_selected_skill()` fallback; populate skill catalog.
- Modify `src/mycli/application/turn_service.py`: remove unused `_select_skill()`.
- Update tests under `tests/unit/` for tool, context, request shape, activation flow, and resolver cleanup.

---

### Task 1: Add Skill Tool And Runtime Registration

**Files:**
- Create: `src/mycli/tools/skill.py`
- Modify: `src/mycli/tools/registry.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Test: `tests/unit/tools/test_skill_tool.py`
- Test: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Write failing SkillTool tests**

Add `tests/unit/tools/test_skill_tool.py`:

```python
from __future__ import annotations

from pathlib import Path

from mycli.tools.skill import SkillTool
from mycli.services.skills import SkillRegistry


def _write_skill(root: Path, name: str = "code-review") -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / f"{name}.md").write_text(
        "---\n"
        f'name = "{name}"\n'
        'description = "Review code for correctness risks"\n'
        'trigger_hints = ["review"]\n'
        "---\n"
        "Find correctness bugs before style issues.\n",
        encoding="utf-8",
    )


def test_skill_tool_returns_activation_payload(tmp_path: Path) -> None:
    builtin = tmp_path / "builtin"
    user = tmp_path / "home" / ".mycli" / "skills"
    _write_skill(builtin)
    registry = SkillRegistry(builtin_root=builtin, user_root=user)

    result = SkillTool(registry).execute({"skill_name": "code-review"})

    assert result.success is True
    assert result.summary == "Activated skill: code-review"
    assert result.raw_payload["kind"] == "skill_activation"
    assert result.raw_payload["skill_name"] == "code-review"
    assert result.raw_payload["description"] == "Review code for correctness risks"
    assert result.raw_payload["body"] == "Find correctness bugs before style issues."
    assert result.raw_payload["source_path"].endswith("code-review.md")


def test_skill_tool_rejects_missing_or_unknown_skill(tmp_path: Path) -> None:
    registry = SkillRegistry(
        builtin_root=tmp_path / "builtin",
        user_root=tmp_path / "home" / ".mycli" / "skills",
    )

    missing_name = SkillTool(registry).execute({})
    unknown = SkillTool(registry).execute({"skill_name": "missing"})

    assert missing_name.success is False
    assert "skill_name is required" in str(missing_name.error)
    assert unknown.success is False
    assert "not found" in str(unknown.error)
```

- [ ] **Step 2: Run the new tests and confirm failure**

Run:

```bash
uv run pytest tests/unit/tools/test_skill_tool.py -q
```

Expected: FAIL because `mycli.tools.skill` does not exist.

- [ ] **Step 3: Implement SkillTool**

Create `src/mycli/tools/skill.py`:

```python
from __future__ import annotations

from typing import Any

from mycli.domain.tooling.calls import ToolCall
from mycli.services.skills import SkillRegistry
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec


class SkillTool:
    spec = ToolSpec(
        name="Skill",
        description=(
            "Load a skill's detailed instructions when the available skill catalog "
            "shows that the skill is relevant to the current task."
        ),
        parameters=(
            ToolParameter(
                name="skill_name",
                type="string",
                required=True,
                description="Exact skill name from the available skill catalog.",
            ),
        ),
        risk_level="low",
    )

    def __init__(self, skill_registry: SkillRegistry) -> None:
        self._skill_registry = skill_registry

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        skill_name = str(arguments.get("skill_name", "")).strip()
        if not skill_name:
            return ToolResult(
                success=False,
                summary="Failed to activate skill",
                error="skill_name is required.",
            )

        skill = self._skill_registry.load(skill_name)
        if skill is None:
            return ToolResult(
                success=False,
                summary=f"Failed to activate skill: {skill_name}",
                error=f"Skill '{skill_name}' not found.",
            )

        return ToolResult(
            success=True,
            summary=f"Activated skill: {skill.name}",
            raw_payload={
                "kind": "skill_activation",
                "skill_name": skill.name,
                "description": skill.description,
                "body": skill.body,
                "source_path": skill.source_path,
                "env_dependencies": list(skill.env_dependencies),
                "workspace_dependencies": list(skill.workspace_dependencies),
                "guardrails": list(skill.guardrails),
            },
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)
```

- [ ] **Step 4: Add registry registration helper**

In `src/mycli/tools/registry.py`, add this method to `ToolRegistry`:

```python
    def register(self, tool: SchemaTool) -> None:
        assert self.specs is not None
        assert self.executors is not None
        self.specs[tool.spec.name] = tool.spec
        self.executors[tool.spec.name] = tool
```

Do not change the `default_tools(workspace_root: Path)` signature in this task. The real CLI currently constructs a manual registry, so runtime injection is the safer single path.

- [ ] **Step 5: Wire SkillTool into AgentRuntime after skill registry creation**

In `src/mycli/application/runtime/agent_runtime.py`, import `SkillTool`:

```python
from mycli.tools.skill import SkillTool
```

After `_skill_registry` is created, register the tool:

```python
        self._skill_registry = skill_registry or SkillRegistry(
            builtin_root=Path(__file__).resolve().parents[2] / "prompts" / "skills",
            user_root=home_dir / ".mycli" / "skills",
        )
        self._tool_registry.register(SkillTool(self._skill_registry))
```

Then replace every constructor argument in this `__init__()` that still passes the local `tool_registry` with `self._tool_registry`:

```python
        self._tool_exposure_planner = ToolExposurePlanner(tool_registry=self._tool_registry)
        ...
        self._tool_orchestrator = ToolOrchestrator(
            session_id=config.session_id,
            tool_registry=self._tool_registry,
            ...
        )
        ...
        self._runtime_context_builder = RuntimeContextBuilder(
            ...
            tool_registry=self._tool_registry,
            ...
        )
```

This is required because real CLI uses `ToolRegistry.from_tools([...])`; adding Skill only to `default_tools()` would not affect the real runtime path.

- [ ] **Step 6: Add runtime registration test**

Append to `tests/unit/application/test_agent_runtime.py`:

```python
def test_agent_runtime_registers_skill_tool_from_skill_registry(tmp_path: Path) -> None:
    runtime = AgentRuntime.for_tests(
        workspace_root=tmp_path,
        home_dir=tmp_path / "home",
        model_adapter=LegacySingleTurnCaptureAdapter(),
    )

    assert "Skill" in runtime._tool_registry.list_names()
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
uv run pytest tests/unit/tools/test_skill_tool.py tests/unit/application/test_agent_runtime.py::test_agent_runtime_registers_skill_tool_from_skill_registry -q
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/mycli/tools/skill.py src/mycli/tools/registry.py src/mycli/application/runtime/agent_runtime.py tests/unit/tools/test_skill_tool.py tests/unit/application/test_agent_runtime.py
git commit -m "Add model-driven Skill tool registration"
```

---

### Task 2: Add Skill Catalog To Model-Visible Context

**Files:**
- Create: `src/mycli/services/context/skill_catalog.py`
- Modify: `src/mycli/domain/runtime/__init__.py`
- Modify: `src/mycli/domain/runtime/turn_context.py`
- Modify: `src/mycli/domain/runtime/instruction_contract.py`
- Modify: `src/mycli/application/runtime/context/runtime_context_builder.py`
- Modify: `src/mycli/services/context/turn_context_assembler.py`
- Modify: `src/mycli/services/context/instruction_contract_assembler.py`
- Modify: `src/mycli/application/runtime/request/request_shape_builder.py`
- Test: `tests/unit/services/test_skill_catalog.py`
- Test: `tests/unit/services/test_turn_context_assembler.py`
- Test: `tests/unit/services/test_instruction_contract_assembler.py`
- Test: `tests/unit/services/test_request_shape_builder.py`

- [ ] **Step 1: Write failing skill catalog renderer tests**

Add `tests/unit/services/test_skill_catalog.py`:

```python
from __future__ import annotations

from pathlib import Path

from mycli.services.context.skill_catalog import render_skill_catalog
from mycli.services.skills import SkillRegistry


def test_render_skill_catalog_lists_names_and_descriptions(tmp_path: Path) -> None:
    builtin = tmp_path / "builtin"
    user = tmp_path / "home" / ".mycli" / "skills"
    builtin.mkdir(parents=True)
    (builtin / "code-review.md").write_text(
        "---\n"
        'name = "code-review"\n'
        'description = "Review code for correctness risks"\n'
        'trigger_hints = ["review"]\n'
        "---\n"
        "Body is not part of catalog.\n",
        encoding="utf-8",
    )
    registry = SkillRegistry(builtin_root=builtin, user_root=user)

    catalog = render_skill_catalog(registry)

    assert "Available skills:" in catalog
    assert "- code-review: Review code for correctness risks" in catalog
    assert "Body is not part of catalog" not in catalog
    assert "Use the Skill tool" in catalog


def test_render_skill_catalog_is_empty_without_skills(tmp_path: Path) -> None:
    registry = SkillRegistry(
        builtin_root=tmp_path / "builtin",
        user_root=tmp_path / "home" / ".mycli" / "skills",
    )

    assert render_skill_catalog(registry) == ""
```

- [ ] **Step 2: Run renderer tests and confirm failure**

Run:

```bash
uv run pytest tests/unit/services/test_skill_catalog.py -q
```

Expected: FAIL because `skill_catalog.py` does not exist.

- [ ] **Step 3: Implement skill catalog renderer**

Create `src/mycli/services/context/skill_catalog.py`:

```python
from __future__ import annotations

from mycli.services.skills import SkillRegistry


def render_skill_catalog(skill_registry: SkillRegistry) -> str:
    lines = ["Available skills:"]
    for name in skill_registry.list_names():
        metadata = skill_registry.get_metadata(name)
        if metadata is None:
            continue
        lines.append(f"- {metadata.name}: {metadata.description}")

    if len(lines) == 1:
        return ""

    lines.append("")
    lines.append(
        "Use the Skill tool with the exact skill name when one of these descriptions "
        "matches the current task. Do not infer or load skill bodies from this catalog."
    )
    return "\n".join(lines)
```

- [ ] **Step 4: Add domain enum and context fields**

In `src/mycli/domain/runtime/__init__.py`, add a field to `ExecutionContext`:

```python
    skill_catalog: str = ""
```

In `src/mycli/domain/runtime/turn_context.py`, add:

```python
    SKILL_CATALOG = "skill_catalog"
```

In `src/mycli/domain/runtime/instruction_contract.py`, add:

```python
    SKILL_CATALOG = "skill_catalog"
```

- [ ] **Step 5: Populate skill catalog in RuntimeContextBuilder**

In `src/mycli/application/runtime/context/runtime_context_builder.py`, import:

```python
from mycli.services.context.skill_catalog import render_skill_catalog
```

In `build_context()`, pass:

```python
            skill_catalog=render_skill_catalog(self._skill_registry),
```

Keep this independent from `active_skill`. Catalog is metadata; active skill body is a separate capability section.

- [ ] **Step 6: Add catalog section in TurnContextAssembler**

In `src/mycli/services/context/turn_context_assembler.py`, insert the section before `CAPABILITY` so metadata appears before loaded body:

```python
            TurnContextSection(
                type=TurnContextSectionType.SKILL_CATALOG,
                title="Skill catalog",
                content=context.skill_catalog,
                enabled=bool(context.skill_catalog),
                source="skill_registry",
            ),
```

Update `tests/unit/services/test_turn_context_assembler.py::test_turn_context_assembler_builds_deterministic_sections` expected section order and debug summary by inserting `TurnContextSectionType.SKILL_CATALOG` / `"skill_catalog"` before capability. Add this assertion:

```python
    skill_catalog_section = next(
        section for section in turn_context.sections
        if section.type is TurnContextSectionType.SKILL_CATALOG
    )
    assert skill_catalog_section.enabled is False
```

Replace existing positional assertions that assume `turn_context.sections[8]` is the tool exposure section with type-based lookup:

```python
    tool_exposure_section = next(
        section for section in turn_context.sections
        if section.type is TurnContextSectionType.TOOL_EXPOSURE
    )
    assert "workspace_summary" in tool_exposure_section.content
```

Also add a direct enabled case:

```python
def test_turn_context_assembler_renders_skill_catalog_section() -> None:
    turn_context = TurnContextAssembler().assemble(
        user_message="review this",
        context=ExecutionContext(
            config=AgentConfig(workspace_root=Path("/tmp/workspace")),
            skill_catalog="Available skills:\n- code-review: Review code",
        ),
    )

    section = next(
        section for section in turn_context.sections
        if section.type is TurnContextSectionType.SKILL_CATALOG
    )
    assert section.enabled is True
    assert section.source == "skill_registry"
    assert "code-review" in section.content
```

- [ ] **Step 7: Convert catalog section in InstructionContractAssembler**

In `src/mycli/services/context/instruction_contract_assembler.py`, add a branch before `CAPABILITY`:

```python
            if section.type is TurnContextSectionType.SKILL_CATALOG:
                contextual_user_sections.append(
                    self._directed_fragment(
                        section=section,
                        kind=InstructionFragmentKind.SKILL_CATALOG,
                        include_in_memory=False,
                        prefix=(
                            "这是本轮可用的 skill 目录。目录只包含名称和描述；"
                            "需要详细指令时，调用 Skill 工具加载对应 skill。"
                        ),
                    )
                )
                continue
```

In `tests/unit/services/test_instruction_contract_assembler.py`, add `skill_catalog` to the `ExecutionContext` used by `test_instruction_contract_assembler_layers_turn_context_into_base_developer_and_contextual_fragments`:

```python
            skill_catalog="Available skills:\n- code-review: Review code",
```

Update the expected contextual kinds list to include `"skill_catalog"` before `"capability_body"`:

```python
    assert [fragment.kind for fragment in contract.contextual_user_sections] == [
        "workspace_instructions",
        "environment_context",
        "runtime_reminders",
        "skill_catalog",
        "capability_body",
    ]
```

Add an assertion:

```python
    skill_catalog_fragment = next(
        fragment for fragment in contract.contextual_user_sections
        if fragment.kind == "skill_catalog"
    )
    assert "调用 Skill 工具" in skill_catalog_fragment.content
```

- [ ] **Step 8: Make catalog visible to responses protocol**

In `src/mycli/application/runtime/request/request_shape_builder.py`, update `_responses_contextual_section_is_model_visible()`:

```python
        return str(section.kind) in {
            "capability_body",
            "memory",
            "runtime_reminders",
            "skill_catalog",
            "workspace_instructions",
        }
```

Add to `tests/unit/services/test_request_shape_builder.py`:

```python
def test_request_shape_builder_includes_skill_catalog_in_responses_delta_context(
    tmp_path: Path,
) -> None:
    shape = RequestShapeBuilder().build(
        config=AgentConfig(workspace_root=tmp_path, protocol=ProtocolId.RESPONSES),
        contract=InstructionContract(
            base_instructions="Stable system rules.",
            contextual_user_sections=(
                InstructionFragment(
                    kind="skill_catalog",
                    title="Skill catalog",
                    content="Available skills:\n- code-review: Review code",
                ),
            ),
            current_user_request="review this",
        ),
        tools=(_tool("Skill"),),
    )

    user_messages = [message.content for message in shape.provider_messages if message.role == "user"]
    assert any("Available skills" in str(content) for content in user_messages)
```

- [ ] **Step 9: Run focused context tests**

Run:

```bash
uv run pytest \
  tests/unit/services/test_skill_catalog.py \
  tests/unit/services/test_turn_context_assembler.py \
  tests/unit/services/test_instruction_contract_assembler.py \
  tests/unit/services/test_request_shape_builder.py::test_request_shape_builder_includes_skill_catalog_in_responses_delta_context \
  -q
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/mycli/services/context/skill_catalog.py src/mycli/domain/runtime/__init__.py src/mycli/domain/runtime/turn_context.py src/mycli/domain/runtime/instruction_contract.py src/mycli/application/runtime/context/runtime_context_builder.py src/mycli/services/context/turn_context_assembler.py src/mycli/services/context/instruction_contract_assembler.py src/mycli/application/runtime/request/request_shape_builder.py tests/unit/services/test_skill_catalog.py tests/unit/services/test_turn_context_assembler.py tests/unit/services/test_instruction_contract_assembler.py tests/unit/services/test_request_shape_builder.py
git commit -m "Expose skill catalog as model-visible context"
```

---

### Task 3: Add Same-Turn Skill Activation Flow

**Files:**
- Modify: `src/mycli/domain/runtime/protocol.py`
- Modify: `src/mycli/application/runtime/tools/tool_execution_service.py`
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Test: `tests/unit/application/test_tool_execution_service.py`
- Test: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Add failing ToolExecutionService test**

Append to `tests/unit/application/test_tool_execution_service.py`:

```python
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
                "kind": "skill_activation",
                "skill_name": str(arguments["skill_name"]),
                "description": "Review code",
                "body": "Find correctness bugs first.",
                "source_path": "/tmp/code-review.md",
            },
        )


def test_tool_execution_service_records_skill_activation_turn_item(tmp_path: Path) -> None:
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

    assert any(item.type is TurnItemType.TOOL_RESULT for item in turn_items)
    activation = next(item for item in turn_items if item.type is TurnItemType.SKILL_ACTIVATED)
    assert activation.tool_name == "Skill"
    assert activation.call_id == "call_skill"
    assert activation.metadata["skill_name"] == "code-review"
    assert activation.metadata["body"] == "Find correctness bugs first."
```

- [ ] **Step 2: Run the test and confirm failure**

Run:

```bash
uv run pytest tests/unit/application/test_tool_execution_service.py::test_tool_execution_service_records_skill_activation_turn_item -q
```

Expected: FAIL because `TurnItemType.SKILL_ACTIVATED` does not exist.

- [ ] **Step 3: Add `SKILL_ACTIVATED` turn item type**

In `src/mycli/domain/runtime/protocol.py`, add to `TurnItemType`:

```python
    SKILL_ACTIVATED = "skill_activated"
```

- [ ] **Step 4: Append activation turn item from real tool result path**

In `src/mycli/application/runtime/tools/tool_execution_service.py`, add a private helper:

```python
    def _skill_activation_turn_item(
        self,
        *,
        result: ToolResult,
        normalized_call: ToolCall,
    ) -> TurnItem | None:
        if not result.success:
            return None
        if result.raw_payload.get("kind") != "skill_activation":
            return None
        skill_name = str(result.raw_payload.get("skill_name", "")).strip()
        body = str(result.raw_payload.get("body", "")).strip()
        if not skill_name or not body:
            return None
        return TurnItem(
            type=TurnItemType.SKILL_ACTIVATED,
            text=f"Skill activated: {skill_name}",
            tool_name=normalized_call.name,
            call_id=normalized_call.call_id,
            metadata=dict(result.raw_payload),
        )
```

In `_record_tool_outcome()`, immediately after appending the existing `TOOL_RESULT`, add:

```python
        skill_activation_item = self._skill_activation_turn_item(
            result=result,
            normalized_call=normalized_call,
        )
        if skill_activation_item is not None:
            self._append_turn_item(
                turn_id=turn_id,
                turn_items=turn_items,
                item=skill_activation_item,
            )
```

- [ ] **Step 5: Add same-turn AgentRuntime test**

Append to `tests/unit/application/test_agent_runtime.py`:

```python
class SkillThenAnswerAdapter:
    def __init__(self) -> None:
        self.seen_messages: list[list[object]] = []
        self.seen_tools: list[list[object]] = []
        self.calls = 0

    def next_action(self, *, messages, tools):
        self.calls += 1
        self.seen_messages.append(list(messages))
        self.seen_tools.append(list(tools))
        if self.calls == 1:
            return type(
                "Action",
                (),
                {
                    "assistant_message": "",
                    "progress_message": None,
                    "tool_call": {
                        "name": "Skill",
                        "arguments": {"skill_name": "code-review"},
                        "reason": "Need review rules",
                    },
                    "done": False,
                },
            )()
        return type(
            "Action",
            (),
            {
                "assistant_message": "Reviewed with skill.",
                "progress_message": None,
                "tool_call": None,
                "done": True,
            },
        )()


def test_agent_runtime_continues_same_turn_after_skill_activation(tmp_path: Path) -> None:
    builtin_dir = tmp_path / "builtin-skills"
    user_dir = tmp_path / "home" / ".mycli" / "skills"
    builtin_dir.mkdir(parents=True)
    user_dir.mkdir(parents=True)
    (builtin_dir / "code-review.md").write_text(
        "---\n"
        'name = "code-review"\n'
        'description = "Review code"\n'
        'trigger_hints = ["review"]\n'
        "---\n"
        "Find correctness bugs first.\n",
        encoding="utf-8",
    )
    adapter = SkillThenAnswerAdapter()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistry.from_tools([PlanTool()]),
        config=AgentConfig(workspace_root=tmp_path),
        home_dir=tmp_path / "home",
        skill_registry=SkillRegistry(builtin_root=builtin_dir, user_root=user_dir),
    )

    response = runtime.handle_user_turn("review this change")

    assert response.assistant_message == "Reviewed with skill."
    assert adapter.calls == 2
    assert any(getattr(tool, "name", "") == "Skill" for tool in adapter.seen_tools[0])
    second_request_text = "\n".join(
        str(getattr(message, "content", "")) for message in adapter.seen_messages[1]
    )
    assert "Find correctness bugs first." in second_request_text
    assert response.turn is not None
    assert any(item.type is TurnItemType.SKILL_ACTIVATED for item in response.turn.items)
```

- [ ] **Step 6: Implement same-turn activation in TurnExecutor**

In `src/mycli/application/runtime/turn_executor.py`, import runtime capability types at top:

```python
from mycli.domain.capabilities import (
    CapabilityActivation,
    CapabilityActivationDependencyStatus,
    CapabilityActivationSource,
)
```

Remove the `TYPE_CHECKING` import for `CapabilityActivation` if it becomes unused.

Add helper methods to `TurnExecutor`:

```python
    def _new_skill_activations(
        self,
        *,
        turn_items: list[TurnItem],
        start_index: int,
        existing: tuple[CapabilityActivation, ...],
    ) -> tuple[CapabilityActivation, ...]:
        existing_names = {activation.name for activation in existing}
        activations: list[CapabilityActivation] = []
        for item in turn_items[start_index:]:
            if item.type is not TurnItemType.SKILL_ACTIVATED:
                continue
            skill_name = str(item.metadata.get("skill_name", "")).strip()
            body = str(item.metadata.get("body", "")).strip()
            if not skill_name or not body or skill_name in existing_names:
                continue
            existing_names.add(skill_name)
            activations.append(
                CapabilityActivation(
                    name=skill_name,
                    description=str(item.metadata.get("description", "")),
                    instructions=body,
                    source=CapabilityActivationSource.EXPLICIT_MENTION,
                    dependency_status=CapabilityActivationDependencyStatus.READY,
                    source_path=str(item.metadata.get("source_path", "")),
                    metadata={
                        "activated_by_tool": item.tool_name or "Skill",
                        "tool_call_id": item.call_id,
                    },
                )
            )
        return tuple(activations)
```

In `_run_turn_loop()`, immediately before `_consume_assistant_blocks()`, capture the index:

```python
            turn_item_start = len(turn_items)
```

Immediately after `_consume_assistant_blocks()` returns and before `if early_response is not None:`, add:

```python
            new_skill_activations = self._new_skill_activations(
                turn_items=turn_items,
                start_index=turn_item_start,
                existing=capability_activations,
            )
            if new_skill_activations:
                capability_activations = (*capability_activations, *new_skill_activations)
                runtime._append_capability_turn_items(
                    turn_id=turn_id,
                    turn_items=turn_items,
                    capability_activations=new_skill_activations,
                )
                no_progress_tracker.update(conversation)
                step_index += 1
                continue
```

Do not scan all `turn_items`; only scan `turn_items[turn_item_start:]`. Otherwise old skill activations will be replayed on every loop.

- [ ] **Step 7: Run activation flow tests**

Run:

```bash
uv run pytest \
  tests/unit/application/test_tool_execution_service.py::test_tool_execution_service_records_skill_activation_turn_item \
  tests/unit/application/test_agent_runtime.py::test_agent_runtime_continues_same_turn_after_skill_activation \
  -q
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/mycli/domain/runtime/protocol.py src/mycli/application/runtime/tools/tool_execution_service.py src/mycli/application/runtime/turn_executor.py tests/unit/application/test_tool_execution_service.py tests/unit/application/test_agent_runtime.py
git commit -m "Continue same turn after Skill activation"
```

---

### Task 4: Remove Trigger-Hint Activation And Legacy Fallbacks

**Files:**
- Modify: `src/mycli/services/capabilities/resolver.py`
- Modify: `src/mycli/domain/capabilities.py`
- Modify: `src/mycli/application/runtime/context/runtime_context_builder.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/turn_service.py`
- Test: `tests/unit/services/test_capability_resolver.py`
- Test: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Update resolver tests to lock new behavior**

In `tests/unit/services/test_capability_resolver.py`, replace `test_capability_resolver_keeps_trigger_hint_activation` with:

```python
def test_capability_resolver_ignores_trigger_hints_without_explicit_mention(
    tmp_path: Path,
) -> None:
    (tmp_path / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")
    resolver = CapabilityResolver(
        skill_registry=_build_registry(tmp_path),
        workspace_root=tmp_path,
        env={},
    )

    activations = resolver.resolve("inspect this repo for me")

    assert activations == ()
```

Keep these existing tests:

- `test_capability_resolver_supports_explicit_mentions`
- `test_capability_resolver_prefers_explicit_mentions_over_trigger_hints`
- dependency status tests using `$deployment` / `$repository-analysis`

Change the assertion in `test_capability_resolver_prefers_explicit_mentions_over_trigger_hints` only if needed; it should still pass because explicit `$repository-analysis` remains the only activation path.

- [ ] **Step 2: Run resolver tests and confirm failure**

Run:

```bash
uv run pytest tests/unit/services/test_capability_resolver.py -q
```

Expected: FAIL because trigger hints still activate skills.

- [ ] **Step 3: Remove trigger-hint scan from CapabilityResolver**

In `src/mycli/services/capabilities/resolver.py`, delete this block from `resolve()`:

```python
        lowered = user_message.lower()
        for name in self._skill_registry.list_names():
            if name in resolved:
                continue
            metadata = self._skill_registry.get_metadata(name)
            if metadata is None:
                continue
            if not any(hint in lowered for hint in metadata.trigger_hints):
                continue
            skill = self._skill_registry.load(name)
            if skill is None:
                continue
            resolved[name] = self._activation_from_skill(
                skill,
                source=CapabilityActivationSource.TRIGGER_HINT,
            )
```

Keep `_explicit_mentions()` and dependency checking unchanged.

- [ ] **Step 4: Remove `TRIGGER_HINT` activation source if unused**

Run:

```bash
rg -n "TRIGGER_HINT|trigger_hint" src tests
```

If only tests and `CapabilityActivationSource` refer to it after Step 3, remove this enum member from `src/mycli/domain/capabilities.py`:

```python
    TRIGGER_HINT = "trigger_hint"
```

If persisted historical turn records can contain `"trigger_hint"`, keep the enum member and add a comment:

```python
    TRIGGER_HINT = "trigger_hint"  # Historical turn records only; no new activations use it.
```

Prefer removal only when the focused and full tests prove it is safe.

- [ ] **Step 5: Remove runtime fallback skill selection**

In `src/mycli/application/runtime/context/runtime_context_builder.py`:

Remove imports that become unused:

```python
from mycli.domain.skills import SkillMetadata
```

Delete methods:

```python
    def select_skill_metadata(...)
    def load_selected_skill(...)
```

Change `build_context()`:

```python
            active_skill=self.active_skill_from_activations(capability_activations),
```

Do not call `load_selected_skill(user_message)`.

- [ ] **Step 6: Remove AgentRuntime passthrough methods**

In `src/mycli/application/runtime/agent_runtime.py`, delete:

```python
    def _select_skill_metadata(...)
    def _load_selected_skill(...)
```

Remove unused imports `SkillDefinition` or `SkillMetadata` only if no other method still needs them. `_active_skill_from_activations()` currently returns `SkillDefinition | None`, so keep `SkillDefinition` while that method exists.

- [ ] **Step 7: Remove legacy TurnService skill selector**

In `src/mycli/application/turn_service.py`, run:

```bash
rg -n "_select_skill\\(" src tests
```

If the only definition is in `turn_service.py`, delete:

```python
    def _select_skill(self, user_message: str) -> SkillDefinition | None:
        lowered = user_message.lower()
        for name in self._skill_registry.list_names():
            skill = self._skill_registry.get(name)
            if skill and any(hint in lowered for hint in skill.trigger_hints):
                return skill
        return None
```

Then remove the now-unused `SkillDefinition` import from that file if type checking reports it unused.

- [ ] **Step 8: Update old AgentRuntime trigger-hint tests**

In `tests/unit/application/test_agent_runtime.py`, old tests around `test_agent_runtime_injects_loaded_skill_instructions_into_messages` expect `"inspect this repo"` to trigger by `trigger_hints`. Replace that test with a catalog assertion:

```python
def test_agent_runtime_exposes_skill_catalog_without_auto_loading_body(tmp_path: Path) -> None:
    builtin_dir = tmp_path / "builtin-skills"
    user_dir = tmp_path / "home" / ".mycli" / "skills"
    builtin_dir.mkdir(parents=True)
    user_dir.mkdir(parents=True)
    (builtin_dir / "repository-analysis.md").write_text(
        "---\n"
        'name = "repository-analysis"\n'
        'description = "Inspect repos"\n'
        'trigger_hints = ["repo"]\n'
        "---\n"
        "Inspect repositories before answering.\n",
        encoding="utf-8",
    )

    adapter = SkillCaptureAdapter()
    runtime = AgentRuntime(
        model_adapter=adapter,
        tool_registry=ToolRegistry.from_tools([PlanTool()]),
        config=AgentConfig(workspace_root=tmp_path),
        home_dir=tmp_path / "home",
        skill_registry=SkillRegistry(builtin_root=builtin_dir, user_root=user_dir),
    )

    response = runtime.handle_user_turn("inspect this repo")

    assert response.assistant_message == "Skill captured"
    first_request_text = "\n".join(str(message.content) for message in adapter.seen_messages[0])
    assert "repository-analysis: Inspect repos" in first_request_text
    assert "Inspect repositories before answering." not in first_request_text
```

Keep `test_agent_runtime_records_capability_turn_item_and_prompt_context` with explicit `$repository-analysis`; it should still verify `$name` activation and capability body injection.

- [ ] **Step 9: Run cleanup-focused tests**

Run:

```bash
uv run pytest \
  tests/unit/services/test_capability_resolver.py \
  tests/unit/application/test_agent_runtime.py::test_agent_runtime_exposes_skill_catalog_without_auto_loading_body \
  tests/unit/application/test_agent_runtime.py::test_agent_runtime_records_capability_turn_item_and_prompt_context \
  -q
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/mycli/services/capabilities/resolver.py src/mycli/domain/capabilities.py src/mycli/application/runtime/context/runtime_context_builder.py src/mycli/application/runtime/agent_runtime.py src/mycli/application/turn_service.py tests/unit/services/test_capability_resolver.py tests/unit/application/test_agent_runtime.py
git commit -m "Remove trigger-hint skill activation"
```

---

### Task 5: Integration Verification

**Files:**
- Modify only if tests reveal a real gap.

- [ ] **Step 1: Run all skill-related tests**

Run:

```bash
uv run pytest \
  tests/unit/tools/test_skill_tool.py \
  tests/unit/services/test_skill_catalog.py \
  tests/unit/services/test_capability_resolver.py \
  tests/unit/services/test_turn_context_assembler.py \
  tests/unit/services/test_instruction_contract_assembler.py \
  tests/unit/services/test_request_shape_builder.py \
  tests/unit/application/test_tool_execution_service.py \
  tests/unit/application/test_agent_runtime.py \
  -q
```

Expected: PASS.

- [ ] **Step 2: Run static checks**

Run:

```bash
uv run ruff check src tests
```

Expected: PASS. Fix only issues introduced by this change.

- [ ] **Step 3: Run type check**

Run:

```bash
uv run mypy src/mycli
```

Expected: PASS, or existing unrelated errors documented clearly with the first unrelated error line.

- [ ] **Step 4: Run full tests if local time budget allows**

Run:

```bash
uv run pytest -q
```

Expected: PASS, or document unrelated failures with exact failing test names.

- [ ] **Step 5: Manual smoke shape check**

Use a fake model or focused runtime test to confirm this sequence:

1. First request contains skill catalog and `Skill` tool schema.
2. Model calls `Skill({"skill_name": "code-review"})`.
3. Tool result produces `TOOL_RESULT` plus `SKILL_ACTIVATED`.
4. Same turn continues without returning to user.
5. Second request contains loaded skill body in capability context.
6. User-visible final answer is produced from the second model call.

If this is not covered by `test_agent_runtime_continues_same_turn_after_skill_activation`, add assertions there instead of doing an untracked manual-only check.

---

## Completion Checklist

- [ ] `Skill` appears in `AgentRuntime.for_tests(...)._tool_registry.list_names()`.
- [ ] Real CLI path gets `Skill` because `AgentRuntime.__init__()` registers it after `_skill_registry` exists.
- [ ] Skill catalog is a volatile model-visible context fragment, not static `system.py`.
- [ ] Catalog contains skill names and descriptions only; it does not include skill bodies.
- [ ] `responses` protocol requests include `skill_catalog`.
- [ ] Successful `Skill` tool results append `TurnItemType.SKILL_ACTIVATED`.
- [ ] `TurnExecutor` only scans newly appended turn items to avoid repeated activation loops.
- [ ] Skill activation continues the same turn and rebuilds context with active capability body.
- [ ] `$skill-name` explicit activation still works.
- [ ] `trigger_hints` no longer auto-activates skills from user text.
- [ ] Legacy fallback selectors are removed or proven unused.
- [ ] Focused tests, lint, and type checks have been run or documented with unrelated existing failures.

## Self-Review Notes

- This plan intentionally does not render the catalog in `src/mycli/prompts/system.py`; doing so would bloat stable prompt prefix and mix volatile skill metadata with static instructions.
- This plan intentionally does not modify `default_tools()` to require a `SkillRegistry`; real CLI bypasses `default_tools()` and constructs `ToolRegistry.from_tools([...])`, so runtime registration is the reliable path.
- This plan intentionally records skill activation in `ToolExecutionService`, not `AssistantBlockConsumer`, because `_record_tool_outcome()` is where successful tool results and `raw_payload` are available.
- This plan explicitly updates `InstructionContractAssembler` and `RequestShapeBuilder`; adding a `TurnContextSection` alone is insufficient.
