from __future__ import annotations

from mycli.domain.conversation import Message
from mycli.domain.memory import MemoryRecord
from mycli.domain.runtime import (
    ExecutionContext,
    HistoryItemType,
    PlanItem,
    PlanState,
    PlanStatus,
    TurnContext,
    TurnContextSection,
    TurnContextSectionType,
)


class TurnContextAssembler:
    def assemble(
        self,
        *,
        user_message: str,
        context: ExecutionContext,
        workspace_instructions: str | None = None,
    ) -> TurnContext:
        workspace_content = self._workspace_instructions(context, workspace_instructions)
        memory_records = self._deduplicated_memory_records(context)
        memory_content = self._render_memory(memory_records)
        runtime_reminders_content = self._render_runtime_reminders(context)
        sections = (
            TurnContextSection(
                type=TurnContextSectionType.BASE_INSTRUCTIONS,
                title="Base instructions",
                content="Follow the runtime operating rules already provided in the system prompt.",
                enabled=True,
                source="system_prompt",
            ),
            TurnContextSection(
                type=TurnContextSectionType.WORKSPACE_INSTRUCTIONS,
                title="Workspace instructions",
                content=workspace_content,
                enabled=bool(workspace_content),
                source="workspace" if workspace_instructions else "baseline",
            ),
            TurnContextSection(
                type=TurnContextSectionType.ENVIRONMENT_CONTEXT,
                title="Environment context",
                content=self._render_environment_context(context),
                enabled=True,
                source="runtime",
                metadata={
                    "workspace_root": str(context.config.workspace_root),
                    "session_id": context.config.session_id,
                    "model": context.config.model,
                    "protocol": context.config.protocol,
                },
            ),
            TurnContextSection(
                type=TurnContextSectionType.CONVERSATION_CONTEXT,
                title="Conversation context",
                content=self._render_conversation_context(context),
                enabled=bool(
                    context.conversation_summary
                    or context.conversation_messages
                    or context.history_items
                ),
                source="conversation",
            ),
            TurnContextSection(
                type=TurnContextSectionType.MEMORY,
                title="Memory",
                content=memory_content,
                enabled=bool(memory_records),
                source="memory",
            ),
            TurnContextSection(
                type=TurnContextSectionType.PLAN,
                title="Current plan",
                content=self._render_plan(context),
                enabled=bool(context.plan_state.items),
                source="plan",
            ),
            TurnContextSection(
                type=TurnContextSectionType.RUNTIME_REMINDERS,
                title="Runtime reminders",
                content=runtime_reminders_content,
                enabled=bool(runtime_reminders_content),
                source="runtime",
            ),
            TurnContextSection(
                type=TurnContextSectionType.SKILL_CATALOG,
                title="Skill catalog",
                content=context.skill_catalog,
                enabled=bool(context.skill_catalog),
                source="skill_registry",
            ),
            TurnContextSection(
                type=TurnContextSectionType.TOOL_EXPOSURE,
                title="Tool exposure",
                content=self._render_tool_exposure(context),
                enabled=bool(context.tool_exposure is not None and context.tool_exposure.all_entries())
                or bool(context.available_tool_names),
                source="tool_registry",
                metadata=self._tool_exposure_metadata(context),
            ),
            TurnContextSection(
                type=TurnContextSectionType.USER_REQUEST,
                title="Current user request",
                content=f"Current user request: {user_message}",
                enabled=True,
                source="user",
            ),
        )
        return TurnContext(user_message=user_message, sections=sections)

    def _render_environment_context(self, context: ExecutionContext) -> str:
        runtime_context = f"Workspace root: {context.config.workspace_root}"
        baseline_environment = self._deduplicated_environment_baseline(
            self._baseline_fragment_content(context, "environment_context")
        )
        if baseline_environment:
            return f"{baseline_environment}\n{runtime_context}"
        return runtime_context

    def _deduplicated_environment_baseline(self, content: str) -> str:
        if not content:
            return ""
        dynamic_prefixes = (
            "这是本轮相关的环境事实。",
            "Workspace root:",
            "Session id:",
            "Model:",
            "Protocol:",
        )
        lines: list[str] = []
        seen: set[str] = set()
        for raw_line in content.splitlines():
            line = raw_line.strip()
            if not line or line in seen:
                continue
            if line.startswith(dynamic_prefixes):
                continue
            lines.append(line)
            seen.add(line)
        return "\n".join(lines)

    def _render_conversation_context(self, context: ExecutionContext) -> str:
        messages = context.conversation_messages or self._messages_from_history(context)
        summary = context.conversation_summary or ("none" if not messages else "Derived from structured history.")
        return (
            f"Conversation summary: {summary}\n"
            f"Recent conversation:\n{self._render_messages(messages)}"
        )

    def _render_messages(self, messages: tuple[Message, ...]) -> str:
        if not messages:
            return "none"
        return "\n".join(f"{message.role}: {message.content}" for message in messages)

    def _messages_from_history(self, context: ExecutionContext) -> tuple[Message, ...]:
        messages: list[Message] = []
        for item in context.history_items:
            if item.type is HistoryItemType.USER_MESSAGE:
                messages.append(Message(role="user", content=item.text or ""))
            elif item.type is HistoryItemType.ASSISTANT_MESSAGE:
                messages.append(Message(role="assistant", content=item.text or ""))
            elif item.type is HistoryItemType.TOOL_RESULT:
                messages.append(Message(role="tool", content=item.text or ""))
        return tuple(messages)

    def _workspace_instructions(
        self,
        context: ExecutionContext,
        workspace_instructions: str | None,
    ) -> str:
        if workspace_instructions:
            return workspace_instructions
        return self._baseline_fragment_content(context, "workspace_instructions")

    def _baseline_fragment_content(
        self,
        context: ExecutionContext,
        kind: str,
    ) -> str:
        baseline = context.context_baseline
        if baseline is None:
            return ""
        fragments = [fragment.content for fragment in baseline.fragments if fragment.kind == kind]
        return "\n".join(fragment for fragment in fragments if fragment)

    def _render_memory(self, records: tuple[MemoryRecord, ...]) -> str:
        return "Memory: " + ("; ".join(record.value for record in records) or "none")

    def _deduplicated_memory_records(self, context: ExecutionContext) -> tuple[MemoryRecord, ...]:
        replay_texts = self._replay_texts(context)
        if not replay_texts:
            return context.memory_records
        return tuple(
            record
            for record in context.memory_records
            if self._normalized_text(record.value) not in replay_texts
        )

    def _replay_texts(self, context: ExecutionContext) -> set[str]:
        texts: set[str] = set()
        messages = (*context.conversation_messages, *self._messages_from_history(context))
        for message in messages:
            content = message.content or Message.text_content_from_blocks(message.blocks)
            self._add_replay_text(texts, content)
            if content:
                self._add_replay_text(texts, f"{message.role}: {content}")
        return texts

    def _add_replay_text(self, texts: set[str], value: str) -> None:
        normalized = self._normalized_text(value)
        if normalized:
            texts.add(normalized)

    def _normalized_text(self, value: str) -> str:
        return " ".join(value.split())

    def _render_plan(self, context: ExecutionContext) -> str:
        if not context.plan_state.items:
            return "Current plan: none"

        counts = self._plan_status_counts(context.plan_state)
        lines = [
            "Current plan:",
            (
                "Plan status: "
                f"completed={counts[PlanStatus.COMPLETED]}, "
                f"in_progress={counts[PlanStatus.IN_PROGRESS]}, "
                f"pending={counts[PlanStatus.PENDING]}"
            ),
        ]
        current_item = self._current_plan_item(context.plan_state)
        if current_item is not None:
            lines.append(f"Current: {current_item.content}")
        pending_items = self._pending_plan_items(context.plan_state)
        if pending_items:
            lines.append("Next:")
            lines.extend(f"- {item.content}" for item in pending_items[:2])
        return "\n".join(lines)

    def _plan_status_counts(self, plan_state: PlanState) -> dict[PlanStatus, int]:
        return {
            status: sum(1 for item in plan_state.items if item.status is status)
            for status in PlanStatus
        }

    def _current_plan_item(self, plan_state: PlanState) -> PlanItem | None:
        for item in plan_state.items:
            if item.status is PlanStatus.IN_PROGRESS:
                return item
        return None

    def _pending_plan_items(self, plan_state: PlanState) -> tuple[PlanItem, ...]:
        return tuple(item for item in plan_state.items if item.status is PlanStatus.PENDING)

    def _render_runtime_reminders(self, context: ExecutionContext) -> str:
        rehydration_reminders = tuple(
            item
            for item in context.runtime_reminders
            if item.startswith("[Compaction rehydration]")
        )
        if not rehydration_reminders:
            return ""
        reminders = "\n".join(f"- {item}" for item in rehydration_reminders)
        return "\n".join(("Runtime reminders:", reminders))

    def _render_tool_exposure(self, context: ExecutionContext) -> str:
        if context.tool_exposure is not None:
            summary = context.tool_exposure.summary()
            tool_names = sorted(summary["tools"])
            tools = ", ".join(dict.fromkeys(tool_names)) or "none"
            return f"Available tools: {tools}"
        tools = ", ".join(context.available_tool_names) or "none"
        return f"Available tools: {tools}"

    def _tool_exposure_metadata(self, context: ExecutionContext) -> dict[str, object]:
        if context.tool_exposure is None:
            return {"tool_names": list(context.available_tool_names)}
        summary = context.tool_exposure.summary()
        return {
            "tool_names": sorted(summary["tools"]),
        }
