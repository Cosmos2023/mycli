from __future__ import annotations

from pathlib import Path
from time import monotonic
from typing import Callable

from mycli.domain.runtime.tracing import RuntimeTraceEvent
from mycli.services.hooks.allowlist import HookAllowlist
from mycli.services.hooks.config import HookConfigDiscovery, HookConfigRegistry
from mycli.services.hooks.manager import HookManager
from mycli.services.hooks.runner import ConfiguredHookCallback, ConfiguredHookRunSummary
from mycli.services.hooks.types import HookContext
from mycli.services.tracing import TraceService


def register_configured_hooks(
    *,
    manager: HookManager,
    workspace_root: Path,
    home_dir: Path,
    trace_service: TraceService | None,
    session_id: str,
    shell_path: str | None = None,
    monotonic_provider: Callable[[], float] = monotonic,
) -> HookConfigDiscovery:
    discovery = HookConfigRegistry(
        workspace_root=workspace_root,
        home_dir=home_dir,
        shell_path=shell_path,
    ).discover()
    allowlist = HookAllowlist(home_dir=home_dir)
    for spec in discovery.hooks:
        callback = ConfiguredHookCallback(
            spec=spec,
            workspace_root=workspace_root,
            monotonic=monotonic_provider,
            allowlist_status=allowlist.status_for,
            trace_sink=_trace_sink(
                trace_service=trace_service,
                session_id=session_id,
            ),
        )
        manager.register(spec.hook_point, callback, name=spec.name)
    return discovery


def _trace_sink(
    *,
    trace_service: TraceService | None,
    session_id: str,
) -> Callable[[HookContext, ConfiguredHookRunSummary], None] | None:
    if trace_service is None:
        return None

    def append(ctx: HookContext, summary: ConfiguredHookRunSummary) -> None:
        trace_service.append(
            session_id,
            RuntimeTraceEvent(
                kind="hook_execution",
                turn_id=str(ctx.metadata.get("turn_id") or ""),
                payload=summary.safe_payload(),
            ),
        )

    return append
