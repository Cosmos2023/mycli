from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
import shlex
from typing import Literal, Protocol, SupportsInt

from mycli.domain.runtime.approvals import PendingApproval
from mycli.domain.runtime.execpolicy import ExecPolicyMatch, ExecPolicyRule
from mycli.domain.tooling.calls import ToolCall


FilesystemPolicy = Literal["read_only", "workspace_write", "unrestricted"]
NetworkPolicy = Literal["disabled", "enabled"]
ShellPolicy = Literal["disabled", "restricted", "enabled"]
ShellEnvPolicy = Literal["inherit", "sanitized"]
ShellBackendKind = Literal["local"]
FilesystemEffect = Literal["none", "read", "write", "unknown"]

DEFAULT_SHELL_TIMEOUT_SECONDS = 120
DEFAULT_SHELL_OUTPUT_CHAR_LIMIT = 10_000
SAFE_SHELL_ENV_KEYS = (
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "PATH",
    "PWD",
    "SHELL",
    "TERM",
    "TMPDIR",
    "USER",
)


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
class ShellBackendProfile:
    backend: ShellBackendKind = "local"
    available: bool = True
    isolation: str = "host_subprocess"
    supports_background: bool = True
    supports_interrupt_cleanup: bool = True

    def to_trace_payload(self) -> dict[str, object]:
        return {
            "backend": self.backend,
            "available": self.available,
            "isolation": self.isolation,
            "supports_background": self.supports_background,
            "supports_interrupt_cleanup": self.supports_interrupt_cleanup,
        }


@dataclass(slots=True, frozen=True)
class ShellExecutionOptions:
    workspace_root: Path
    filesystem: FilesystemPolicy = "workspace_write"
    network: NetworkPolicy = "enabled"
    shell: ShellPolicy = "restricted"
    env_policy: ShellEnvPolicy = "sanitized"
    max_timeout_seconds: int = DEFAULT_SHELL_TIMEOUT_SECONDS
    output_char_limit: int = DEFAULT_SHELL_OUTPUT_CHAR_LIMIT
    backend: ShellBackendProfile = ShellBackendProfile()

    @classmethod
    def from_policy(cls, policy: ExecutionPolicy) -> "ShellExecutionOptions":
        return cls(
            workspace_root=policy.sandbox.cwd,
            filesystem=policy.sandbox.filesystem,
            network=policy.sandbox.network,
            shell=policy.sandbox.shell,
        )

    def effective_timeout(self, requested_timeout: object) -> tuple[int, bool]:
        if isinstance(requested_timeout, str | bytes | bytearray) or isinstance(
            requested_timeout,
            SupportsInt,
        ):
            try:
                requested = int(requested_timeout)
            except (TypeError, ValueError):
                requested = self.max_timeout_seconds
        else:
            requested = self.max_timeout_seconds
        if requested < 0:
            requested = 0
        cap = max(0, self.max_timeout_seconds)
        return min(requested, cap), requested > cap

    def to_trace_payload(
        self,
        *,
        timeout_seconds: int,
        timeout_capped: bool,
        env_keys: tuple[str, ...],
        cwd: Path | str | None = None,
    ) -> dict[str, object]:
        payload: dict[str, object] = {
            "filesystem": self.filesystem,
            "network": self.network,
            "shell": self.shell,
            "env_policy": self.env_policy,
            "env_keys": list(env_keys),
            "timeout_seconds": timeout_seconds,
            "timeout_capped": timeout_capped,
            "output_char_limit": self.output_char_limit,
            "backend": self.backend.to_trace_payload(),
        }
        if cwd is not None:
            payload["cwd"] = str(cwd)
        return payload


@dataclass(slots=True, frozen=True)
class ToolRuntimeEffect:
    filesystem: FilesystemEffect = "unknown"
    network: bool = False
    process: bool = False

    def to_trace_payload(self) -> dict[str, object]:
        return {
            "filesystem": self.filesystem,
            "network": self.network,
            "process": self.process,
        }


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
    shell_backend: ShellBackendProfile = ShellBackendProfile()

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
            "shell_backend": self.shell_backend.to_trace_payload(),
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
    effect: ToolRuntimeEffect | None = None

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
        effect: ToolRuntimeEffect | None = None,
    ) -> "ToolRuntimeDecision":
        return cls(
            kind=ToolRuntimeDecisionKind.ALLOWED,
            tool_call=tool_call,
            policy=policy,
            sandbox=sandbox,
            risk_level=risk_level,
            execpolicy_rule=execpolicy_rule,
            execpolicy_argument_count=execpolicy_argument_count,
            effect=effect,
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
        effect: ToolRuntimeEffect | None = None,
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
            effect=effect,
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
        effect: ToolRuntimeEffect | None = None,
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
            effect=effect,
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
        if self.effect is not None:
            payload["effect"] = self.effect.to_trace_payload()
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
        effect: ToolRuntimeEffect | None = None,
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
                effect=effect,
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
                effect=effect,
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
            effect=effect,
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
        effect: ToolRuntimeEffect | None = None,
    ) -> ToolRuntimeDecision:
        ...
