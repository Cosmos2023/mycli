from __future__ import annotations

from typing import Any

from mycli.domain.runtime import (
    DecisionAction,
    DecisionKind,
    ExecutionContext,
    InstructionContract,
    PendingDecision,
    TurnResponse,
)
from mycli.domain.tools import ToolResult
from mycli.prompts.react import build_react_prompt
from mycli.prompts.system import build_system_prompt
from mycli.services.context.instruction_contract_assembler import InstructionContractAssembler
from mycli.services.context.turn_context_assembler import TurnContextAssembler
from mycli.services.safety_policy import SafetyPolicy


class ReactAgent:
    def __init__(
        self,
        model_client: Any,
        tool_registry: Any,
        safety_policy: SafetyPolicy | None = None,
    ) -> None:
        self._model_client = model_client
        self._tool_registry = tool_registry
        self._safety_policy = safety_policy or SafetyPolicy()
        self._turn_context_assembler = TurnContextAssembler()
        self._instruction_contract_assembler = InstructionContractAssembler()

    def _available_tool_names(self, context: ExecutionContext) -> tuple[str, ...]:
        if context.available_tool_names:
            return context.available_tool_names
        return tuple(self._tool_registry.list_names())

    def run(self, user_message: str, context: ExecutionContext) -> TurnResponse:
        progress_updates: list[str] = []
        last_tool_result: ToolResult | None = None
        available_tool_names = self._available_tool_names(context)

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
            contract = InstructionContract(
                base_instructions=contract.base_instructions,
                developer_sections=contract.developer_sections,
                contextual_user_sections=contract.contextual_user_sections,
                conversation_messages=contract.conversation_messages,
                current_user_request=contract.current_user_request,
                assistant_scaffold=build_react_prompt(contract),
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
                if decision.tool_call.name not in available_tool_names:
                    rendered_names = ", ".join(available_tool_names) or "none"
                    return TurnResponse(
                        assistant_message=(
                            f"The model requested unsupported tool "
                            f"'{decision.tool_call.name}'. Available tools: {rendered_names}."
                        ),
                        progress_updates=tuple(progress_updates),
                    )

                call = decision.tool_call
                safety = self._safety_policy.evaluate(call)

                if call.name == "edit_file" and context.config.auto_approve_medium is False:
                    preview = str(call.arguments.get("path", ""))
                    return TurnResponse(
                        assistant_message="A file edit is waiting for your decision.",
                        progress_updates=tuple(progress_updates),
                        pending_decision=PendingDecision(
                            tool_call=call,
                            kind=DecisionKind.NEEDS_CHOICE,
                            reason=call.reason,
                            preview=preview,
                            options=(DecisionAction.APPROVE_ONCE, DecisionAction.REJECT),
                        ),
                    )

                if safety.kind is DecisionKind.DENY:
                    return TurnResponse(
                        assistant_message=f"Denied: {safety.reason} (preview: {safety.preview})",
                        progress_updates=tuple(progress_updates),
                    )

                if safety.kind is DecisionKind.NEEDS_CHOICE:
                    options: list[DecisionAction] = [
                        DecisionAction.APPROVE_ONCE,
                        DecisionAction.REJECT,
                    ]
                    command_pattern: str | None = None
                    if safety.command_pattern:
                        options.append(DecisionAction.ALLOW_SESSION)
                        command_pattern = safety.command_pattern
                    return TurnResponse(
                        assistant_message="A risky action is waiting for your decision.",
                        progress_updates=tuple(progress_updates),
                        pending_decision=PendingDecision(
                            tool_call=call,
                            kind=DecisionKind.NEEDS_CHOICE,
                            reason=safety.reason,
                            preview=safety.preview,
                            options=tuple(options),
                            command_pattern=command_pattern,
                        ),
                    )

                last_tool_result = self._tool_registry.run(call)
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
