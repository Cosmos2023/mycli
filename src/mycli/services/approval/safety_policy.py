from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import shlex

from mycli.domain.runtime import DecisionKind, RiskLevel
from mycli.domain.tooling.calls import ToolCall
from mycli.tools.path_utils import resolve_workspace_path
from mycli.tools.shell_safety import ShellRiskLevel, analyze_shell_command


@dataclass(slots=True, frozen=True)
class ToolSafetyDecision:
    kind: DecisionKind
    reason: str
    preview: str
    command_pattern: str | None = None
    metadata: dict[str, object] = field(default_factory=dict)


class SafetyPolicy:
    def __init__(
        self,
        *,
        workspace_root: Path | None = None,
        auto_approve_medium: bool = True,
    ) -> None:
        self._workspace_root = workspace_root
        self._auto_approve_medium = auto_approve_medium

    def classify(self, call: ToolCall) -> RiskLevel:
        name = _canonical_tool_name(call.name)
        if name in {
            "Read",
            "Grep",
            "Glob",
            "LS",
            "WebSearch",
            "WebFetch",
            "Lint",
            "GitStatus",
            "GitDiff",
            "GitLog",
            "GitShow",
            "AskUserQuestion",
            "Plan",
            "EnterPlanMode",
            "ExitPlanMode",
            "Skill",
            "Task",
            "BashOutput",
            "SubagentOutput",
        }:
            return RiskLevel.LOW
        if name in {"Edit", "Patch", "Write", "KillShell"}:
            return RiskLevel.MEDIUM
        if name == "Bash":
            return RiskLevel.HIGH
        return RiskLevel.HIGH

    def evaluate(self, call: ToolCall) -> ToolSafetyDecision:
        name = _canonical_tool_name(call.name)
        if name in {
            "Read",
            "Grep",
            "Glob",
            "LS",
            "WebSearch",
            "WebFetch",
            "Lint",
            "GitStatus",
            "GitDiff",
            "GitLog",
            "GitShow",
            "AskUserQuestion",
            "Plan",
            "EnterPlanMode",
            "ExitPlanMode",
            "Skill",
            "Task",
            "BashOutput",
            "SubagentOutput",
        }:
            return ToolSafetyDecision(
                kind=DecisionKind.AUTO_ALLOW,
                reason=call.reason,
                preview=name,
                metadata=_metadata(
                    call=call,
                    canonical_name=name,
                    risk_level=RiskLevel.LOW,
                    decision_kind=DecisionKind.AUTO_ALLOW,
                    policy="builtin_safe_tool",
                ),
            )
        if name in {"Edit", "Patch", "Write"}:
            boundary_decision = self._workspace_boundary_decision(call)
            if boundary_decision is not None:
                return boundary_decision
            if not self._auto_approve_medium:
                return self._medium_risk_approval_decision(call, canonical_name=name)
            return ToolSafetyDecision(
                kind=DecisionKind.AUTO_ALLOW,
                reason=call.reason,
                preview=str(
                    call.arguments.get("file_path")
                    or call.arguments.get("path")
                    or call.arguments.get("source")
                    or call.arguments.get("destination")
                    or call.arguments.get("shell_id")
                    or ""
                ),
                metadata=_metadata(
                    call=call,
                    canonical_name=name,
                    risk_level=RiskLevel.MEDIUM,
                    decision_kind=DecisionKind.AUTO_ALLOW,
                    policy="workspace_write_tool",
                ),
            )
        if name == "KillShell":
            if not self._auto_approve_medium:
                return self._medium_risk_approval_decision(call, canonical_name=name)
            return ToolSafetyDecision(
                kind=DecisionKind.AUTO_ALLOW,
                reason=call.reason,
                preview=str(call.arguments.get("shell_id") or ""),
                metadata=_metadata(
                    call=call,
                    canonical_name=name,
                    risk_level=RiskLevel.MEDIUM,
                    decision_kind=DecisionKind.AUTO_ALLOW,
                    policy="shell_control_tool",
                ),
            )
        if name == "Bash":
            command_value = call.arguments.get("command")
            args_value = call.arguments.get("args")
            if isinstance(command_value, str) and command_value:
                command = command_value
            elif isinstance(args_value, list) and args_value and all(
                isinstance(item, str) for item in args_value
            ):
                command = shlex.join(args_value)
            else:
                return ToolSafetyDecision(
                    kind=DecisionKind.DENY,
                    reason="Bash requires a non-empty command.",
                    preview="invalid shell call",
                    metadata=_metadata(
                        call=call,
                        canonical_name=name,
                        risk_level=RiskLevel.HIGH,
                        decision_kind=DecisionKind.DENY,
                        policy="invalid_shell_call",
                    ),
                )
            analysis = analyze_shell_command(command)
            if analysis.risk_level is ShellRiskLevel.DENY:
                return ToolSafetyDecision(
                    kind=DecisionKind.DENY,
                    reason=analysis.reason,
                    preview=analysis.preview,
                    command_pattern=analysis.command_pattern,
                    metadata=_metadata(
                        call=call,
                        canonical_name=name,
                        risk_level=RiskLevel.HIGH,
                        decision_kind=DecisionKind.DENY,
                        policy="shell_command_analysis",
                        command_pattern=analysis.command_pattern,
                    ),
                )
            if analysis.risk_level is ShellRiskLevel.CONFIRM:
                return ToolSafetyDecision(
                    kind=DecisionKind.NEEDS_CHOICE,
                    reason=analysis.reason,
                    preview=analysis.preview,
                    command_pattern=analysis.command_pattern,
                    metadata=_metadata(
                        call=call,
                        canonical_name=name,
                        risk_level=RiskLevel.HIGH,
                        decision_kind=DecisionKind.NEEDS_CHOICE,
                        policy="shell_command_analysis",
                        command_pattern=analysis.command_pattern,
                    ),
                )
            return ToolSafetyDecision(
                kind=DecisionKind.AUTO_ALLOW,
                reason=call.reason,
                preview=analysis.preview,
                command_pattern=analysis.command_pattern,
                metadata=_metadata(
                    call=call,
                    canonical_name=name,
                    risk_level=RiskLevel.HIGH,
                    decision_kind=DecisionKind.AUTO_ALLOW,
                    policy="shell_command_analysis",
                    command_pattern=analysis.command_pattern,
                ),
            )
        return ToolSafetyDecision(
            kind=DecisionKind.DENY,
            reason="Unsupported tool.",
            preview=call.name,
            metadata=_metadata(
                call=call,
                canonical_name=name,
                risk_level=RiskLevel.HIGH,
                decision_kind=DecisionKind.DENY,
                policy="unsupported_tool",
            ),
        )

    def _workspace_boundary_decision(
        self,
        call: ToolCall,
    ) -> ToolSafetyDecision | None:
        if self._workspace_root is None:
            return None
        raw_path = (
            call.arguments.get("file_path")
            or call.arguments.get("path")
            or call.arguments.get("target")
        )
        if not isinstance(raw_path, str) or not raw_path:
            return None
        try:
            resolve_workspace_path(self._workspace_root, raw_path)
        except ValueError as exc:
            return ToolSafetyDecision(
                kind=DecisionKind.DENY,
                reason=str(exc),
                preview=raw_path,
                metadata={
                    **_metadata(
                        call=call,
                        canonical_name=_canonical_tool_name(call.name),
                        risk_level=RiskLevel.MEDIUM,
                        decision_kind=DecisionKind.DENY,
                        policy="workspace_boundary",
                    ),
                    "path_boundary": "outside_workspace",
                },
            )
        return None

    @staticmethod
    def _medium_risk_approval_decision(
        call: ToolCall,
        *,
        canonical_name: str,
    ) -> ToolSafetyDecision:
        preview = str(
            call.arguments.get("file_path")
            or call.arguments.get("path")
            or call.arguments.get("target")
            or call.arguments.get("source")
            or call.arguments.get("destination")
            or call.arguments.get("shell_id")
            or call.arguments.get("bash_id")
            or canonical_name
        )
        return ToolSafetyDecision(
            kind=DecisionKind.NEEDS_CHOICE,
            reason=(
                f"{canonical_name} requires approval because medium-risk tools "
                "are not auto-approved."
            ),
            preview=preview,
            metadata=_metadata(
                call=call,
                canonical_name=canonical_name,
                risk_level=RiskLevel.MEDIUM,
                decision_kind=DecisionKind.NEEDS_CHOICE,
                policy="medium_risk_requires_approval",
            ),
        )


def _canonical_tool_name(name: str) -> str:
    return {
        "read_file": "Read",
        "read_file_range": "Read",
        "edit_file": "Edit",
        "patch_file": "Patch",
        "write_file": "Write",
        "search_text": "Grep",
        "list_directory": "LS",
        "run_shell": "Bash",
        "update_plan": "Plan",
        "enter_plan_mode": "EnterPlanMode",
        "exit_plan_mode": "ExitPlanMode",
    }.get(name, name)


def _metadata(
    *,
    call: ToolCall,
    canonical_name: str,
    risk_level: RiskLevel,
    decision_kind: DecisionKind,
    policy: str,
    command_pattern: str | None = None,
) -> dict[str, object]:
    metadata: dict[str, object] = {
        "tool_name": call.name,
        "canonical_tool_name": canonical_name,
        "risk_level": risk_level.value,
        "decision_kind": decision_kind.value,
        "policy": policy,
    }
    if command_pattern:
        metadata["command_pattern"] = command_pattern
    return metadata
