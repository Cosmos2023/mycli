from __future__ import annotations

from fnmatch import fnmatch
from pathlib import Path
import shlex

from mycli.domain.runtime import (
    CollaborationMode,
    ExecPolicyRuleSet,
    ExecutionPolicy,
    SandboxMode,
    SandboxProfile,
    ShellEnvironmentPolicy,
    ShellExecutionOptions,
    ShellProfile,
    ToolRuntimeDecision,
    ToolRuntimeEffect,
)
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.exposure import ToolExposure, ToolRouteSource
from mycli.services.approval import ApprovalService
from mycli.tools.base import ToolEffectProfile


SHELL_TOOL_NAMES = frozenset({"Shell", "Bash", "run_shell"})
READ_TOOL_NAMES = frozenset(
    {"Read", "read_file", "read_file_range", "LS", "list_directory", "Grep", "search_text"}
)


class RuntimePolicyGate:
    """Projects existing approval/safety policy into the runtime contract."""

    def __init__(
        self,
        *,
        approval_service: ApprovalService,
        workspace_root: Path | None = None,
        writable_roots: tuple[Path, ...] = (),
        denied_read_roots: tuple[Path, ...] = (),
        denied_read_globs: tuple[str, ...] = (),
        execpolicy_rules: ExecPolicyRuleSet | None = None,
        collaboration_mode: CollaborationMode = CollaborationMode.DEFAULT,
        sandbox_mode: SandboxMode = SandboxMode.WORKSPACE_WRITE,
        shell_path: str | None = None,
        shell_profile: ShellProfile | None = None,
        shell_environment_policy: ShellEnvironmentPolicy | None = None,
    ) -> None:
        self._approval_service = approval_service
        self._workspace_root = workspace_root
        self._writable_roots = tuple(path.resolve() for path in writable_roots)
        self._denied_read_roots = tuple(path.resolve() for path in denied_read_roots)
        self._denied_read_globs = tuple(denied_read_globs)
        self._execpolicy_rules = execpolicy_rules or ExecPolicyRuleSet()
        self._collaboration_mode = collaboration_mode
        self._sandbox_mode = sandbox_mode
        self._shell_path = shell_path
        self._shell_profile = shell_profile
        self._shell_environment_policy = shell_environment_policy

    def default_policy(self) -> ExecutionPolicy:
        root = self._workspace_root or Path.cwd()
        policy = ExecutionPolicy.for_workspace(root, sandbox_mode=self._sandbox_mode)
        writable_roots = (
            tuple(
                dict.fromkeys(
                    (
                        *policy.sandbox.writable_roots,
                        *self._writable_roots,
                    )
                )
            )
            if policy.sandbox.filesystem != "read_only"
            else ()
        )
        return ExecutionPolicy(
            sandbox=SandboxProfile(
                workspace_roots=policy.sandbox.workspace_roots,
                cwd=policy.sandbox.cwd,
                mode=policy.sandbox.mode,
                writable_roots=writable_roots,
                denied_read_roots=tuple(
                    dict.fromkeys(
                        (
                            *policy.sandbox.denied_read_roots,
                            *self._denied_read_roots,
                        )
                    )
                ),
                denied_read_globs=tuple(
                    dict.fromkeys(
                        (
                            *policy.sandbox.denied_read_globs,
                            *self._denied_read_globs,
                        )
                    )
                ),
                filesystem=policy.sandbox.filesystem,
                network=policy.sandbox.network,
                shell=policy.sandbox.shell,
            ),
            approval_policy=policy.approval_policy,
            command_policy=policy.command_policy,
            file_policy=policy.file_policy,
            tool_policy=policy.tool_policy,
        )

    def set_workspace_policy(
        self,
        *,
        workspace_root: Path,
        execpolicy_rules: ExecPolicyRuleSet,
        writable_roots: tuple[Path, ...] = (),
        denied_read_roots: tuple[Path, ...] = (),
        denied_read_globs: tuple[str, ...] = (),
        collaboration_mode: CollaborationMode | None = None,
        sandbox_mode: SandboxMode | None = None,
        shell_environment_policy: ShellEnvironmentPolicy | None = None,
    ) -> None:
        self._workspace_root = workspace_root
        self._writable_roots = tuple(path.resolve() for path in writable_roots)
        self._denied_read_roots = tuple(path.resolve() for path in denied_read_roots)
        self._denied_read_globs = tuple(denied_read_globs)
        self._execpolicy_rules = execpolicy_rules
        if collaboration_mode is not None:
            self._collaboration_mode = collaboration_mode
        if sandbox_mode is not None:
            self._sandbox_mode = sandbox_mode
        self._shell_environment_policy = shell_environment_policy

    def decide(
        self,
        call: ToolCall,
        policy: ExecutionPolicy | None = None,
        *,
        tool_exposure: ToolExposure | None = None,
        effect_profile: ToolEffectProfile | ToolRuntimeEffect | None = None,
    ) -> ToolRuntimeDecision:
        resolved_policy = policy or self.default_policy()
        runtime_effect = _runtime_effect(effect_profile)
        collaboration_decision = self._collaboration_mode_decision(
            call=call,
            sandbox=resolved_policy.sandbox,
            effect=runtime_effect,
        )
        if collaboration_decision is not None:
            return collaboration_decision
        sandbox_decision = self._sandbox_decision(
            call=call,
            sandbox=resolved_policy.sandbox,
            effect=runtime_effect,
        )
        if sandbox_decision is not None:
            return sandbox_decision
        execpolicy_decision = self._execpolicy_decision(
            call=call,
            sandbox=resolved_policy.sandbox,
            effect=runtime_effect,
        )
        if execpolicy_decision is not None:
            return execpolicy_decision
        if self._is_contributed_tool(call, tool_exposure):
            return ToolRuntimeDecision.allowed(
                tool_call=call,
                policy="contributed_tool_exposure",
                risk_level="low",
                sandbox=resolved_policy.sandbox,
                effect=runtime_effect,
            )

        outcome = self._approval_service.evaluate(call)
        metadata = outcome.safety_metadata or {}
        policy_name = _metadata_string(metadata.get("policy")) or resolved_policy.approval_policy
        risk_level = _metadata_string(metadata.get("risk_level"))
        decision_kind = _metadata_string(metadata.get("decision_kind"))
        if outcome.denied_reason is not None:
            return ToolRuntimeDecision.denied(
                tool_call=call,
                policy=policy_name,
                risk_level=risk_level,
                reason_code=decision_kind or "deny",
                sandbox=resolved_policy.sandbox,
                effect=runtime_effect,
            )
        if outcome.pending_approval is not None:
            return ToolRuntimeDecision.needs_approval(
                tool_call=call,
                policy=policy_name,
                risk_level=risk_level,
                reason_code=decision_kind or "needs_choice",
                pending_approval=outcome.pending_approval,
                sandbox=resolved_policy.sandbox,
                effect=runtime_effect,
            )
        return ToolRuntimeDecision.allowed(
            tool_call=call,
            policy=policy_name,
            risk_level=risk_level,
            sandbox=resolved_policy.sandbox,
            effect=runtime_effect,
        )

    def decide_execpolicy(
        self,
        call: ToolCall,
        policy: ExecutionPolicy | None = None,
        *,
        effect_profile: ToolEffectProfile | ToolRuntimeEffect | None = None,
    ) -> ToolRuntimeDecision | None:
        resolved_policy = policy or self.default_policy()
        return self._execpolicy_decision(
            call=call,
            sandbox=resolved_policy.sandbox,
            effect=_runtime_effect(effect_profile),
        )

    def shell_execution_options(
        self,
        policy: ExecutionPolicy | None = None,
    ) -> ShellExecutionOptions:
        return ShellExecutionOptions.from_policy(
            policy or self.default_policy(),
            shell_path=self._shell_path,
            shell_profile=self._shell_profile,
            shell_environment_policy=self._shell_environment_policy,
        )

    def set_shell_profile(
        self,
        shell_profile: ShellProfile,
        *,
        shell_path: str | None = None,
    ) -> None:
        self._shell_profile = shell_profile
        self._shell_path = shell_path

    def _execpolicy_decision(
        self,
        *,
        call: ToolCall,
        sandbox: SandboxProfile,
        effect: ToolRuntimeEffect | None,
    ) -> ToolRuntimeDecision | None:
        if call.name not in SHELL_TOOL_NAMES:
            return None
        command_args = _shell_command_args(call)
        if not command_args:
            return None
        match = self._execpolicy_rules.match(command_args)
        if match is None:
            return None
        return ToolRuntimeDecision.from_execpolicy_match(
            tool_call=call,
            match=match,
            sandbox=sandbox,
            effect=effect,
        )

    def _sandbox_decision(
        self,
        *,
        call: ToolCall,
        sandbox: SandboxProfile,
        effect: ToolRuntimeEffect | None,
    ) -> ToolRuntimeDecision | None:
        if effect is None:
            return None
        denied_read = _denied_read_reason(call=call, sandbox=sandbox, effect=effect)
        if denied_read is not None:
            return ToolRuntimeDecision.denied(
                tool_call=call,
                policy="sandbox_denied_read_policy",
                risk_level="medium",
                reason_code=denied_read,
                sandbox=sandbox,
                effect=effect,
            )
        if sandbox.filesystem == "read_only" and effect.filesystem in {"write", "unknown"}:
            return ToolRuntimeDecision.denied(
                tool_call=call,
                policy="sandbox_filesystem_policy",
                risk_level="high" if effect.filesystem == "write" else "medium",
                reason_code=f"filesystem_{effect.filesystem}_blocked_by_read_only",
                sandbox=sandbox,
                effect=effect,
            )
        if sandbox.shell == "disabled" and call.name in SHELL_TOOL_NAMES:
            return ToolRuntimeDecision.denied(
                tool_call=call,
                policy="sandbox_shell_policy",
                risk_level="high",
                reason_code="shell_disabled",
                sandbox=sandbox,
                effect=effect,
            )
        if sandbox.network == "disabled" and effect.network:
            return ToolRuntimeDecision.denied(
                tool_call=call,
                policy="sandbox_network_policy",
                risk_level="medium",
                reason_code="network_disabled",
                sandbox=sandbox,
                effect=effect,
            )
        return None

    @staticmethod
    def _is_contributed_tool(
        call: ToolCall,
        tool_exposure: ToolExposure | None,
    ) -> bool:
        if tool_exposure is None:
            return False
        for entry in tool_exposure.entries:
            if entry.name != call.name:
                continue
            return entry.source in {ToolRouteSource.RUNTIME, ToolRouteSource.PROVIDER}
        return False

    def _collaboration_mode_decision(
        self,
        *,
        call: ToolCall,
        sandbox: SandboxProfile,
        effect: ToolRuntimeEffect | None,
    ) -> ToolRuntimeDecision | None:
        if self._collaboration_mode is not CollaborationMode.PLAN:
            return None
        if effect is None:
            return None
        if (
            effect.filesystem in {"write", "unknown"}
            or effect.network
            or effect.process
            or call.name in SHELL_TOOL_NAMES
        ):
            return ToolRuntimeDecision.denied(
                tool_call=call,
                policy="collaboration_mode",
                risk_level="medium",
                reason_code="plan_mode_blocks_mutating_tool",
                sandbox=sandbox,
                effect=effect,
            )
        return None


def _metadata_string(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _shell_command_args(call: ToolCall) -> tuple[str, ...]:
    args_value = call.arguments.get("args")
    if isinstance(args_value, list) and args_value and all(
        isinstance(item, str) for item in args_value
    ):
        return tuple(args_value)
    command_value = call.arguments.get("command")
    if not isinstance(command_value, str) or not command_value:
        return ()
    try:
        return tuple(shlex.split(command_value))
    except ValueError:
        return ()


def _denied_read_reason(
    *,
    call: ToolCall,
    sandbox: SandboxProfile,
    effect: ToolRuntimeEffect,
) -> str | None:
    if effect.filesystem != "read" and call.name not in READ_TOOL_NAMES:
        return None
    for candidate in _read_path_candidates(call):
        if _matches_denied_read_root(candidate, sandbox.denied_read_roots, cwd=sandbox.cwd):
            return "denied_read_root"
        if _matches_denied_read_glob(candidate, sandbox.denied_read_globs):
            return "denied_read_glob"
    return None


def _read_path_candidates(call: ToolCall) -> tuple[str, ...]:
    candidates: list[str] = []
    for key in ("file_path", "path", "target", "source"):
        value = call.arguments.get(key)
        if isinstance(value, str) and value:
            candidates.append(value)
    include = call.arguments.get("include")
    if isinstance(include, str) and include:
        candidates.append(include)
    return tuple(dict.fromkeys(candidates))


def _matches_denied_read_root(
    candidate: str,
    denied_roots: tuple[Path, ...],
    *,
    cwd: Path,
) -> bool:
    if not denied_roots:
        return False
    try:
        raw_path = Path(candidate).expanduser()
        resolved = raw_path.resolve() if raw_path.is_absolute() else (cwd / raw_path).resolve()
    except (OSError, RuntimeError):
        return False
    for root in denied_roots:
        try:
            resolved.relative_to(root)
        except ValueError:
            continue
        return True
    return False


def _matches_denied_read_glob(candidate: str, denied_globs: tuple[str, ...]) -> bool:
    normalized = candidate.replace("\\", "/")
    basename = normalized.rsplit("/", 1)[-1]
    return any(
        fnmatch(normalized, pattern)
        or fnmatch(basename, pattern)
        or (pattern.startswith("**/") and fnmatch(normalized, pattern[3:]))
        or (pattern.startswith("**/") and fnmatch(basename, pattern[3:]))
        for pattern in denied_globs
    )


def _runtime_effect(
    effect_profile: ToolEffectProfile | ToolRuntimeEffect | None,
) -> ToolRuntimeEffect | None:
    if effect_profile is None:
        return None
    if isinstance(effect_profile, ToolRuntimeEffect):
        return effect_profile
    filesystem = effect_profile.filesystem
    if filesystem not in {"none", "read", "write", "unknown"}:
        filesystem = "unknown"
    return ToolRuntimeEffect(
        filesystem=filesystem,
        network=effect_profile.network,
        process=effect_profile.process,
    )
