from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
import shlex
from typing import Literal, Mapping, Protocol, SupportsInt

from mycli.domain.runtime.approvals import PendingApproval
from mycli.domain.runtime.execpolicy import ExecPolicyMatch, ExecPolicyRule
from mycli.domain.tooling.calls import ToolCall


FilesystemPolicy = Literal["read_only", "workspace_write", "unrestricted"]
NetworkPolicy = Literal["disabled", "enabled"]
ShellPolicy = Literal["disabled", "restricted", "enabled"]
ShellEnvPolicy = Literal["inherit", "sanitized"]
ShellEnvironmentInheritMode = Literal["all", "core", "none"]
ShellBackendKind = Literal["local"]
FilesystemEffect = Literal["none", "read", "write", "unknown"]
ToolRuntimeCoverageLevel = Literal["full", "partial", "external"]

DEFAULT_SHELL_TIMEOUT_SECONDS = 120
DEFAULT_SHELL_OUTPUT_CHAR_LIMIT = 10_000
DEFAULT_DENIED_READ_GLOBS = ("**/.env", "**/.env.*")
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
DEFAULT_SHELL_ENV_EXCLUDES = ("*KEY*", "*SECRET*", "*TOKEN*")


class SandboxMode(StrEnum):
    READ_ONLY = "read-only"
    WORKSPACE_WRITE = "workspace-write"
    DANGER_FULL_ACCESS = "danger-full-access"


@dataclass(slots=True, frozen=True)
class SandboxModePolicy:
    filesystem: FilesystemPolicy
    network: NetworkPolicy
    shell: ShellPolicy
    workspace_writable: bool


SANDBOX_MODE_POLICIES: Mapping[SandboxMode, SandboxModePolicy] = {
    SandboxMode.READ_ONLY: SandboxModePolicy(
        filesystem="read_only",
        network="disabled",
        shell="restricted",
        workspace_writable=False,
    ),
    SandboxMode.WORKSPACE_WRITE: SandboxModePolicy(
        filesystem="workspace_write",
        network="disabled",
        shell="restricted",
        workspace_writable=True,
    ),
    SandboxMode.DANGER_FULL_ACCESS: SandboxModePolicy(
        filesystem="unrestricted",
        network="enabled",
        shell="enabled",
        workspace_writable=True,
    ),
}


@dataclass(slots=True, frozen=True)
class ShellEnvironmentPolicy:
    inherit: ShellEnvironmentInheritMode = "core"
    ignore_default_excludes: bool = False
    exclude: tuple[str, ...] = ()
    set: Mapping[str, str] | None = None
    include_only: tuple[str, ...] = ()
    thread_id: str | None = None

    @classmethod
    def sanitized(cls, *, workspace_root: Path) -> "ShellEnvironmentPolicy":
        return cls(
            inherit="core",
            set={"PWD": str(workspace_root)},
        )

    @classmethod
    def inherit_all(cls) -> "ShellEnvironmentPolicy":
        return cls(
            inherit="all",
            ignore_default_excludes=True,
        )

    def to_trace_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "inherit": self.inherit,
            "ignore_default_excludes": self.ignore_default_excludes,
            "exclude_count": len(self.exclude),
            "set_keys": sorted((self.set or {}).keys()),
            "include_only_count": len(self.include_only),
        }
        if self.thread_id is not None:
            payload["thread_id_set"] = True
        return payload


class ToolRuntimeDecisionKind(StrEnum):
    ALLOWED = "allowed"
    DENIED = "denied"
    NEEDS_APPROVAL = "needs_approval"


@dataclass(slots=True, frozen=True)
class SandboxProfile:
    workspace_roots: tuple[Path, ...]
    cwd: Path
    writable_roots: tuple[Path, ...] = ()
    denied_read_roots: tuple[Path, ...] = ()
    denied_read_globs: tuple[str, ...] = ()
    filesystem: FilesystemPolicy = "workspace_write"
    network: NetworkPolicy = "disabled"
    shell: ShellPolicy = "restricted"
    mode: SandboxMode = SandboxMode.WORKSPACE_WRITE

    def to_trace_payload(self) -> dict[str, object]:
        return {
            "workspace_roots": len(self.workspace_roots),
            "writable_roots": len(self.writable_roots),
            "denied_read_roots": len(self.denied_read_roots),
            "denied_read_globs": len(self.denied_read_globs),
            "sandbox_mode": self.mode.value,
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
    def for_workspace(
        cls,
        workspace_root: Path,
        *,
        sandbox_mode: SandboxMode = SandboxMode.WORKSPACE_WRITE,
    ) -> "ExecutionPolicy":
        resolved = workspace_root.resolve()
        mode_policy = SANDBOX_MODE_POLICIES[sandbox_mode]
        return cls(
            sandbox=SandboxProfile(
                workspace_roots=(resolved,),
                cwd=resolved,
                mode=sandbox_mode,
                writable_roots=(resolved,) if mode_policy.workspace_writable else (),
                denied_read_globs=DEFAULT_DENIED_READ_GLOBS,
                filesystem=mode_policy.filesystem,
                network=mode_policy.network,
                shell=mode_policy.shell,
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
    shell_environment_policy: ShellEnvironmentPolicy | None = None
    max_timeout_seconds: int = DEFAULT_SHELL_TIMEOUT_SECONDS
    output_char_limit: int = DEFAULT_SHELL_OUTPUT_CHAR_LIMIT
    backend: ShellBackendProfile = ShellBackendProfile()

    @classmethod
    def from_policy(
        cls,
        policy: ExecutionPolicy,
        *,
        shell_environment_policy: ShellEnvironmentPolicy | None = None,
    ) -> "ShellExecutionOptions":
        return cls(
            workspace_root=policy.sandbox.cwd,
            filesystem=policy.sandbox.filesystem,
            network=policy.sandbox.network,
            shell=policy.sandbox.shell,
            shell_environment_policy=shell_environment_policy,
        )

    def resolved_shell_environment_policy(self) -> ShellEnvironmentPolicy:
        if self.shell_environment_policy is not None:
            return self.shell_environment_policy
        if self.env_policy == "inherit":
            return ShellEnvironmentPolicy.inherit_all()
        return ShellEnvironmentPolicy.sanitized(workspace_root=self.workspace_root)

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
            "shell_environment_policy": self.resolved_shell_environment_policy().to_trace_payload(),
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
class ToolRuntimeCoverageProfile:
    lane: str
    owner: str
    lifecycle: ToolRuntimeCoverageLevel
    effect_profile: ToolRuntimeCoverageLevel
    sandbox: ToolRuntimeCoverageLevel
    execpolicy: ToolRuntimeCoverageLevel
    approval: ToolRuntimeCoverageLevel
    hooks: ToolRuntimeCoverageLevel
    background: ToolRuntimeCoverageLevel
    cancellation: ToolRuntimeCoverageLevel
    diagnostics: ToolRuntimeCoverageLevel
    known_gap: str | None = None

    @property
    def is_full_runtime_lane(self) -> bool:
        return all(
            value == "full"
            for value in (
                self.lifecycle,
                self.effect_profile,
                self.sandbox,
                self.approval,
                self.diagnostics,
            )
        )

    @property
    def is_partial_runtime_lane(self) -> bool:
        return not self.is_full_runtime_lane

    def to_diagnostic_payload(self) -> dict[str, object]:
        return {
            "lane": self.lane,
            "owner": self.owner,
            "lifecycle": self.lifecycle,
            "effect_profile": self.effect_profile,
            "sandbox": self.sandbox,
            "execpolicy": self.execpolicy,
            "approval": self.approval,
            "hooks": self.hooks,
            "background": self.background,
            "cancellation": self.cancellation,
            "diagnostics": self.diagnostics,
            "known_gap": self.known_gap,
        }


DEFAULT_TOOL_RUNTIME_COVERAGE: tuple[ToolRuntimeCoverageProfile, ...] = (
    ToolRuntimeCoverageProfile(
        lane="builtin_tool",
        owner="tool_execution_service",
        lifecycle="full",
        effect_profile="full",
        sandbox="full",
        execpolicy="partial",
        approval="full",
        hooks="full",
        background="external",
        cancellation="partial",
        diagnostics="full",
        known_gap="generic_cancel_collect_not_unified",
    ),
    ToolRuntimeCoverageProfile(
        lane="shell_foreground",
        owner="tool_execution_service",
        lifecycle="full",
        effect_profile="full",
        sandbox="full",
        execpolicy="full",
        approval="full",
        hooks="full",
        background="external",
        cancellation="full",
        diagnostics="full",
    ),
    ToolRuntimeCoverageProfile(
        lane="shell_background",
        owner="shell_registry",
        lifecycle="partial",
        effect_profile="full",
        sandbox="full",
        execpolicy="full",
        approval="full",
        hooks="full",
        background="full",
        cancellation="full",
        diagnostics="full",
        known_gap="background_collect_protocol_is_shell_specific",
    ),
    ToolRuntimeCoverageProfile(
        lane="mcp_tool",
        owner="tool_execution_service",
        lifecycle="full",
        effect_profile="full",
        sandbox="full",
        execpolicy="partial",
        approval="full",
        hooks="full",
        background="external",
        cancellation="partial",
        diagnostics="full",
        known_gap="remote_effect_precision_is_conservative",
    ),
    ToolRuntimeCoverageProfile(
        lane="plugin_tool",
        owner="tool_execution_service",
        lifecycle="full",
        effect_profile="partial",
        sandbox="full",
        execpolicy="partial",
        approval="full",
        hooks="full",
        background="external",
        cancellation="partial",
        diagnostics="full",
        known_gap="plugin_effects_default_to_none_unless_declared",
    ),
    ToolRuntimeCoverageProfile(
        lane="hook_execution",
        owner="hook_manager",
        lifecycle="partial",
        effect_profile="partial",
        sandbox="partial",
        execpolicy="external",
        approval="external",
        hooks="external",
        background="external",
        cancellation="partial",
        diagnostics="full",
        known_gap="hook_is_runtime_sidecar_not_first_class_tool",
    ),
    ToolRuntimeCoverageProfile(
        lane="subagent_job",
        owner="subagent_service",
        lifecycle="partial",
        effect_profile="partial",
        sandbox="partial",
        execpolicy="external",
        approval="external",
        hooks="external",
        background="full",
        cancellation="partial",
        diagnostics="full",
        known_gap="delegated_actions_are_not_single_tool_runtime_lane",
    ),
    ToolRuntimeCoverageProfile(
        lane="skill_activation",
        owner="skill_tool",
        lifecycle="full",
        effect_profile="full",
        sandbox="full",
        execpolicy="external",
        approval="full",
        hooks="full",
        background="external",
        cancellation="external",
        diagnostics="full",
        known_gap="activation_replay_is_context_not_background_job",
    ),
    ToolRuntimeCoverageProfile(
        lane="background_job_control",
        owner="background_job_registry",
        lifecycle="partial",
        effect_profile="partial",
        sandbox="partial",
        execpolicy="external",
        approval="external",
        hooks="external",
        background="full",
        cancellation="partial",
        diagnostics="full",
        known_gap="observe_cancel_collect_contract_not_global_for_all_tools",
    ),
)


def tool_runtime_coverage_profiles() -> tuple[ToolRuntimeCoverageProfile, ...]:
    return DEFAULT_TOOL_RUNTIME_COVERAGE


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
    writable_roots: tuple[Path, ...] = ()
    denied_read_roots: tuple[Path, ...] = ()
    denied_read_globs: tuple[str, ...] = ()

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
            writable_roots=policy.sandbox.writable_roots,
            denied_read_roots=policy.sandbox.denied_read_roots,
            denied_read_globs=policy.sandbox.denied_read_globs,
        )

    def to_metadata(self) -> dict[str, object]:
        return {
            "workspace_root": str(self.workspace_root),
            "writable_roots": [str(path) for path in self.writable_roots],
            "denied_read_roots": [str(path) for path in self.denied_read_roots],
            "denied_read_globs": list(self.denied_read_globs),
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
        if (
            self.policy == "collaboration_mode"
            and self.reason_code == "plan_mode_blocks_mutating_tool"
        ):
            payload["collaboration_mode"] = "plan"
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
