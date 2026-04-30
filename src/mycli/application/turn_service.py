from __future__ import annotations

import os
from pathlib import Path
from typing import Any, cast

from mycli.domain.capabilities import CapabilityActivation, CapabilityActivationDependencyStatus
from mycli.domain.conversation import Message
from mycli.domain.skills import SkillDefinition
from mycli.domain.runtime import (
    AgentConfig,
    DecisionAction,
    DecisionKind,
    ExecutionContext,
    InstructionContract,
    PendingDecision,
    SessionCommandAllowance,
    TurnResponse,
)
from mycli.domain.tools import ToolResult
from mycli.prompts.react import build_react_prompt
from mycli.prompts.system import build_system_prompt
from mycli.services.capability_resolver import CapabilityResolver
from mycli.services.context.instruction_contract_assembler import InstructionContractAssembler
from mycli.services.context.turn_context_assembler import TurnContextAssembler
from mycli.services.context_window_service import ContextWindowService
from mycli.infrastructure.sqlite_session_store import SQLiteSessionStore
from mycli.services.memory_service import MemoryService
from mycli.services.safety_policy import SafetyPolicy
from mycli.services.session_service import SessionService
from mycli.services.skill_registry import SkillRegistry
from mycli.services.trace_service import TraceService


class TurnService:
    def __init__(
        self,
        model_client: Any | None = None,
        tool_registry: Any | None = None,
        config: AgentConfig | None = None,
        home_dir: Path | None = None,
        runtime: Any | None = None,
    ) -> None:
        if config is None:
            raise ValueError("config is required")
        if home_dir is None:
            raise ValueError("home_dir is required")

        self._runtime = runtime
        if runtime is not None:
            self._tool_registry = getattr(runtime, "_tool_registry", tool_registry)
            self._model_client = getattr(runtime, "_model_adapter", model_client)
            self._safety_policy = getattr(runtime, "_approval_service", None)
            self._config = getattr(runtime, "_config", config)
            self._memory_service = getattr(
                runtime,
                "_memory_service",
                MemoryService(home_dir=home_dir, workspace_root=config.workspace_root),
            )
            self._session_service = getattr(
                runtime,
                "_session_service",
                SessionService(home_dir=home_dir),
            )
            self._context_window_service = None
            self._skill_registry = getattr(
                runtime,
                "_skill_registry",
                SkillRegistry(
                    builtin_root=Path(__file__).resolve().parents[1] / "prompts" / "skills",
                    user_root=home_dir / ".mycli" / "skills",
                ),
            )
            self._trace_service = getattr(
                runtime,
                "_trace_service",
                TraceService(home_dir=home_dir),
            )
            self._turn_context_assembler = getattr(runtime, "_turn_context_assembler", TurnContextAssembler())
            self._instruction_contract_assembler = getattr(
                runtime,
                "_instruction_contract_assembler",
                InstructionContractAssembler(),
            )
            self._capability_resolver = getattr(
                runtime,
                "_capability_resolver",
                CapabilityResolver(
                    skill_registry=self._skill_registry,
                    workspace_root=self._config.workspace_root,
                    env=dict(os.environ),
                ),
            )
            return

        if model_client is None or tool_registry is None:
            raise ValueError("model_client and tool_registry are required without runtime")
        self._tool_registry = tool_registry
        self._model_client = model_client
        self._safety_policy = SafetyPolicy()
        self._config = config
        session_store = SQLiteSessionStore(home_dir / ".mycli" / "sessions.db")
        self._memory_service = MemoryService(
            home_dir=home_dir,
            workspace_root=config.workspace_root,
            session_store=session_store,
        )
        self._session_service = SessionService(
            home_dir=home_dir,
            workspace_root=config.workspace_root,
            session_store=session_store,
        )
        self._context_window_service = ContextWindowService()
        self._skill_registry = SkillRegistry(
            builtin_root=Path(__file__).resolve().parents[1] / "prompts" / "skills",
            user_root=home_dir / ".mycli" / "skills",
        )
        self._trace_service = TraceService(home_dir=home_dir)
        self._turn_context_assembler = TurnContextAssembler()
        self._instruction_contract_assembler = InstructionContractAssembler()
        self._capability_resolver = CapabilityResolver(
            skill_registry=self._skill_registry,
            workspace_root=self._config.workspace_root,
            env=dict(os.environ),
        )

    def _select_skill(self, user_message: str) -> SkillDefinition | None:
        lowered = user_message.lower()
        for name in self._skill_registry.list_names():
            skill = self._skill_registry.get(name)
            if skill and any(hint in lowered for hint in skill.trigger_hints):
                return skill
        return None

    def _available_tool_names(self) -> tuple[str, ...]:
        assert self._tool_registry is not None
        return tuple(self._tool_registry.list_names())

    def _active_skill_from_activations(
        self,
        capability_activations: tuple[CapabilityActivation, ...],
    ) -> SkillDefinition | None:
        for activation in capability_activations:
            if activation.dependency_status is not CapabilityActivationDependencyStatus.READY:
                continue
            return SkillDefinition(
                name=activation.name,
                description=activation.description,
                trigger_hints=(),
                body=activation.instructions,
                source_path=activation.source_path,
            )
        return None

    def _format_allowed_choices(self, options: tuple[DecisionAction, ...]) -> str:
        choice_to_action = {
            "1": DecisionAction.APPROVE_ONCE,
            "2": DecisionAction.REJECT,
            "3": DecisionAction.ALLOW_SESSION,
        }
        allowed_choices = tuple(
            key for key, action in choice_to_action.items()
            if action in options
        )
        if len(allowed_choices) == 1:
            return allowed_choices[0]
        if len(allowed_choices) == 2:
            return f"{allowed_choices[0]} or {allowed_choices[1]}"
        return ", ".join(allowed_choices[:-1]) + f", or {allowed_choices[-1]}"

    def _run_agent(self, user_message: str, context: ExecutionContext) -> TurnResponse:
        assert self._model_client is not None
        assert self._safety_policy is not None
        assert self._tool_registry is not None
        progress_updates: list[str] = []
        last_tool_result: ToolResult | None = None
        available_tool_names = self._available_tool_names()

        for _step in range(context.config.max_steps):
            turn_context = self._turn_context_assembler.assemble(
                user_message=user_message,
                context=context,
            )
            contract = self._instruction_contract_assembler.assemble(
                turn_context=turn_context,
                base_instructions=build_system_prompt(),
                conversation_messages=context.conversation_messages,
            )
            stable_action_guidance = build_react_prompt(
                contract,
                include_context_sections=False,
                include_dynamic_guidance=False,
            )
            contract = InstructionContract(
                base_instructions=f"{contract.base_instructions}\n\n{stable_action_guidance}",
                developer_sections=contract.developer_sections,
                contextual_user_sections=contract.contextual_user_sections,
                conversation_messages=contract.conversation_messages,
                current_user_request=contract.current_user_request,
                assistant_scaffold=None,
            )
            prompt = "\n\n".join(
                [
                    contract.base_instructions,
                    "\n".join(section.content for section in contract.developer_sections),
                    "\n".join(section.content for section in contract.contextual_user_sections),
                    contract.assistant_scaffold or "",
                    f"Last tool result: {last_tool_result.summary if last_tool_result else 'none'}",
                ]
            )
            decision = self._model_client.decide(prompt)
            if decision.progress_message:
                progress_updates.append(decision.progress_message)

            if decision.tool_call is not None:
                call = decision.tool_call
                if call.name not in available_tool_names:
                    rendered_names = ", ".join(available_tool_names) or "none"
                    return TurnResponse(
                        assistant_message=(
                            f"The model requested unsupported tool '{call.name}'. "
                            f"Available tools: {rendered_names}."
                        ),
                        progress_updates=tuple(progress_updates),
                    )

                safety = self._safety_policy.evaluate(call)
                kind = safety.kind
                if safety.command_pattern and self._session_service.is_command_allowed(
                    self._config.session_id,
                    safety.command_pattern,
                ):
                    kind = DecisionKind.AUTO_ALLOW

                if kind is DecisionKind.DENY:
                    return TurnResponse(
                        assistant_message=(
                            f"Denied: {safety.reason} (preview: {safety.preview})"
                        ),
                        progress_updates=tuple(progress_updates),
                    )

                if kind is DecisionKind.NEEDS_CHOICE:
                    pending = PendingDecision(
                        tool_call=call,
                        kind=DecisionKind.NEEDS_CHOICE,
                        reason=safety.reason,
                        preview=safety.preview,
                        options=(
                            DecisionAction.APPROVE_ONCE,
                            DecisionAction.REJECT,
                            DecisionAction.ALLOW_SESSION,
                        ),
                        command_pattern=safety.command_pattern,
                    )
                    return TurnResponse(
                        assistant_message=(
                            "A risky action is waiting for your decision. "
                            "Choose 1 to approve once, 2 to reject, or 3 to allow for this session."
                        ),
                        progress_updates=tuple(progress_updates),
                        pending_decision=pending,
                    )

                try:
                    last_tool_result = self._tool_registry.run(call)
                except Exception as exc:  # pragma: no cover
                    return TurnResponse(
                        assistant_message=f"Tool execution failed: {exc}",
                        progress_updates=tuple(progress_updates),
                    )
                continue

            if decision.done and decision.assistant_message:
                return TurnResponse(
                    assistant_message=decision.assistant_message,
                    progress_updates=tuple(progress_updates),
                )

        return TurnResponse(
            assistant_message="I hit the step limit before reaching a confident answer.",
            progress_updates=tuple(progress_updates),
        )

    def handle_user_turn(self, user_message: str) -> TurnResponse:
        if self._runtime is not None:
            return cast(TurnResponse, self._runtime.handle_user_turn(user_message))

        pending_decision = self._session_service.load_pending_decision(self._config.session_id)
        if pending_decision is not None:
            return TurnResponse(
                assistant_message=(
                    "There is a pending risky action waiting for your decision. "
                    f"Please choose {self._format_allowed_choices(pending_decision.options)}."
                ),
                pending_decision=pending_decision,
            )

        conversation = self._session_service.load_conversation(self._config.session_id)
        assert self._context_window_service is not None
        context_window = self._context_window_service.build(
            conversation,
            max_prompt_tokens=self._config.max_prompt_tokens,
            compression_threshold_tokens=self._config.compression_threshold_tokens,
            recent_message_count=self._config.recent_message_count,
        )

        capability_activations = self._capability_resolver.resolve(user_message)
        context = ExecutionContext(
            config=self._config,
            memory_records=self._memory_service.collect_runtime_context(
                user_message=user_message,
                session_id=self._config.session_id,
            ),
            active_skill=self._active_skill_from_activations(capability_activations)
            or self._select_skill(user_message),
            capability_activations=capability_activations,
            available_tool_names=self._available_tool_names(),
            conversation_messages=context_window.recent_messages,
            conversation_summary=context_window.summary,
        )
        response = self._run_agent(user_message=user_message, context=context)

        conversation.append(Message(role="user", content=user_message))
        conversation.append(Message(role="assistant", content=response.assistant_message))
        self._session_service.save_conversation(conversation)
        if response.pending_decision is not None:
            self._session_service.save_pending_decision(self._config.session_id, response.pending_decision)
        else:
            self._session_service.clear_pending_decision(self._config.session_id)
        self._memory_service.append_session_summary(self._config.session_id, response.assistant_message)
        return response

    def resolve_pending_decision(self, choice: str) -> TurnResponse:
        if self._runtime is not None:
            return cast(TurnResponse, self._runtime.resolve_pending_approval(choice))

        decision = self._session_service.load_pending_decision(self._config.session_id)
        if decision is None:
            return TurnResponse(assistant_message="There is no pending decision to resolve.")

        normalized = choice.strip()
        choice_to_action = {
            "1": DecisionAction.APPROVE_ONCE,
            "2": DecisionAction.REJECT,
            "3": DecisionAction.ALLOW_SESSION,
        }
        allowed_choices = tuple(
            key for key, action in choice_to_action.items()
            if action in decision.options
        )
        if normalized not in allowed_choices:
            return TurnResponse(
                assistant_message=f"Please choose {self._format_allowed_choices(decision.options)}.",
                pending_decision=decision,
            )
        selected_action = choice_to_action[normalized]

        if selected_action is DecisionAction.REJECT:
            self._session_service.clear_pending_decision(self._config.session_id)
            message = f"Rejected {decision.tool_call.name}. Pending decision cleared."
            self._memory_service.append_session_summary(self._config.session_id, message)
            return TurnResponse(
                assistant_message=message,
                progress_updates=("[decision] rejected",),
            )

        if decision.tool_call.name not in self._available_tool_names():
            self._session_service.clear_pending_decision(self._config.session_id)
            message = (
                f"Pending decision uses unsupported tool '{decision.tool_call.name}' and was cleared."
            )
            self._memory_service.append_session_summary(self._config.session_id, message)
            return TurnResponse(
                assistant_message=message,
                progress_updates=("[decision] cleared invalid tool",),
            )

        if selected_action is DecisionAction.ALLOW_SESSION:
            if decision.command_pattern:
                self._session_service.add_command_allowance(
                    self._config.session_id,
                    SessionCommandAllowance(command_pattern=decision.command_pattern),
                )

        assert self._tool_registry is not None
        try:
            tool_result = self._tool_registry.run(decision.tool_call)
        except Exception as exc:
            self._session_service.clear_pending_decision(self._config.session_id)
            message = (
                f"Pending decision could not be executed: {exc}. "
                "The pending decision was cleared."
            )
            self._memory_service.append_session_summary(self._config.session_id, message)
            return TurnResponse(
                assistant_message=message,
                progress_updates=("[decision] failed",),
            )

        self._session_service.clear_pending_decision(self._config.session_id)
        if not tool_result.success:
            message = (
                f"Pending decision could not be executed: "
                f"{tool_result.error or tool_result.summary}. The pending decision was cleared."
            )
            self._memory_service.append_session_summary(self._config.session_id, message)
            return TurnResponse(
                assistant_message=message,
                progress_updates=("[decision] failed",),
            )

        if selected_action is DecisionAction.ALLOW_SESSION and decision.command_pattern:
            message = (
                f"Approved {decision.tool_call.name}: {tool_result.summary}. "
                f"Allowlisted '{decision.command_pattern}' for this session."
            )
        else:
            message = f"Approved {decision.tool_call.name}: {tool_result.summary}"
        self._memory_service.append_session_summary(self._config.session_id, message)
        return TurnResponse(
            assistant_message=message,
            progress_updates=("[decision] approved",),
        )

    def confirm_pending_action(self) -> TurnResponse:
        # Compatibility shim for older CLI commands (/confirm).
        return self.resolve_pending_decision("1")

    def reject_pending_action(self) -> TurnResponse:
        # Compatibility shim for older CLI commands (/reject).
        return self.resolve_pending_decision("2")

    def inspect_plan(self) -> tuple[str, ...]:
        plan_state = self._session_service.load_plan_state(self._config.session_id)
        if not plan_state.items:
            return ("no active plan",)
        return tuple(
            f"{item.status.value}: {item.content}"
            for item in plan_state.items
        )

    def inspect_skills(self) -> tuple[str, ...]:
        lines: list[str] = []
        for name in self._skill_registry.list_names():
            metadata = self._skill_registry.get_metadata(name)
            if metadata is None:
                continue
            lines.append(f"{metadata.name}: {metadata.description}")
        return tuple(lines or ("no skills available",))

    def inspect_tools(self) -> tuple[str, ...]:
        specs = getattr(self._tool_registry, "specs", None)
        if not isinstance(specs, dict):
            return tuple(self._available_tool_names())
        return tuple(
            f"{spec.name} [{spec.risk_level}]: {spec.description}"
            for spec in specs.values()
        )

    def inspect_memory(self) -> tuple[str, ...]:
        records = self._memory_service.list_records(self._config.session_id)
        lines = [
            f"{record.kind.value} {record.key}={record.value}"
            for record in records[:10]
        ]
        if not lines:
            return ("no memory stored",)
        return tuple(lines)

    def inspect_session(self) -> tuple[str, ...]:
        conversation = self._session_service.load_conversation(self._config.session_id)
        plan_state = self._session_service.load_plan_state(self._config.session_id)
        pending_decision = self._session_service.load_pending_decision(self._config.session_id)
        suspended = self._session_service.load_suspended_turn(self._config.session_id)
        allowances = self._session_service.load_command_allowances(self._config.session_id)
        return (
            f"session={self._config.session_id}",
            f"messages={len(conversation.messages)}",
            f"plan_items={len(plan_state.items)}",
            f"pending_decision={'yes' if pending_decision is not None else 'no'}",
            f"suspended_turn={'yes' if suspended is not None else 'no'}",
            f"allowances={len(allowances)}",
        )

    def inspect_sessions(self) -> tuple[str, ...]:
        overviews = self._session_service.list_sessions(limit=10)
        if not overviews:
            return ("no saved sessions",)
        lines: list[str] = []
        for overview in overviews:
            current_marker = "*" if overview.session_id == self._config.session_id else " "
            lines.append(
                f"{current_marker} {overview.session_id} {overview.status} "
                f"messages={overview.message_count} summaries={overview.summary_count}"
            )
        return tuple(lines)

    def inspect_trace(self) -> tuple[str, ...]:
        events = self._trace_service.load(self._config.session_id)
        if not events:
            return ("no trace events",)
        high_signal_events = tuple(event for event in events if event.kind != "turn_item")
        visible_events = high_signal_events[-10:] if high_signal_events else events[-10:]
        lines: list[str] = []
        for event in visible_events:
            parts = [event.kind]
            tool_name = event.payload.get("tool_name")
            if isinstance(tool_name, str) and tool_name:
                parts.append(tool_name)
            route_name = event.payload.get("route_name")
            if isinstance(route_name, str) and route_name and route_name not in parts:
                parts.append(route_name)

            arguments = event.payload.get("arguments")
            if isinstance(arguments, dict):
                args = arguments.get("args")
                if isinstance(args, list) and args and all(isinstance(item, str) for item in args):
                    parts.append(f"args={' '.join(args)}")

            for key in ("scope", "state", "source"):
                value = event.payload.get(key)
                if isinstance(value, str) and value:
                    parts.append(f"{key}={value}")

            summary = event.payload.get("summary")
            if isinstance(summary, str) and summary:
                parts.append(f"summary={summary}")

            stdout_preview = event.payload.get("stdout_preview")
            if isinstance(stdout_preview, str) and stdout_preview:
                parts.append(f"stdout={stdout_preview}")

            stderr_preview = event.payload.get("stderr_preview")
            if isinstance(stderr_preview, str) and stderr_preview:
                parts.append(f"stderr={stderr_preview}")

            lines.append(" ".join(parts))
        return tuple(lines)
