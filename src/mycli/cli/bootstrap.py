from __future__ import annotations

import os
from pathlib import Path
import re
from typing import cast

from mycli.application.runtime import AgentRuntime
from mycli.application.turn_service import TurnService
from mycli.config.settings import resolve_config
from mycli.domain.providers import ProtocolId
from mycli.infrastructure.providers import chat_adapter_for_provider
from mycli.llms.adapters.anthropic_messages_adapter import AnthropicMessagesModelAdapter
from mycli.llms.adapters.base import ModelAdapter
from mycli.llms.adapters.native_tool_adapter import NativeToolModelAdapter
from mycli.llms.adapters.responses_adapter import ResponsesModelAdapter
from mycli.llms.clients.anthropic_messages import AnthropicMessagesClient
from mycli.llms.clients.openai_chat import OpenAIChatClient
from mycli.llms.clients.openai_responses import OpenAIResponsesClient
from mycli.services.mcp import (
    McpClient,
    McpToolAdapter,
    McpToolContributionProvider,
    load_mcp_server_configs,
)
from mycli.tools.append_file import AppendFileTool
from mycli.tools.create_file import CreateFileTool
from mycli.tools.delete_path import DeletePathTool
from mycli.tools.edit_file import EditFileTool
from mycli.tools.git_diff import GitDiffTool
from mycli.tools.git_log import GitLogTool
from mycli.tools.git_status import GitStatusTool
from mycli.tools.list_directory import ListDirectoryTool
from mycli.tools.mkdir import MkdirTool
from mycli.tools.move_path import MovePathTool
from mycli.tools.plan_mode import EnterPlanModeTool, ExitPlanModeTool
from mycli.tools.read_file import ReadFileTool
from mycli.tools.read_file_range import ReadFileRangeTool
from mycli.tools.registry import ToolRegistryV2
from mycli.tools.replace_in_file import ReplaceInFileTool
from mycli.tools.run_shell import RunShellTool
from mycli.tools.search_text import SearchTextTool
from mycli.tools.update_plan import UpdatePlanTool
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
    config = resolve_config(cli_args=cli_args, env=env_vars, cwd=workspace_root, home=home_dir)
    if not config.api_key:
        raise RuntimeError("MYCLI_API_KEY is required")
    workspace_log_service = WorkspaceLogService(
        workspace_root=workspace_root,
        logs_root=_build_runtime_logs_root(home_dir=home_dir, session_id=config.session_id),
    )

    model_adapter: ModelAdapter
    provider_adapter = chat_adapter_for_provider(config.provider)
    if config.protocol is ProtocolId.ANTHROPIC_MESSAGES:
        anthropic_client = AnthropicMessagesClient(
            api_key=config.api_key,
            base_url=config.api_base_url,
            model=config.model,
            max_output_tokens=config.max_output_tokens,
            log_service=workspace_log_service,
        )
        model_adapter = cast(
            ModelAdapter,
            AnthropicMessagesModelAdapter(client=anthropic_client),
        )
    elif config.protocol is ProtocolId.CHAT_COMPLETIONS:
        chat_client = OpenAIChatClient(
            api_key=config.api_key,
            base_url=config.api_base_url,
            model=config.model,
            max_output_tokens=config.max_output_tokens,
            log_service=workspace_log_service,
            provider_adapter=provider_adapter,
        )
        model_adapter = cast(
            ModelAdapter,
            NativeToolModelAdapter(
                client=chat_client,
                provider_adapter=provider_adapter,
            ),
        )
    else:
        responses_client = OpenAIResponsesClient(
            api_key=config.api_key,
            base_url=config.api_base_url,
            model=config.model,
            max_output_tokens=config.max_output_tokens,
            log_service=workspace_log_service,
        )
        model_adapter = cast(
            ModelAdapter,
            ResponsesModelAdapter(
                client=responses_client,
                log_service=workspace_log_service,
            ),
        )
    tool_registry = ToolRegistryV2.from_tools(
        [
            CreateFileTool(workspace_root),
            MkdirTool(workspace_root),
            MovePathTool(workspace_root),
            DeletePathTool(workspace_root),
            ListDirectoryTool(workspace_root),
            ReadFileTool(workspace_root),
            ReadFileRangeTool(workspace_root),
            SearchTextTool(workspace_root),
            GitStatusTool(workspace_root),
            GitDiffTool(workspace_root),
            GitLogTool(workspace_root),
            AppendFileTool(workspace_root),
            ReplaceInFileTool(workspace_root),
            EditFileTool(workspace_root),
            RunShellTool(workspace_root),
            UpdatePlanTool(),
            EnterPlanModeTool(workspace_root),
            ExitPlanModeTool(workspace_root),
        ]
    )
    contributed_tool_providers = _build_mcp_tool_providers(
        workspace_root,
        env=env_vars,
    )
    runtime = AgentRuntime(
        model_adapter=model_adapter,
        tool_registry=tool_registry,
        config=config,
        home_dir=home_dir,
        workspace_log_service=workspace_log_service,
        contributed_tool_providers=contributed_tool_providers,
    )
    return TurnService(
        runtime=runtime,
        config=config,
        home_dir=home_dir,
    )


def _build_runtime_logs_root(*, home_dir: Path, session_id: str) -> Path:
    safe_session_id = re.sub(r"[^A-Za-z0-9._-]+", "-", session_id).strip("-") or "default"
    return home_dir / ".mycli" / "logs" / safe_session_id


def _build_mcp_tool_providers(
    workspace_root: Path,
    *,
    env: dict[str, str] | None = None,
) -> tuple[McpToolContributionProvider, ...]:
    configs = {
        name: config
        for name, config in load_mcp_server_configs(workspace_root, environ=env).items()
        if config.enabled
    }
    if not configs:
        return ()
    clients = {name: McpClient(config) for name, config in configs.items()}
    return (McpToolContributionProvider(McpToolAdapter(clients)),)
