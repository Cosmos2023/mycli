from __future__ import annotations

import os
from pathlib import Path

from mycli.application.runtime import AgentRuntime
from mycli.application.runtime.tools import ToolContributionProvider
from mycli.application.turn_service import TurnService
from mycli.config.settings import resolve_config
from mycli.domain.runtime import SandboxMode
from mycli.llms.model_adapter_factory import build_model_adapter
from mycli.services.storage_layout import MycliStorageLayout
from mycli.memory.memdir import ensure_memory_dir, memory_dir_for
from mycli.services.mcp import (
    McpClient,
    McpToolAdapter,
    McpToolContributionProvider,
    load_mcp_server_configs,
)
from mycli.services.skills import SkillRegistry
from mycli.tools.registry import ToolRegistry, default_tools
from mycli.utils.workspace_logger import WorkspaceLogService


def build_turn_service(
    cli_args: dict[str, object],
    cwd: Path | None = None,
    home: Path | None = None,
    env: dict[str, str] | None = None,
) -> TurnService:
    workspace_root = cwd or Path.cwd()
    home_dir = home or Path.home()
    env_vars = env or dict(os.environ)
    try:
        config = resolve_config(
            cli_args=cli_args,
            env=env_vars,
            cwd=workspace_root,
            home=home_dir,
        )
    except (OSError, ValueError) as exc:
        raise RuntimeError(f"Invalid mycli configuration: {exc}") from exc
    if not config.api_key:
        raise RuntimeError("MYCLI_API_KEY is required")
    workspace_log_service = WorkspaceLogService(
        workspace_root=workspace_root,
        logs_root=_build_runtime_logs_root(home_dir=home_dir),
        session_id=config.session_id,
    )

    model_adapter = build_model_adapter(config, log_service=workspace_log_service)
    memory_dir = memory_dir_for(home_dir, workspace_root)
    ensure_memory_dir(memory_dir)
    task_output_dir = MycliStorageLayout.from_home_dir(home_dir).task_output_dir(
        config.session_id
    )
    allowed_roots = (memory_dir, task_output_dir)
    tool_registry = ToolRegistry.from_tools(
        default_tools(
            workspace_root,
            allowed_roots=allowed_roots,
            unrestricted_filesystem=(
                config.sandbox_mode == SandboxMode.DANGER_FULL_ACCESS
            ),
            include_task=False,
        )
    )
    skill_registry = SkillRegistry(
        builtin_root=Path(__file__).resolve().parents[1] / "prompts" / "skills",
        user_root=home_dir / ".mycli" / "skills",
        shared_repo_root=workspace_root / ".agents" / "skills",
        repo_root=workspace_root / ".mycli" / "skills",
    )
    contributed_tool_providers: tuple[ToolContributionProvider, ...] = (
        *_build_mcp_tool_providers(
            workspace_root,
            home_dir=home_dir,
            env=env_vars,
        ),
    )
    runtime = AgentRuntime(
        model_adapter=model_adapter,
        tool_registry=tool_registry,
        config=config,
        home_dir=home_dir,
        skill_registry=skill_registry,
        workspace_log_service=workspace_log_service,
        contributed_tool_providers=contributed_tool_providers,
    )
    return TurnService(
        runtime=runtime,
        config=config,
        home_dir=home_dir,
        model_adapter_factory=lambda next_config: build_model_adapter(
            next_config,
            log_service=workspace_log_service,
        ),
    )


def _build_runtime_logs_root(*, home_dir: Path) -> Path:
    return MycliStorageLayout.from_home_dir(home_dir).logs_dir


def _build_mcp_tool_providers(
    workspace_root: Path,
    *,
    home_dir: Path,
    env: dict[str, str] | None = None,
) -> tuple[McpToolContributionProvider, ...]:
    configs = {
        name: config
        for name, config in load_mcp_server_configs(
            workspace_root,
            home_dir=home_dir,
            environ=env,
        ).items()
        if config.enabled
    }
    if not configs:
        return ()
    clients = {
        name: McpClient(config, cwd=workspace_root)
        for name, config in configs.items()
    }
    return (McpToolContributionProvider(McpToolAdapter(clients)),)
