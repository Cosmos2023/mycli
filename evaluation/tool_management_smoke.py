from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path
import tempfile
from typing import Any, cast

from mycli.application.turn_service import TurnService
from mycli.cli.slash_command_dispatch import dispatch_backend_slash_command
from mycli.cli.slash_command_registry import (
    SlashCommandContext,
    SlashCommandSurface,
    resolve_slash_command,
)
from mycli.domain.conversation import Conversation
from mycli.domain.runtime import AgentConfig, PlanState
from mycli.domain.subagents import SubAgentResult
from mycli.services.extensions import ExtensionManifestService
from mycli.services.subagents import SubAgentToolContributionProvider
from mycli.tools.registry import ToolRegistry


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNS_ROOT = REPO_ROOT / "evaluation" / "runs"


class FakeRuntime:
    def __init__(self, workspace_root: Path) -> None:
        self._config = AgentConfig(workspace_root=workspace_root, session_id="tool-management-smoke")
        self._tool_registry = ToolRegistry(workspace_root=workspace_root)
        self._extension_manifest_service = ExtensionManifestService(
            tool_registry=self._tool_registry,
            contributed_tools=SubAgentToolContributionProvider(self).provide(
                user_message="",
                conversation=Conversation(session_id="tool-management-smoke"),
                plan_state=PlanState(),
            ),
        )

    def run_task(
        self,
        *,
        description: str,
        agent_type: str,
        allowed_tools: tuple[str, ...],
        mode: str = "sync",
    ) -> SubAgentResult:
        del description, allowed_tools, mode
        return SubAgentResult(
            status="completed",
            report="ok",
            child_session_id=f"tool-management-smoke:sub:turn_1:{agent_type}",
            tool_calls=0,
        )

    def extension_manifest(self) -> dict[str, object]:
        return self._extension_manifest_service.manifest()


def _dispatch_cli_command(service: TurnService, command: str) -> tuple[str, ...]:
    context = SlashCommandContext(surface=SlashCommandSurface.CLI)
    invocation = resolve_slash_command(command, context)
    return dispatch_backend_slash_command(service, invocation).lines


def main() -> int:
    report: dict[str, object] = {
        "run_id": f"tool-management-smoke-{datetime.now(tz=UTC).strftime('%Y%m%dT%H%M%SZ')}",
        "created_at": datetime.now(tz=UTC).isoformat(),
    }
    with tempfile.TemporaryDirectory(prefix="mycli-tool-management-smoke-") as tmp:
        root = Path(tmp)
        workspace = root / "workspace"
        home = root / "home"
        workspace.mkdir()
        home.mkdir()
        runtime = FakeRuntime(workspace)
        service = TurnService(config=runtime._config, home_dir=home, runtime=runtime)
        manifest = service.extension_manifest()
        tool_manifest = cast(dict[str, Any], manifest["tool_manifest"])
        toolset_manifest = cast(dict[str, Any], manifest["toolset_manifest"])
        tools = {
            str(tool["name"]): tool
            for tool in cast(list[dict[str, Any]], tool_manifest["tools"])
        }
        toolsets = {
            str(toolset["id"]): toolset
            for toolset in cast(list[dict[str, Any]], toolset_manifest["toolsets"])
        }
        slash_tools = _dispatch_cli_command(service, "/tools")
        slash_toolsets = _dispatch_cli_command(service, "/toolsets")
        success = (
            tools["Read"]["source"] == "builtin"
            and tools["subagent_explore"]["source"] == "subagent"
            and tools["subagent_explore"]["toolset"] == "external"
            and "subagent_explore" in toolsets["external"]["tools"]
            and any(line.startswith("Read  builtin  file") for line in slash_tools)
            and any(line.startswith("Subagent explore  subagent  external") for line in slash_tools)
            and any("Read  builtin  file  low  available  auto_allow" in line for line in slash_tools)
            and any(line.startswith("External  true  subagent") for line in slash_toolsets)
            and any("subagent_explore" in line for line in slash_toolsets)
        )
        checks: dict[str, object] = {
            "builtin_source": tools["Read"]["source"],
            "subagent_source": tools["subagent_explore"]["source"],
            "external_tools": list(cast(list[str], toolsets["external"]["tools"])),
            "slash_tools_preview": slash_tools[:5],
            "slash_toolsets": slash_toolsets,
        }
        report.update(
            {
                "success": success,
                "checks": checks,
            }
        )

    RUNS_ROOT.mkdir(parents=True, exist_ok=True)
    output_path = RUNS_ROOT / f"{report['run_id']}.json"
    output_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    print(output_path)
    return 0 if report["success"] else 1
if __name__ == "__main__":
    raise SystemExit(main())
