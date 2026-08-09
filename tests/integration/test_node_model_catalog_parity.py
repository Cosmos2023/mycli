from __future__ import annotations

import json
from pathlib import Path
import subprocess

from mycli.domain.providers import ProtocolId, ProviderId
from mycli.domain.runtime import AgentConfig
from mycli.services.model_catalog import ModelCatalogService


ROOT = Path(__file__).parents[2]
NODE_HELPER = ROOT / "tests" / "integration" / "node_model_catalog_parity_helper.ts"


def test_python_and_node_load_the_same_user_model_catalog(tmp_path: Path) -> None:
    home = tmp_path / "home"
    workspace = tmp_path / "workspace"
    registry = home / ".mycli" / "models.json"
    registry.parent.mkdir(parents=True)
    workspace.mkdir()
    registry.write_text(
        json.dumps(
            {
                "models": [
                    {
                        "model": "qwen-custom",
                        "provider": "qwen",
                        "protocol": "chat_completions",
                        "base_url": "https://qwen.example/v1",
                        "auth_ref": "qwen-team",
                        "description": "Qwen fixture",
                    },
                    {
                        "model": "gpt-current",
                        "provider": "openai",
                        "protocol": "responses",
                        "base_url": "https://models.example/v1",
                        "auth_ref": "openai-team",
                        "description": "Current fixture",
                        "reasoning_efforts": ["low", "medium", "high"],
                        "default_reasoning_effort": "medium",
                    },
                    {
                        "model": "claude-custom",
                        "provider": "anthropic",
                        "protocol": "anthropic_messages",
                        "base_url": "https://anthropic.example",
                        "auth_ref": "anthropic-team",
                        "name": "Claude Custom",
                    },
                ]
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    config = AgentConfig(
        workspace_root=workspace,
        provider=ProviderId.OPENAI,
        protocol=ProtocolId.RESPONSES,
        model="gpt-current",
        api_base_url="https://models.example/v1",
        auth_ref="openai-team",
    )
    python_payload = [
        entry.to_payload()
        for entry in ModelCatalogService(home_dir=home).list_models(
            current_config=config
        )
    ]
    current_payload = {
        "provider": config.provider.value,
        "protocol": config.protocol.value,
        "model": config.model,
        "apiBaseUrl": config.api_base_url,
        "authRef": config.auth_ref,
    }
    completed = subprocess.run(
        [
            "node",
            "--import",
            "tsx",
            str(NODE_HELPER),
            str(home),
            json.dumps(current_payload),
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    node_payload = json.loads(completed.stdout)

    assert node_payload == python_payload
    assert node_payload[0]["model"] == "gpt-current"
    assert all("auth_ref" not in entry for entry in node_payload)
