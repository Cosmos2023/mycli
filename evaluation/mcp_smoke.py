from __future__ import annotations

from datetime import UTC, datetime
import json
from pathlib import Path
import sys
import tempfile

from mycli.services.diagnostics.doctor import DoctorService, DoctorStatus
from mycli.services.extensions import ExtensionManifestService
from mycli.services.mcp import (
    McpClient,
    McpToolAdapter,
    discover_mcp_servers,
    load_mcp_server_configs,
)


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNS_ROOT = REPO_ROOT / "evaluation" / "runs"


def main() -> int:
    report = {
        "run_id": f"mcp-smoke-{datetime.now(tz=UTC).strftime('%Y%m%dT%H%M%SZ')}",
        "created_at": datetime.now(tz=UTC).isoformat(),
    }
    with tempfile.TemporaryDirectory(prefix="mycli-mcp-smoke-") as tmp:
        workspace = Path(tmp) / "workspace"
        home = Path(tmp) / "home"
        workspace.mkdir()
        home.mkdir()
        server = workspace / "fake_mcp_server.py"
        _write_fake_mcp_server(server)
        _write_mcp_config(workspace, server)

        configs = load_mcp_server_configs(workspace)
        diagnostics = discover_mcp_servers(workspace)
        client = McpClient(configs["local"])
        try:
            adapter = McpToolAdapter({"local": client})
            stubs = adapter.list_tool_stubs()
            registrations = adapter.registrations_with_full_schema()
            call_result = registrations[0].tool.execute({"message": "hello"})
            manifest = ExtensionManifestService(contributed_tools=registrations).manifest()
        finally:
            client.close()

        doctor_report = DoctorService(
            workspace_root=workspace,
            home_dir=home,
            env={},
            which=lambda _command: sys.executable,
            import_checker=lambda _module: True,
        ).run()
        mcp_check = next(check for check in doctor_report.checks if check.name == "mcp")
        tools = {tool["name"]: tool for tool in manifest["tool_manifest"]["tools"]}
        toolsets = {toolset["id"]: toolset for toolset in manifest["toolset_manifest"]["toolsets"]}

        report.update(
            {
                "success": (
                    configs["local"].command == sys.executable
                    and diagnostics.failure_count == 0
                    and diagnostics.tool_count == 1
                    and stubs[0].descriptor.route_name == "mcp.local.echo"
                    and call_result.success
                    and call_result.summary == "echo:hello"
                    and tools["mcp.local.echo"]["source"] == "mcp"
                    and "mcp.local.echo" in toolsets["external"]["tools"]
                    and mcp_check.status is DoctorStatus.OK
                    and "1 tools discovered" in mcp_check.message
                ),
                "checks": {
                    "config_loaded": configs["local"].command == sys.executable,
                    "discovery_ok": diagnostics.failure_count == 0 and diagnostics.tool_count == 1,
                    "registration_route": stubs[0].descriptor.route_name,
                    "runtime_call_summary": call_result.summary,
                    "manifest_source": tools["mcp.local.echo"]["source"],
                    "toolset_sources": toolsets["external"]["sources"],
                    "doctor_status": mcp_check.status.value,
                    "doctor_message": mcp_check.message,
                    "doctor_detail": mcp_check.detail,
                },
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


def _write_mcp_config(workspace: Path, server: Path) -> None:
    config_dir = workspace / ".mycli"
    config_dir.mkdir()
    (config_dir / "mcp_servers.toml").write_text(
        "\n".join(
            [
                "[servers.local]",
                'transport = "stdio"',
                f'command = "{sys.executable}"',
                f'args = ["{server}"]',
                "timeout_seconds = 3",
            ]
        ),
        encoding="utf-8",
    )


def _write_fake_mcp_server(path: Path) -> None:
    path.write_text(
        r'''
from __future__ import annotations

import json
import sys


def read_message():
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if line in {b"\r\n", b"\n", b""}:
            break
        key, value = line.decode("ascii").strip().split(":", 1)
        headers[key.lower()] = value.strip()
    if not headers:
        return None
    body = sys.stdin.buffer.read(int(headers["content-length"]))
    return json.loads(body)


def write_message(payload):
    body = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii"))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


while True:
    request = read_message()
    if request is None:
        break
    method = request.get("method")
    if method == "initialize":
        result = {"protocolVersion": "2025-03-26", "serverInfo": {"name": "fake-local"}}
    elif method == "tools/list":
        result = {
            "tools": [
                {
                    "name": "echo",
                    "description": "Echo a short message",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "message": {"type": "string", "description": "Message to echo"}
                        },
                        "required": ["message"],
                    },
                }
            ]
        }
    elif method == "tools/call":
        message = request.get("params", {}).get("arguments", {}).get("message", "")
        result = {"content": [{"type": "text", "text": f"echo:{message}"}], "isError": False}
    else:
        write_message(
            {
                "jsonrpc": "2.0",
                "id": request.get("id"),
                "error": {"code": -32601, "message": "unknown method"},
            }
        )
        continue
    write_message({"jsonrpc": "2.0", "id": request.get("id"), "result": result})
'''.lstrip(),
        encoding="utf-8",
    )


if __name__ == "__main__":
    raise SystemExit(main())
