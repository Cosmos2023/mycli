from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
import shlex
from typing import Literal, Protocol

from mycli.domain.runtime.approvals import PendingApproval
from mycli.domain.runtime.execpolicy import ExecPolicyMatch, ExecPolicyRule
from mycli.domain.tooling.calls import ToolCall


FilesystemPolicy = Literal["read_only", "workspace_write", "unrestricted"]
NetworkPolicy = Literal["disabled", "enabled"]
ShellPolicy = Literal["disabled", "restricted", "enabled"]


class ToolRuntimeDecisionKind(StrEnum):
    ALLOWED = "allowed"
    DENIED = "denied"
    NEEDS_APPROVAL = "needs_approval"


@dataclass(slots=True, frozen=True)
class SandboxProfile:
    workspace_roots: tuple[Path, ...]
    cwd: Path
    filesystem: FilesystemPolicy = "workspace_write"
    network: NetworkPolicy = "enabled"
    shell: ShellPolicy = "restricted"

    def to_trace_payload(self) -> dict[str, object]:
        return {
            "workspace_roots": len(self.workspace_roots),
            "filesystem": self.filesystem,
            "network": self.network,
            "shell": self.shell,
        }


@dataclass(slots=True, frozen=True)
class ExecutionPolicy:
    sandbox: SandboxProfile
    approval_policy: str = "safety_policy"
    command_policy: str = "shell_safety_analysis"
    file_policy: str = "workspace_boundary"
    tool_policy: str = "tool_exposure"

    @classmethod
    def for_workspace(cls, workspace_root: Path) -> "ExecutionPolicy":
        resolved = workspace_root.resolve()
        return cls(
            sandbox=SandboxProfile(
                workspace_roots=(resolved,),
                cwd=resolved,
            )
        )


@dataclass(slots=True, frozen=True)
class RuntimeEnvironmentContract:
    workspace_root: Path
    filesystem: FilesystemPolicy
    network: NetworkPolicy
    shell: ShellPolicy
    approval_policy: str
    command_policy: str
    file_policy: str
    tool_policy: str
    execpolicy_status: str = "disabled"
    execpolicy_rule_count: int = 0
    execpolicy_sources: tuple[str, ...] = ()

    @classmethod
    def from_policy(
        cls,
        policy: ExecutionPolicy,
        *,
        execpolicy_rule_count: int = 0,
        execpolicy_sources: tuple[str, ...] = (),
    ) -> "RuntimeEnvironmentContract":
        normalized_sources = tuple(sorted(set(execpolicy_sources)))
        return cls(
            workspace_root=policy.sandbox.cwd,
            filesystem=policy.sandbox.filesystem,
            network=policy.sandbox.network,
            shell=policy.sandbox.shell,
            approval_policy=policy.approval_policy,
            command_policy=policy.command_policy,
            file_policy=policy.file_policy,
            tool_policy=policy.tool_policy,
            execpolicy_status="enabled" if execpolicy_rule_count > 0 else "disabled",
            execpolicy_rule_count=max(0, execpolicy_rule_count),
            execpolicy_sources=normalized_sources,
        )

    def to_metadata(self) -> dict[str, object]:
        return {
            "workspace_root": str(self.workspace_root),
            "filesystem": self.filesystem,
            "network": self.network,
            "shell": self.shell,
            "approval_policy": self.approval_policy,
            "command_policy": self.command_policy,
            "file_policy": self.file_policy,
            "tool_policy": self.tool_policy,
            "execpolicy_status": self.execpolicy_status,
            "execpolicy_rule_count": self.execpolicy_rule_count,
            "execpolicy_sources": list(self.execpolicy_sources),
        }


@dataclass(slots=True, frozen=True)
class ToolRuntimeDecision:
    kind: ToolRuntimeDecisionKind
    tool_call: ToolCall
    policy: str
    sandbox: SandboxProfile
    risk_level: str | None = None
    reason_code: str | None = None
    pending_approval: PendingApproval | None = None
    execpolicy_rule: ExecPolicyRule | None = None
    execpolicy_argument_count: int | None = None

    @classmethod
    def allowed(
        cls,
        *,
        tool_call: ToolCall,
        policy: str,
        sandbox: SandboxProfile,
        risk_level: str | None = None,
        execpolicy_rule: ExecPolicyRule | None = None,
        execpolicy_argument_count: int | None = None,
    ) -> "ToolRuntimeDecision":
        return cls(
            kind=ToolRuntimeDecisionKind.ALLOWED,
            tool_call=tool_call,
            policy=policy,
            sandbox=sandbox,
            risk_level=risk_level,
            execpolicy_rule=execpolicy_rule,
            execpolicy_argument_count=execpolicy_argument_count,
        )

    @classmethod
    def denied(
        cls,
        *,
        tool_call: ToolCall,
        policy: str,
        sandbox: SandboxProfile,
        risk_level: str | None = None,
        reason_code: str | None = None,
        execpolicy_rule: ExecPolicyRule | None = None,
        execpolicy_argument_count: int | None = None,
    ) -> "ToolRuntimeDecision":
        return cls(
            kind=ToolRuntimeDecisionKind.DENIED,
            tool_call=tool_call,
            policy=policy,
            sandbox=sandbox,
            risk_level=risk_level,
            reason_code=reason_code,
            execpolicy_rule=execpolicy_rule,
            execpolicy_argument_count=execpolicy_argument_count,
        )

    @classmethod
    def needs_approval(
        cls,
        *,
        tool_call: ToolCall,
        policy: str,
        sandbox: SandboxProfile,
        pending_approval: PendingApproval,
        risk_level: str | None = None,
        reason_code: str | None = None,
        execpolicy_rule: ExecPolicyRule | None = None,
        execpolicy_argument_count: int | None = None,
    ) -> "ToolRuntimeDecision":
        return cls(
            kind=ToolRuntimeDecisionKind.NEEDS_APPROVAL,
            tool_call=tool_call,
            policy=policy,
            sandbox=sandbox,
            risk_level=risk_level,
            reason_code=reason_code,
            pending_approval=pending_approval,
            execpolicy_rule=execpolicy_rule,
            execpolicy_argument_count=execpolicy_argument_count,
        )

    def to_trace_payload(self) -> dict[str, object]:
        argument_keys = tuple(sorted(str(key) for key in self.tool_call.arguments))
        payload: dict[str, object] = {
            "tool_name": self.tool_call.name,
            "tool_call_id": self.tool_call.call_id or "",
            "decision": self.kind.value,
            "policy": self.policy,
            "risk_level": self.risk_level,
            "argument_count": len(argument_keys),
            "argument_keys": list(argument_keys),
            "approval_required": self.kind is ToolRuntimeDecisionKind.NEEDS_APPROVAL,
            "reason_code": self.reason_code,
            "sandbox": self.sandbox.to_trace_payload(),
        }
        if self.execpolicy_rule is not None:
            payload.update(
                self.execpolicy_rule.to_trace_payload(
                    argument_count=(
                        self.execpolicy_argument_count
                        if self.execpolicy_argument_count is not None
                        else _shell_argument_count(self.tool_call)
                    )
                )
            )
        return payload

    @classmethod
    def from_execpolicy_match(
        cls,
        *,
        tool_call: ToolCall,
        match: ExecPolicyMatch,
        sandbox: SandboxProfile,
    ) -> "ToolRuntimeDecision":
        rule = match.rule
        if rule.decision == "allow":
            return cls.allowed(
                tool_call=tool_call,
                policy="execpolicy_prefix_rule",
                risk_level="high",
                sandbox=sandbox,
                execpolicy_rule=rule,
                execpolicy_argument_count=match.argument_count,
            )
        if rule.decision == "deny":
            return cls.denied(
                tool_call=tool_call,
                policy="execpolicy_prefix_rule",
                risk_level="high",
                reason_code="execpolicy_deny",
                sandbox=sandbox,
                execpolicy_rule=rule,
                execpolicy_argument_count=match.argument_count,
            )
        return cls.needs_approval(
            tool_call=tool_call,
            policy="execpolicy_prefix_rule",
            risk_level="high",
            reason_code="execpolicy_ask",
            pending_approval=PendingApproval(
                tool_call=tool_call,
                reason="Shell command requires approval by execpolicy rule.",
                preview=f"execpolicy:{rule.pattern_hash}",
                command_pattern=None,
            ),
            sandbox=sandbox,
            execpolicy_rule=rule,
            execpolicy_argument_count=match.argument_count,
        )


def _shell_argument_count(tool_call: ToolCall) -> int:
    args_value = tool_call.arguments.get("args")
    if isinstance(args_value, list) and all(isinstance(item, str) for item in args_value):
        return len(args_value)
    command_value = tool_call.arguments.get("command")
    if isinstance(command_value, str) and command_value:
        try:
            return len(shlex.split(command_value))
        except ValueError:
            return 0
    return 0


@dataclass(slots=True, frozen=True)
class ToolRuntimeResult:
    decision: ToolRuntimeDecision
    executed: bool


class ApprovalGate(Protocol):
    def decide(
        self,
        call: ToolCall,
        policy: ExecutionPolicy,
    ) -> ToolRuntimeDecision:
        ...
