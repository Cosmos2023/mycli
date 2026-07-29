from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from mycli.domain.runtime import DecisionKind, RiskLevel, ShellKind, ShellProfile
from mycli.domain.tooling.calls import ToolCall
from mycli.tools.path_utils import resolve_workspace_path
from mycli.tools.shell_safety import (
    ShellRiskLevel,
    analyze_shell_argv,
    analyze_shell_command,
)
from mycli.tools.shell_safety_adapters import (
    analyze_shell_argv_for_profile,
    analyze_shell_for_profile,
)

MAX_APPROVAL_CONTENT_PREVIEW_CHARS = 12_000


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
        writable_roots: tuple[Path, ...] = (),
        auto_approve_medium: bool = True,
        shell_profile: ShellProfile | None = None,
    ) -> None:
        self._workspace_root = workspace_root
        self._writable_roots = tuple(path.resolve() for path in writable_roots)
        self._auto_approve_medium = auto_approve_medium
        self._shell_profile = shell_profile

    @property
    def shell_profile(self) -> ShellProfile | None:
        return self._shell_profile

    def configure_shell_profile(self, shell_profile: ShellProfile) -> None:
        self._shell_profile = shell_profile

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
            "Skill",
            "Task",
            "ShellOutput",
            "WriteStdin",
            "SendMessage",
            "SubagentOutput",
        }:
            return RiskLevel.LOW
        if name in {"Edit", "Patch", "Write", "KillShell"}:
            return RiskLevel.MEDIUM
        if name == "Shell":
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
            "Skill",
            "Task",
            "ShellOutput",
            "WriteStdin",
            "SendMessage",
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
            if self._targets_writable_root(call):
                return self._auto_allow_workspace_write(call, canonical_name=name)
            if not self._auto_approve_medium:
                return self._medium_risk_approval_decision(call, canonical_name=name)
            return self._auto_allow_workspace_write(call, canonical_name=name)
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
        if name == "Shell":
            command_value = call.arguments.get("command")
            args_value = call.arguments.get("args")
            if isinstance(command_value, str) and command_value:
                analysis = (
                    analyze_shell_command(command_value)
                    if self._shell_profile is None
                    else analyze_shell_for_profile(self._shell_profile, command_value)
                )
            elif isinstance(args_value, list) and args_value and all(
                isinstance(item, str) for item in args_value
            ):
                argv = tuple(args_value)
                analysis = (
                    analyze_shell_argv(argv)
                    if self._shell_profile is None
                    else analyze_shell_argv_for_profile(self._shell_profile, argv)
                )
            else:
                return ToolSafetyDecision(
                    kind=DecisionKind.DENY,
                    reason="Shell requires a non-empty command.",
                    preview="invalid shell call",
                    metadata=_metadata(
                        call=call,
                        canonical_name=name,
                        risk_level=RiskLevel.HIGH,
                        decision_kind=DecisionKind.DENY,
                        policy="invalid_shell_call",
                    ),
                )
            shell_metadata = _shell_profile_metadata(self._shell_profile)
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
                        extra=shell_metadata,
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
                        extra=shell_metadata,
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
                    extra=shell_metadata,
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
        except ValueError:
            if _is_within_writable_root(raw_path, self._writable_roots):
                return None
            canonical_name = _canonical_tool_name(call.name)
            return ToolSafetyDecision(
                kind=DecisionKind.NEEDS_CHOICE,
                reason=(
                    f"{canonical_name} targets a path outside the workspace; "
                    "workspace-write mode requires approval for this."
                ),
                preview=raw_path,
                metadata={
                    **_metadata(
                        call=call,
                        canonical_name=canonical_name,
                        risk_level=RiskLevel.MEDIUM,
                        decision_kind=DecisionKind.NEEDS_CHOICE,
                        policy="workspace_write_boundary",
                        extra=_approval_preview_metadata(
                            call=call,
                            canonical_name=canonical_name,
                        ),
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
                extra=_approval_preview_metadata(call=call, canonical_name=canonical_name),
            ),
        )

    def _targets_writable_root(self, call: ToolCall) -> bool:
        raw_path = (
            call.arguments.get("file_path")
            or call.arguments.get("path")
            or call.arguments.get("target")
        )
        return isinstance(raw_path, str) and _is_within_writable_root(
            raw_path,
            self._writable_roots,
        )

    @staticmethod
    def _auto_allow_workspace_write(
        call: ToolCall,
        *,
        canonical_name: str,
    ) -> ToolSafetyDecision:
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
                canonical_name=canonical_name,
                risk_level=RiskLevel.MEDIUM,
                decision_kind=DecisionKind.AUTO_ALLOW,
                policy="workspace_write_tool",
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
        "Shell": "Shell",
        "Bash": "Shell",
        "run_shell": "Shell",
        "ShellOutput": "ShellOutput",
        "BashOutput": "ShellOutput",
        "update_plan": "Plan",
    }.get(name, name)


def _shell_profile_metadata(profile: ShellProfile | None) -> dict[str, object] | None:
    if profile is None:
        return None
    metadata: dict[str, object] = {"shell_kind": profile.kind.value}
    if profile.kind is ShellKind.POWERSHELL and profile.powershell_edition is not None:
        metadata["shell_edition"] = profile.powershell_edition.value
    return metadata


def _metadata(
    *,
    call: ToolCall,
    canonical_name: str,
    risk_level: RiskLevel,
    decision_kind: DecisionKind,
    policy: str,
    command_pattern: str | None = None,
    extra: dict[str, object] | None = None,
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
    if extra:
        metadata.update(extra)
    return metadata


def _approval_preview_metadata(
    *,
    call: ToolCall,
    canonical_name: str,
) -> dict[str, object]:
    if canonical_name != "Write":
        return {}
    content = call.arguments.get("content", call.arguments.get("new_content"))
    if not isinstance(content, str):
        return {}
    preview, truncated = _bounded_text(content, max_chars=MAX_APPROVAL_CONTENT_PREVIEW_CHARS)
    return {
        "content_preview": preview,
        "content_line_count": _line_count(content),
        "content_chars": len(content),
        "content_truncated": truncated,
    }


def _is_within_writable_root(raw_path: str, writable_roots: tuple[Path, ...]) -> bool:
    if not writable_roots:
        return False
    try:
        resolved = Path(raw_path).expanduser().resolve()
    except (OSError, RuntimeError):
        return False
    for root in writable_roots:
        try:
            resolved.relative_to(root)
        except ValueError:
            continue
        return True
    return False


def _bounded_text(value: str, *, max_chars: int) -> tuple[str, bool]:
    if len(value) <= max_chars:
        return value, False
    return value[:max_chars], True


def _line_count(value: str) -> int:
    if not value:
        return 0
    return value.count("\n") + (0 if value.endswith("\n") else 1)
