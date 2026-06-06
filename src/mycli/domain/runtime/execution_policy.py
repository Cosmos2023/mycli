from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Literal, Protocol

from mycli.domain.runtime.approvals import PendingApproval
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
class ToolRuntimeDecision:
    kind: ToolRuntimeDecisionKind
    tool_call: ToolCall
    policy: str
    sandbox: SandboxProfile
    risk_level: str | None = None
    reason_code: str | None = None
    pending_approval: PendingApproval | None = None

    @classmethod
    def allowed(
        cls,
        *,
        tool_call: ToolCall,
        policy: str,
        sandbox: SandboxProfile,
        risk_level: str | None = None,
    ) -> "ToolRuntimeDecision":
        return cls(
            kind=ToolRuntimeDecisionKind.ALLOWED,
            tool_call=tool_call,
            policy=policy,
            sandbox=sandbox,
            risk_level=risk_level,
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
    ) -> "ToolRuntimeDecision":
        return cls(
            kind=ToolRuntimeDecisionKind.DENIED,
            tool_call=tool_call,
            policy=policy,
            sandbox=sandbox,
            risk_level=risk_level,
            reason_code=reason_code,
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
    ) -> "ToolRuntimeDecision":
        return cls(
            kind=ToolRuntimeDecisionKind.NEEDS_APPROVAL,
            tool_call=tool_call,
            policy=policy,
            sandbox=sandbox,
            risk_level=risk_level,
            reason_code=reason_code,
            pending_approval=pending_approval,
        )

    def to_trace_payload(self) -> dict[str, object]:
        argument_keys = tuple(sorted(str(key) for key in self.tool_call.arguments))
        return {
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
