from __future__ import annotations

import os
from pathlib import Path
from typing import cast

from mycli.application.runtime import AgentRuntime
from mycli.application.runtime.tools import ToolContributionProvider
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
from mycli.services.storage_layout import MycliStorageLayout
from mycli.services.filesystem import FileSystemRuntime
from mycli.memory.memdir import ensure_memory_dir, memory_dir_for
from mycli.services.mcp import (
    McpClient,
    McpToolAdapter,
    McpToolContributionProvider,
    load_mcp_server_configs,
)
from mycli.services.skills import SkillRegistry
from mycli.tools.ask_user_question import AskUserQuestionTool
from mycli.tools.bash import BashTool
from mycli.tools.bash_output import BashOutputTool
from mycli.tools.edit import EditTool
from mycli.tools.git_tools import GitDiffTool, GitLogTool, GitShowTool, GitStatusTool
from mycli.tools.glob import GlobTool
from mycli.tools.grep import GrepTool
from mycli.tools.kill_shell import KillShellTool
from mycli.tools.lint import LintTool
from mycli.tools.ls import LSTool
from mycli.tools.patch import PatchTool
from mycli.tools.plan import PlanTool
from mycli.tools.plan_mode import EnterPlanModeTool, ExitPlanModeTool
from mycli.tools.read import ReadTool
from mycli.tools.registry import ToolRegistry
from mycli.tools.subagent_output import SubagentOutputTool
from mycli.tools.web_fetch import WebFetchTool
from mycli.tools.web_search import WebSearchTool
from mycli.tools.write import WriteTool
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
        logs_root=_build_runtime_logs_root(home_dir=home_dir),
        session_id=config.session_id,
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
    memory_dir = memory_dir_for(home_dir, workspace_root)
    ensure_memory_dir(memory_dir)
    allowed_roots = (memory_dir,)
    filesystem_runtime = FileSystemRuntime(
        workspace_root=workspace_root,
        allowed_roots=allowed_roots,
    )
    tool_registry = ToolRegistry.from_tools(
        [
            ReadTool(workspace_root, filesystem_runtime=filesystem_runtime),
            EditTool(workspace_root, filesystem_runtime=filesystem_runtime),
            PatchTool(workspace_root, filesystem_runtime=filesystem_runtime),
            WriteTool(workspace_root, filesystem_runtime=filesystem_runtime),
            GrepTool(workspace_root, allowed_roots=allowed_roots),
            GlobTool(workspace_root, allowed_roots=allowed_roots),
            LSTool(workspace_root, allowed_roots=allowed_roots),
            BashTool(workspace_root),
            BashOutputTool(),
            KillShellTool(),
            WebSearchTool(),
            WebFetchTool(),
            LintTool(),
            GitStatusTool(workspace_root),
            GitDiffTool(workspace_root),
            GitLogTool(workspace_root),
            GitShowTool(workspace_root),
            AskUserQuestionTool(),
            PlanTool(),
            EnterPlanModeTool(workspace_root),
            ExitPlanModeTool(workspace_root),
            SubagentOutputTool(),
        ]
    )
    skill_registry = SkillRegistry(
        builtin_root=Path(__file__).resolve().parents[1] / "prompts" / "skills",
        user_root=home_dir / ".mycli" / "skills",
        repo_root=workspace_root / ".mycli" / "skills",
    )
    contributed_tool_providers: tuple[ToolContributionProvider, ...] = (
        *_build_mcp_tool_providers(
            workspace_root,
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
    )


def _build_runtime_logs_root(*, home_dir: Path) -> Path:
    return MycliStorageLayout.from_home_dir(home_dir).logs_dir


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
